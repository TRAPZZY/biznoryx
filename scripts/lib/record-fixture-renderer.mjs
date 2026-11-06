import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { documents, sourceHtml, sourceText } from "../../tests/fixtures/everyday-records/input-documents.mjs";

// This renderer deliberately has no answer-key dependency.
export async function renderOwnerRecordInputs(root, { png = false } = {}) {
  const inputs = join(root, "inputs");
  await mkdir(join(inputs, "clean"), { recursive: true });
  if (png) await mkdir(join(inputs, "visual"), { recursive: true });
  let browser, page;
  const files = [];
  try {
    if (png) {
      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch();
      page = await browser.newPage({ viewport: { width: 950, height: 1240 }, deviceScaleFactor: 1, locale: "en-NG" });
      await page.route(/^https?:/, route => route.abort());
    }
    for (const [index, document] of documents.entries()) {
      const captureId = `capture-${String(index + 1).padStart(2, "0")}`;
      const cleanText = `clean/${captureId}.txt`;
      const cleanDocument = `clean/${captureId}.html`;
      const text = sourceText(document);
      await writeFile(join(inputs, cleanText), text);
      await writeFile(join(inputs, cleanDocument), sourceHtml(document));
      const entry = { fixtureId: document.id, captureId, synthetic: true, cleanText, cleanDocument,
        textSha256: createHash("sha256").update(text).digest("hex"), capture: document.capture || "baseline" };
      if (png) {
        await page.setContent(sourceHtml(document, true));
        await page.evaluate(() => document.fonts.ready);
        const bytes = await page.screenshot({ type: "png", ...(document.capture === "rotated"
          ? { clip: { x: 75, y: 80, width: 850, height: 1110 } } : { fullPage: true }) });
        const pixelCheck = await page.evaluate(async base64 => {
          const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0, light = 0;
          for (let i = 0; i < pixels.length; i += 16) { if (pixels[i] < 100) dark++; if (pixels[i] > 190) light++; }
          return { width: image.width, height: image.height, nonblank: dark > 100 && light > 100 };
        }, bytes.toString("base64"));
        if (!pixelCheck.nonblank) throw new Error(`Blank synthetic image: ${captureId}`);
        entry.visual = `visual/${captureId}.png`;
        entry.sha256 = createHash("sha256").update(bytes).digest("hex");
        entry.pixelCheck = pixelCheck;
        await writeFile(join(inputs, entry.visual), bytes);
      }
      files.push(entry);
    }
    await writeFile(join(root, "input-index.json"), JSON.stringify({ synthetic: true, version: "owner-records-v1", files }, null, 2) + "\n");
    await writeFile(join(root, "gallery.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic extraction fixtures</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px Arial,sans-serif;color:#213d32;margin:32px;background:#f5f7f6}h1{font-size:26px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0;border:1px solid #c5d0ca;border-radius:4px;background:white;padding:12px}img{width:100%;height:auto}figcaption{padding:12px 0}a{color:#176348}</style></head><body><h1>Synthetic extraction fixtures</h1><p>Fictional test documents only. No real-world accuracy claim. No provider called.</p><main>${files.map(file => `<figure><figcaption>${file.captureId} / <a href="inputs/${file.cleanDocument}">Clean document</a></figcaption>${file.visual ? `<a href="inputs/${file.visual}"><img src="inputs/${file.visual}" alt="Synthetic test document ${file.captureId}"></a>` : ""}</figure>`).join("")}</main></body></html>`);
    return { captures: files.length, inputDirectory: inputs, files };
  } finally { await browser?.close(); }
}
