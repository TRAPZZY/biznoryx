import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { ManualEntryError, SALES_COLUMNS, assertGridLimits, monthlyPeriod, validateGrid, canonicalMonthlyCsv } from "../ingestion/manual-entry.mjs";
import { validateCustomerUploadFile, publicUpload } from "../webapp/customer-data.mjs";

// This adapter is only constructed by the non-production review runtime.
export class ReviewManualEntry {
  constructor(runtime) { this.runtime = runtime; this.drafts = new Map(); this.submissions = new Map(); }
  entries(org) { return [...this.submissions.values()].filter((entry) => entry.organizationId === org); }
  owned(map, id, org) {
    const value = map.get(id);
    if (!value || value.organizationId !== org) throw new ManualEntryError("Entry was not found.", "MANUAL_NOT_FOUND");
    return value;
  }
  schema(org, series) {
    const previous = [...this.drafts.values()].find((draft) => draft.organizationId === org && draft.dataSeries === series);
    if (previous) return previous.columns;
    const upload = [...this.runtime.uploads.values()].find((item) => item.organizationId === org && item.dataSeries === series);
    if (!upload) return SALES_COLUMNS;
    const rows = parse(upload.content, { columns: true, skip_empty_lines: true, bom: true });
    return upload.columns.map((name) => ({ name, required: true,
      type: rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row[name])) ? "date"
        : rows.every((row) => /^-?\d+(\.\d+)?$/.test(row[name])) ? "decimal" : "text" }));
  }
  load({ organizationId, draftId, submissionId }) {
    const drafts = [...this.drafts.values()].filter((entry) => entry.organizationId === organizationId && !entry.submittedAt);
    const all = this.entries(organizationId);
    const submissions = all.filter((entry) => !all.some((newer) => newer.correctionOf === entry.id));
    const names = new Set([...drafts.map((entry) => entry.dataSeries), ...submissions.map((entry) => entry.dataSeries),
      ...[...this.runtime.uploads.values()].filter((entry) => entry.organizationId === organizationId).map((entry) => entry.dataSeries)]);
    return structuredClone({ drafts, submissions, series: [...names].map((name) => ({ name, columns: this.schema(organizationId, name) })),
      template: { name: "Sales", columns: SALES_COLUMNS },
      ...(draftId ? { draft: this.owned(this.drafts, draftId, organizationId) } : {}),
      ...(submissionId ? { submission: this.owned(this.submissions, submissionId, organizationId) } : {}) });
  }
  saveDraft(input) {
    monthlyPeriod(input.period);
    if (typeof input.dataSeries !== "string" || !input.dataSeries.trim() || input.dataSeries.length > 120) throw new ManualEntryError("Enter a data series.");
    const columns = this.schema(input.organizationId, input.dataSeries);
    assertGridLimits(input.rows, input.columns);
    if (input.columns.length !== columns.length || input.columns.some((column) => !columns.some((expected) => expected.name === column.name && expected.type === column.type))) throw new ManualEntryError("Columns must match the data series.");
    const previous = input.id ? this.owned(this.drafts, input.id, input.organizationId) : null;
    if (previous && (previous.version !== input.version || previous.submittedAt)) throw new ManualEntryError("Draft has changed. Reload it before editing.", "DRAFT_VERSION_CONFLICT");
    if (previous && (previous.period !== input.period || previous.dataSeries !== input.dataSeries || previous.correctionOf !== (input.correctionOf ?? null))) throw new ManualEntryError("A saved draft cannot change its series or month.");
    if (input.correctionOf) this.owned(this.submissions, input.correctionOf, input.organizationId);
    const rows = input.rows.map((row) => columns.map((column) => row[input.columns.findIndex((item) => item.name === column.name)]));
    const draft = { ...input, id: previous?.id ?? randomUUID(), columns: structuredClone(columns), rows,
      correctionOf: input.correctionOf ?? null, version: (previous?.version ?? 0) + 1, updatedAt: new Date().toISOString(), validatedVersion: null };
    this.drafts.set(draft.id, structuredClone(draft));
    return { draft: structuredClone(draft) };
  }
  validateDraft(input) {
    const draft = this.owned(this.drafts, input.draftId, input.organizationId);
    if (draft.version !== input.version) throw new ManualEntryError("Draft has changed.", "DRAFT_VERSION_CONFLICT");
    const result = validateGrid({ ...draft, rows: draft.rows.filter((row) => row.some((cell) => cell.trim())) });
    draft.validatedVersion = result.valid ? draft.version : null;
    draft.validationId = result.valid ? draft.validationId || randomUUID() : null;
    return { valid: result.valid, issues: result.issues, rowCount: result.rowCount, validationId: draft.validationId };
  }
  async submit(input) {
    const draft = this.owned(this.drafts, input.draftId, input.organizationId);
    if (draft.version !== input.version) throw new ManualEntryError("Draft has changed.", "DRAFT_VERSION_CONFLICT");
    const retry = this.entries(input.organizationId).find((entry) => entry.draftId === draft.id);
    if (retry) return { draft: structuredClone(draft), submission: structuredClone(retry), upload: publicUpload(this.runtime.uploads.get(retry.uploadId)) };
    if (draft.validatedVersion !== draft.version || !input.validationId || input.validationId !== draft.validationId) throw new ManualEntryError("Validate the saved records before submitting.", "DRAFT_NOT_VALIDATED");
    const uploads = [...this.runtime.uploads.values()];
    if (uploads.some((item) => item.organizationId === input.organizationId && item.dataSeries === draft.dataSeries && item.period === draft.period && !item.manualEntry && item.status !== "rejected")) throw new ManualEntryError("This month already contains file uploads. Use its existing source or choose a separate series.", "SOURCE_MODE_CONFLICT");
    const validation = validateGrid({ ...draft, rows: draft.rows.filter((row) => row.some((cell) => cell.trim())) });
    if (!validation.valid) throw new ManualEntryError("Check these records before submitting.", "VALIDATION_FAILED", validation.issues);
    const target = draft.correctionOf ? this.owned(this.submissions, draft.correctionOf, input.organizationId) : null;
    const id = randomUUID();
    const batchId = target?.batchId || id;
    const latest = new Map();
    for (const entry of this.entries(input.organizationId).filter((entry) => entry.dataSeries === draft.dataSeries && entry.period === draft.period)) latest.set(entry.batchId, entry);
    const entry = { ...structuredClone(draft), id, draftId: draft.id, batchId, rows: validation.normalizedRows,
      submittedAt: new Date().toISOString(), submittedByUserId: input.actorUserId, rowCount: validation.rowCount, dataStatus: "partial" };
    latest.set(batchId, entry);
    const content = canonicalMonthlyCsv(draft.columns, [...latest.values()].flatMap((value) => value.rows));
    const upload = await validateCustomerUploadFile({ fileName: `manual-${draft.period}.csv`, content,
      period: draft.period, dataSeries: draft.dataSeries, dataKind: "Sales performance" }, input.organizationId);
    if (upload.issues.length) throw new ManualEntryError("The monthly records contain validation errors.", "VALIDATION_FAILED", upload.issues);
    for (const item of uploads.filter((item) => item.organizationId === input.organizationId && item.dataSeries === draft.dataSeries && item.period === draft.period && item.manualEntry)) item.status = "superseded";
    upload.status = "confirmed"; upload.confirmedAt = new Date(); upload.manualEntry = true; upload.dataStatus = "partial";
    this.runtime.uploads.set(upload.id, upload);
    entry.uploadId = upload.id;
    this.submissions.set(id, structuredClone(entry)); draft.submittedAt = entry.submittedAt;
    this.runtime.auditLog.record({ organizationId: input.organizationId, actorUserId: input.actorUserId,
      eventType: "manual_entry.submitted", targetType: "manual_entry", targetId: id });
    return { draft: structuredClone(draft), submission: structuredClone(entry), upload: publicUpload(upload) };
  }
}
