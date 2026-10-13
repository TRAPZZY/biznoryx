import { PDFParse } from "pdf-parse";
import { PDF_LIMITS, tableFromPdfPages } from "./pdf-table-structure.mjs";

let parser;
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > PDF_LIMITS.bytes) throw new Error("The PDF exceeds the 8 MiB limit.");
    chunks.push(chunk);
  }
  parser = new PDFParse({ data: Buffer.concat(chunks), isEvalSupported: false, useWorkerFetch: false, useWasm: false, stopAtErrors: true, enableXfa: false, maxImageSize: 1000000 });
  const info = await parser.getInfo();
  if (info.total < 1 || info.total > PDF_LIMITS.pages) throw new Error("The PDF must contain 1 to 50 pages.");
  if (info.permission || info.info?.IsAcroFormPresent || info.info?.IsXFAPresent) throw new Error("Encrypted PDFs and form documents are unsupported. Export a plain text table or CSV.");
  const pages = [];
  let sizeBytes = 0;
  for (let page = 1; page <= info.total; page++) {
    const result = await parser.getText({ partial: [page], cellSeparator: "\t", pageJoiner: "", lineEnforce: true, parseHyperlinks: false });
    sizeBytes += Buffer.byteLength(result.pages[0]?.text ?? "", "utf8");
    if (sizeBytes > PDF_LIMITS.textBytes) throw new Error("The extracted PDF table exceeds the 2 MiB text limit.");
    const tables = await parser.getTable({ partial: [page] });
    const found = tables.pages[0]?.tables ?? [];
    if (found.length > 1) throw new Error("The PDF contains multiple tables on a page. Export separate transaction tables as CSV.");
    const table = found[0];
    if (table) {
      const compact = value => value.replace(/\s/g, "");
      if (compact(table.flat().join("")) !== compact(result.pages[0]?.text ?? "")) throw new Error("The PDF contains text outside its table. No partial table was accepted; export transaction rows as CSV.");
    }
    pages.push({ ...result.pages[0], table });
  }
  const result = tableFromPdfPages(pages);
  await parser.destroy();
  parser = null;
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  try { await parser?.destroy(); } catch { /* The containing process exits even if parser cleanup fails. */ }
  const known = /^(?:The PDF|PDF |Every PDF|Use a PDF|The extracted PDF|Encrypted PDFs)/.test(error.message);
  process.stdout.write(JSON.stringify({ error: known ? error.message : "The PDF could not be read safely. Malformed, password-protected and scanned documents require a text-table or CSV export." }));
}
