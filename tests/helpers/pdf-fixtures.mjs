import PDFDocument from "pdfkit";

export async function tablePdf(pages = [[
  ["date", "product", "revenue"],
  ["2026-10-01", "Service A", "125.50"],
  ["2026-10-02", "Service B", "74.50"],
]], options = {}) {
  const document = new PDFDocument({ autoFirstPage: false, compress: false, ...options });
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    document.on("data", chunk => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  for (const rows of pages) {
    document.addPage();
    for (let column = 0; column <= (rows[0]?.length ?? 0); column++) {
      document.moveTo(45 + column * 155, 45).lineTo(45 + column * 155, 45 + rows.length * 20).stroke();
    }
    for (let row = 0; row <= rows.length; row++) {
      document.moveTo(45, 45 + row * 20).lineTo(45 + (rows[0]?.length ?? 0) * 155, 45 + row * 20).stroke();
    }
    for (const [index, row] of rows.entries()) {
      for (const [column, value] of row.entries()) {
        document.fontSize(10).text(value, 50 + column * 155, 50 + index * 20, { lineBreak: false });
      }
    }
  }
  document.end();
  return completed;
}
