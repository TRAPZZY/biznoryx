import { AuthError } from "../auth/core.mjs";

// Keep source names compatible with verified metric definitions, and bound
// the metadata repeated in aggregate and monthly report buckets.
export const MAX_CSV_HEADER_BYTES = 160;

export function validateCsvHeaderSizes(headers) {
  if (headers.some((header) => Buffer.byteLength(header, "utf8") > MAX_CSV_HEADER_BYTES)) {
    throw new AuthError(
      `CSV column names must not exceed ${MAX_CSV_HEADER_BYTES} UTF-8 bytes.`,
      "VALIDATION_FAILED",
    );
  }
}
