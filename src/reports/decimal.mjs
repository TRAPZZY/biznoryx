export const SCALE = 10n ** 10n;

export function parseReportNumber(value) {
  let raw = String(value ?? "").trim();
  if (/^\([^()]+\)$/.test(raw)) raw = `-${raw.slice(1, -1)}`;
  raw = raw.replace(/^[\u0024\u00a3\u20ac\u20a6]/, "");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) raw = raw.replaceAll(",", "");
  if (!/^[+-]?\d{1,28}(\.\d{1,10})?$/.test(raw)) return null;
  const sign = raw.startsWith("-") ? -1n : 1n;
  const [whole, fraction = ""] = raw.replace(/^[+-]/, "").split(".");
  return sign * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, "0")));
}

export function reportDecimal(value) {
  const n = typeof value === "bigint" ? value : parseReportNumber(value);
  if (n === null) return null;
  const positive = n < 0n ? -n : n;
  const fraction = String(positive % SCALE).padStart(10, "0").replace(/0+$/, "");
  return `${n < 0n ? "-" : ""}${positive / SCALE}${fraction ? `.${fraction}` : ""}`;
}
