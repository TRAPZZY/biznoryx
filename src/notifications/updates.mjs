import { AuthError } from "../auth/core.mjs";

export const UPDATE_FILTERS = ["all", "unread", "snoozed"];
export const UPDATE_CATEGORIES = ["all", "reports", "data"];

export function updateOptions({ filter = "all", category = "all", offset = 0, limit = 25 } = {}) {
  const start = Number(offset), size = Number(limit);
  if (!UPDATE_FILTERS.includes(filter) || !UPDATE_CATEGORIES.includes(category) ||
      !Number.isInteger(start) || start < 0 || start > 10000 ||
      !Number.isInteger(size) || size < 1 || size > 50) {
    throw new AuthError("Choose a valid Updates filter or page.", "VALIDATION_FAILED");
  }
  return { filter, category, offset: start, limit: size };
}

export function updateState(body, now = new Date()) {
  if (!body || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(body.id))) {
    throw new AuthError("Update was not found.", "NOT_FOUND");
  }
  if (body.action === "read" || body.action === "unread") return { id: body.id, action: body.action };
  if (body.action === "snooze" && [0, 24, 168].includes(body.hours)) {
    return { id: body.id, action: "snooze", until: body.hours ? new Date(now.getTime() + body.hours * 3600000) : null };
  }
  throw new AuthError("Choose read, unread or a supported reminder time.", "VALIDATION_FAILED");
}

export function preferenceInput(body) {
  if (!body || !["reports", "data"].includes(body.category) || typeof body.enabled !== "boolean") {
    throw new AuthError("Choose a valid notification preference.", "VALIDATION_FAILED");
  }
  return { category: body.category, enabled: body.enabled };
}

export function updateItem(row) {
  const ready = row.kind === "report_ready";
  return {
    id: row.id, category: ready ? "reports" : "data", kind: row.kind,
    title: ready ? "Your data is ready" : "A file needs your review",
    message: ready ? "Source checks and calculations are complete. Review the evidence for this period."
      : "This file did not pass validation. Review the issues before using it in your business history.",
    actionLabel: "Review source", href: `#/data?upload=${encodeURIComponent(row.ingestion_run_id)}`,
    period: row.period_label, evidenceStatus: row.evidence_status, sourceRevision: row.source_revision,
    sourceId: row.ingestion_run_id, createdAt: row.created_at, readAt: row.read_at, snoozedUntil: row.snoozed_until,
  };
}

export async function updatesRequest({ repository, scope, path, method, query, body }) {
  if (path === "/api/updates" && method === "GET") {
    const options = updateOptions(Object.fromEntries(["filter", "category", "offset", "limit"].filter(key => query.has(key)).map(key => [key, query.get(key)])));
    if (!repository) return { enabled: false, items: [], unreadCount: 0 };
    return repository.list({ ...scope, ...options });
  }
  if (!repository) throw new AuthError("Updates are not enabled for this business.", "SERVICE_UNAVAILABLE");
  if (path === "/api/updates/state" && method === "POST") return repository.setState({ ...scope, change: updateState(body) });
  if (path === "/api/updates/preferences" && method === "POST") return repository.setPreference({ ...scope, preference: preferenceInput(body) });
  if (path === "/api/updates/read-all" && method === "POST") {
    const through = new Date(body?.through);
    if (!Number.isFinite(through.getTime()) || through.getTime() > Date.now() + 5000) {
      throw new AuthError("Refresh Updates before marking all read.", "VALIDATION_FAILED");
    }
    return repository.markAllRead({ ...scope, through });
  }
  throw new AuthError("Endpoint not found.", "NOT_FOUND");
}
