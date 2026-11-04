import { createHash } from "node:crypto";
import { AuthError } from "../auth/core.mjs";
import { financialSourcePreview } from "../ingestion/money-trail-source.mjs";
import { MoneyTrailError } from "../reports/money-trail.mjs";
import { normalizeTabularUpload } from "../ingestion/tabular-upload.mjs";

export const businessReviewPath = (path) =>
  [
    "/api/business-review",
    "/api/ingestion/preview",
    "/api/ingestion/profile",
    "/api/ingestion/reviewed",
    "/api/ingestion/map-existing",
  ].includes(path) ||
  path === "/api/money-trail" ||
  path.startsWith("/api/money-trail/") ||
  path === "/api/monthly-close" ||
  path.startsWith("/api/monthly-close/");

export async function businessReviewRequest({
  request,
  response,
  url,
  runtime,
  tenant,
  readJson,
  sendJson,
  sendEvidenceExport,
  mapIngestionResult,
  allowsFeature = () => true,
}) {
  const imports = runtime.importManifests,
    money = runtime.moneyTrail,
    monthly = runtime.monthlyClose;
  const released = (await runtime.reviewRelease?.allowed(tenant)) ?? false;
  if (url.pathname === "/api/business-review" && request.method === "GET") {
    const [reviewedImports, moneyTrail, monthlyClose] = await Promise.all([
      imports?.available() ?? false,
      money?.available() ?? false,
      monthly?.available() ?? false,
    ]);
    sendJson(response, 200, {
      reviewedImports: released && reviewedImports,
      moneyTrail: released && moneyTrail && allowsFeature("moneyTrail"),
      monthlyClose: released && monthlyClose && allowsFeature("monthlyClose"),
      reportExport: allowsFeature("reportExport"),
      formats: released && reviewedImports ? ["csv", "xlsx"] : ["csv"],
      limits: {
        csvBytes: 4 * 1024 * 1024,
        xlsxBytes: 2 * 1024 * 1024,
        xlsxExpandedBytes: 4 * 1024 * 1024,
        xlsxRows: 10000,
        xlsxCells: 50000,
      },
    });
    return;
  }
  if (!released)
    throw new AuthError(
      "Reviewed imports and monthly review are not yet released for this business. Existing CSV uploads, manual entry and evidence reports remain available.",
      "SERVICE_UNAVAILABLE",
    );
  const group = url.pathname.startsWith("/api/money-trail")
    ? money
    : url.pathname.startsWith("/api/monthly-close")
      ? monthly
      : imports;
  if (!group || !(await group.available()))
    throw new AuthError(
      "This feature is awaiting its reviewed database migration. Existing uploads and reports remain available.",
      "SERVICE_UNAVAILABLE",
    );
  const body = request.method === "POST" ? await readJson(request) : {};
  try {
    let result;
    if (
      url.pathname === "/api/ingestion/preview" &&
      request.method === "POST"
    ) {
      const preview = await runtime.ingestion.preview({ ...body, ...tenant });
      const profiles = await imports.list(tenant);
      result = {
        preview,
        profile:
          profiles.find((p) => p.dataStreamId === preview.dataStream.id) ??
          null,
      };
    } else if (
      url.pathname === "/api/ingestion/map-existing" &&
      request.method === "POST"
    ) {
      const object = await runtime.ingestion.download({
        ...tenant,
        uploadId: body.uploadId,
        normalized: true,
      });
      const parsed = await normalizeTabularUpload({
        fileName: object.fileName,
        content: object.body,
      });
      result = await imports.attachExisting({
        ...tenant,
        uploadId: body.uploadId,
        profileId: body.profileId,
        reviewedChecksum: body.reviewedChecksum,
        columns: parsed.columns.map((c) => c.name),
        parserVersion: parsed.parserVersion,
      });
    } else if (
      url.pathname === "/api/ingestion/profile" &&
      request.method === "POST"
    ) {
      result = { profile: await imports.approve({ ...body, ...tenant }) };
    } else if (
      url.pathname === "/api/ingestion/reviewed" &&
      request.method === "POST"
    ) {
      const upload = await runtime.ingestion.uploadReviewed({
        ...body,
        ...tenant,
      });
      result = { upload: mapIngestionResult(upload) };
    } else if (
      url.pathname === "/api/money-trail" &&
      request.method === "GET"
    ) {
      result = await money.list({
        ...tenant,
        ...(url.searchParams.has("period")
          ? { period: url.searchParams.get("period") }
          : {}),
      });
    } else if (
      ["/api/money-trail/preview", "/api/money-trail/import"].includes(
        url.pathname,
      ) &&
      request.method === "POST"
    ) {
      if (!imports || !(await imports.available()))
        throw new AuthError(
          "Reviewed import storage is unavailable.",
          "SERVICE_UNAVAILABLE",
        );
      const manifest = await imports.source({
        ...tenant,
        uploadId: body.uploadId,
      });
      const source = await runtime.dataIngestion.getNormalizedFile({
        ...tenant,
        uploadId: body.uploadId,
      });
      if (
        !tenantSourceKey(source.storageKey, tenant.organizationId) ||
        source.byteSize > 25 * 1024 * 1024 ||
        source.contentType !== "text/csv"
      )
        throw new AuthError("Source evidence is invalid.", "VALIDATION_FAILED");
      const object = await runtime.objectStorage.getObject({
        key: source.storageKey,
      });
      if (
        !Buffer.isBuffer(object.body) ||
        object.body.length !== source.byteSize ||
        createHash("sha256").update(object.body).digest("hex") !==
          source.checksumSha256
      )
        throw new AuthError(
          "Source integrity verification failed.",
          "VALIDATION_FAILED",
        );
      const preview = financialSourcePreview({
        body: object.body,
        profile: {
          ...manifest.definition,
          dateConvention:
            manifest.normalization?.dateConvention ??
            manifest.definition.dateConvention,
        },
        sourceChecksum: source.checksumSha256,
        profileId: manifest.profile_id,
      });
      if (url.pathname.endsWith("/preview")) result = preview;
      else {
        if (preview.issues.length || body.reviewedChecksum !== preview.checksum)
          throw new AuthError(
            "Review and resolve the source records before importing.",
            "VALIDATION_FAILED",
          );
        result = await money.importRecords({
          ...tenant,
          ingestionRunId: body.uploadId,
          records: preview.records,
          idempotencyKey: preview.checksum,
          supersedesRunId: body.supersedesRunId || undefined,
          correctionReason: body.correctionReason,
        });
      }
    } else if (
      [
        "/api/money-trail/allocate",
        "/api/money-trail/reverse",
        "/api/money-trail/classify",
      ].includes(url.pathname) &&
      request.method === "POST"
    ) {
      const method = url.pathname.endsWith("/allocate")
        ? "allocate"
        : url.pathname.endsWith("/reverse")
          ? "reverseAllocation"
          : "classify";
      result = await money[method]({ ...body, ...tenant });
    } else if (
      url.pathname === "/api/monthly-close/sources" &&
      request.method === "GET"
    ) {
      result = await monthly.sourceRequirements({
        ...tenant,
        period: url.searchParams.get("period"),
      });
    } else if (
      url.pathname === "/api/monthly-close/sources" &&
      request.method === "POST"
    ) {
      result = await monthly.setRequiredSources({ ...body, ...tenant });
    } else if (
      url.pathname === "/api/monthly-close" &&
      request.method === "GET"
    ) {
      if (url.searchParams.has("id")) {
        const item = await monthly.get({
          ...tenant,
          id: url.searchParams.get("id"),
        });
        item.evidenceStatus = await packetObjectStatus(runtime, tenant, item);
        if (url.searchParams.has("format")) {
          if (item.evidenceStatus !== "available")
            throw new AuthError(
              "This packet’s underlying evidence is unavailable. Its archived values remain visible with that limitation.",
              "VALIDATION_FAILED",
            );
          await sendEvidenceExport(
            response,
            item.report,
            url.searchParams.get("format"),
          );
          return;
        }
        result = { item };
      } else
        result = {
          items: await monthly.list({
            ...tenant,
            ...(url.searchParams.has("period")
              ? { period: url.searchParams.get("period") }
              : {}),
          }),
        };
    } else if (
      url.pathname === "/api/monthly-close/draft" &&
      request.method === "POST"
    ) {
      result = { item: await monthly.createDraft({ ...body, ...tenant }) };
    } else if (
      url.pathname === "/api/monthly-close/approve" &&
      request.method === "POST"
    ) {
      const item = await monthly.get({ ...tenant, id: body.id });
      if ((await packetObjectStatus(runtime, tenant, item)) !== "available")
        throw new AuthError(
          "Source files are unavailable. Restore access to the evidence before approving.",
          "VALIDATION_FAILED",
        );
      result = { item: await monthly.approve({ ...body, ...tenant }) };
    } else throw new AuthError("Review action not found.", "NOT_FOUND");
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof MoneyTrailError)
      throw new AuthError(
        error.message,
        error.code.endsWith("NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.includes("CONFLICT")
            ? "CONFLICT"
            : "VALIDATION_FAILED",
      );
    throw error;
  }
}

