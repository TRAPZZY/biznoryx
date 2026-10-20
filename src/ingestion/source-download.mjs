import { AuthError } from "../auth/core.mjs";

let activeDownloads = 0;

export async function serveSourceDownload(response, loadSource) {
  if (activeDownloads >= 1) throw new AuthError("Downloads are busy. Please try again shortly.", "SERVICE_UNAVAILABLE");
  activeDownloads += 1;
  let released = false;
  let loading = true;
  const release = () => {
    if (released) return;
    released = true;
    activeDownloads -= 1;
  };
  response.once("finish", release);
  // A disconnected client must not free a slot while storage is still reading.
  response.once("close", () => { if (!loading) release(); });
  try {
    const source = await loadSource();
    loading = false;
    if (response.destroyed) release();
    else sendSourceDownload(response, source);
  } catch (error) {
    loading = false;
    release();
    throw error;
  }
}

function sendSourceDownload(response, { fileName, contentType, body }) {
  const name = String(fileName || "source.csv").toWellFormed().split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim().slice(0, 180).toWellFormed() || "source.csv";
  const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  response.setHeader("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
  response.setHeader("Content-Type", contentType === "text/csv" ? "text/csv; charset=utf-8" : "application/octet-stream");
  response.setHeader("Content-Length", body.byteLength);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.end(body);
}
