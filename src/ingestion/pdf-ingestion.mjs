import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuthError } from "../auth/core.mjs";
import { PDF_LIMITS } from "./pdf-table-structure.mjs";

let activeParsers = 0;
const childPath = fileURLToPath(new URL("./pdf-extract-child.mjs", import.meta.url));

export function decodePdfUpload(contentBase64) {
  if (typeof contentBase64 !== "string" || !contentBase64.length) invalid("PDF file content is required.");
  if (contentBase64.length > Math.ceil(PDF_LIMITS.bytes / 3) * 4) invalid("The PDF exceeds the 8 MiB limit.");
  if (contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(contentBase64)) invalid("PDF content must use valid base64 encoding.");
  const body = Buffer.from(contentBase64, "base64");
  if (body.toString("base64") !== contentBase64) invalid("PDF content must use canonical base64 encoding.");
  validatePdfBytes(body);
  return body;
}

export function validatePdfBytes(body) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > PDF_LIMITS.bytes) invalid("The PDF must contain at most 8 MiB of data.");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(body.subarray(0, 16).toString("latin1")) || !/%%EOF\s*$/.test(body.subarray(-1024).toString("latin1"))) invalid("The file is not a supported, complete PDF document.");
}

export async function extractPdfTable(body, { timeoutMs = 30000 } = {}) {
  validatePdfBytes(body);
  if (activeParsers >= 2) throw new AuthError("PDF processing is busy. Please retry shortly.", "SERVICE_UNAVAILABLE");
  activeParsers++;
  // Isolate parser crashes/CPU limits and keep application/provider secrets out
  // of its environment. This is resource isolation, not an OS sandbox.
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=256", childPath], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      });
      const chunks = [];
      let bytes = 0;
      let failure;
      const stop = message => { failure ??= message; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop("PDF processing timed out. Export the source as CSV or use a smaller document."), timeoutMs);
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > PDF_LIMITS.textBytes * 2) stop("The extracted PDF table exceeds the output limit.");
        else chunks.push(chunk);
      });
      child.stdin.on("error", () => { failure ??= "PDF processing failed. Export the source as CSV."; });
      child.once("error", () => { clearTimeout(timer); reject(new AuthError("PDF extraction is unavailable. Please retry or upload CSV.", "SERVICE_UNAVAILABLE")); });
      child.once("close", code => {
        clearTimeout(timer);
        if (failure || code !== 0) { reject(new AuthError(failure || "PDF processing failed. Export the source as CSV.", "VALIDATION_FAILED")); return; }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (payload.error) invalid(payload.error);
          if (!payload.result || typeof payload.result.csv !== "string") invalid("PDF extraction returned no usable table.");
          resolve(payload.result);
        } catch (error) { reject(error instanceof AuthError ? error : new AuthError("PDF extraction failed. Export the source as CSV.", "VALIDATION_FAILED")); }
      });
      child.stdin.end(body);
    });
  } finally { activeParsers--; }
}

function invalid(message) { throw new AuthError(message, "VALIDATION_FAILED"); }