async function packetObjectStatus(runtime, tenant, item) {
  if (item.evidenceStatus !== "available" || !runtime.objectStorage)
    return "unavailable";
  for (const evidence of item.evidenceManifest.sources) {
    const source = await runtime.dataIngestion.getNormalizedFile({
      ...tenant,
      uploadId: evidence.id,
    });
    if (
      source.id !== evidence.rawDataObjectId ||
      source.checksumSha256 !== evidence.checksum ||
      !tenantSourceKey(source.storageKey, tenant.organizationId)
    )
      return "unavailable";
    const object = await runtime.objectStorage.headObject({
      key: source.storageKey,
    });
    if (
      !object.exists ||
      object.byteSize !== source.byteSize ||
      (object.metadata?.checksum &&
        object.metadata.checksum !== source.checksumSha256)
    )
      return "unavailable";
    if (evidence.originalArtifact) {
      const original = await runtime.dataIngestion.getSourceFile({
        ...tenant,
        uploadId: evidence.id,
      });
      if (
        original.id !== evidence.originalArtifact.id ||
        original.checksumSha256 !== evidence.originalArtifact.checksum
      )
        return "unavailable";
      const saved = await runtime.objectStorage.headObject({
        key: original.storageKey,
      });
      if (!saved.exists || saved.byteSize !== original.byteSize)
        return "unavailable";
    }
  }
  return "available";
}

function tenantSourceKey(key, organizationId) {
  return (
    typeof key === "string" &&
    [
      `organizations/${organizationId}/uploads/`,
      `org/${organizationId}/raw/`,
    ].some((prefix) => key.startsWith(prefix))
  );
}
