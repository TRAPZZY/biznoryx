import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** These examples are invented; do not use real people, numbers, or customer files. */
export const CAPTURES = Object.freeze([
  {
    id: '01-clean-sale', category: 'clean_printed_sale', style: 'receipt',
    lines: ['SAMPLE ONLY - CITY KIOSK', 'REF: S-1001    DATE: 2026-10-02', '3 x WATER @ NGN 250', 'TOTAL: NGN 750', 'PAID: CASH'],
    expected: { transaction_id: 'S-1001', date: '2026-10-02', type: 'sale', currency: 'NGN', amount_minor: 75000, review_required: false },
  },
  {
    id: '02-supplier-purchase', category: 'clean_supplier_receipt', style: 'receipt',
    lines: ['SAMPLE ONLY - WHOLESALE', 'REF: P-110    DATE: 2026-10-03', '2 x RICE BAG @ NGN 28000', 'TOTAL: NGN 56000', 'PAID: TRANSFER'],
    expected: { transaction_id: 'P-110', date: '2026-10-03', type: 'purchase', currency: 'NGN', amount_minor: 5600000, review_required: false },
  },
  {
    id: '03-notebook-sale', category: 'handwritten_style_sale', style: 'notebook',
    lines: ['SAMPLE SHOP NOTES - OCT 2026', '04/10/2026   H-203', 'BREAD 8 x 900', 'CASH RECEIVED 7200'],
    expected: { transaction_id: 'H-203', date: '2026-10-04', type: 'sale', currency: 'NGN', amount_minor: 720000, review_required: false },
  },
  {
    id: '04-corrected-quantity', category: 'handwritten_correction', style: 'notebook',
    lines: ['SAMPLE SHOP NOTES', '05/10/2026  H-204', 'OIL: 5 (CROSSED OUT)', 'CORRECTION: 4 x NGN 1500', 'FINAL TOTAL 6000'],
    expected: { transaction_id: 'H-204', date: '2026-10-05', type: 'sale', currency: 'NGN', amount_minor: 600000, quantity: 4, superseded_quantity: 5, review_required: true, reasons: ['manual_correction'] },
  },
  {
    id: '05-unclear-amount', category: 'ambiguous_handwriting', style: 'notebook',
    lines: ['SAMPLE SHOP NOTES', '06/10/2026  H-205', 'SOAP: NGN 1?00', 'AMOUNT UNCLEAR - DO NOT GUESS'],
    expected: { transaction_id: 'H-205', date: '2026-10-06', type: 'sale', currency: 'NGN', amount_minor: null, review_required: true, reasons: ['ambiguous_amount'] },
  },
  {
    id: '06-loan-repayment', category: 'non_revenue_cash_in', style: 'receipt',
    lines: ['SAMPLE ONLY - CASHBOOK', 'REF: R-206   DATE: 2026-10-07', 'LOAN PRINCIPAL REPAYMENT', 'RECEIVED: NGN 10000', 'NOT SALES REVENUE'],
    expected: { transaction_id: 'R-206', date: '2026-10-07', type: 'loan_principal_repayment', currency: 'NGN', amount_minor: 1000000, review_required: false, include_in_sales: false },
  },
  {
    id: '07-duplicate-first', category: 'duplicate_capture', style: 'receipt',
    lines: ['SAMPLE ONLY - CITY KIOSK', 'REF: S-107   DATE: 2026-10-08', '2 x FLOUR @ NGN 3000', 'TOTAL: NGN 6000', 'PAID: CASH'],
    expected: { transaction_id: 'S-107', date: '2026-10-08', type: 'sale', currency: 'NGN', amount_minor: 600000, duplicate_group: 'same-event-107', review_required: false },
  },
  {
    id: '08-duplicate-second', category: 'duplicate_capture', style: 'receipt-offset',
    lines: ['SAMPLE ONLY - CITY KIOSK', 'REF: S-107   DATE: 2026-10-08', '2 x FLOUR @ NGN 3000', 'TOTAL: NGN 6000', 'PAID: CASH'],
    expected: { transaction_id: 'S-107', date: '2026-10-08', type: 'sale', currency: 'NGN', amount_minor: 600000, duplicate_group: 'same-event-107', duplicate_of: '07-duplicate-first', review_required: false },
  },
  {
    id: '09-cropped-receipt', category: 'incomplete_capture', style: 'cropped',
    lines: ['SAMPLE ONLY - PARTIAL IMAGE', 'REF: C-209', '[DATE OUTSIDE PHOTO]', 'MISC GOODS', 'TOTAL: NGN 4500', '[QUANTITY OUTSIDE PHOTO]'],
    expected: { transaction_id: 'C-209', date: null, type: 'unknown', currency: 'NGN', amount_minor: 450000, review_required: true, reasons: ['missing_date', 'missing_line_items'] },
  },
]);

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function renderCaptureSvg(capture) {
  const notebook = capture.style === 'notebook';
  const offset = capture.style === 'receipt-offset';
  const paper = notebook ? '#f9f5e9' : '#fcfcf8';
  const strokes = notebook ? Array.from({ length: 27 }, (_, i) => `<line x1="25" x2="795" y1="${110 + i * 32}" y2="${110 + i * 32}" stroke="#b4cad1" stroke-width="1" opacity=".65"/>`).join('') : '';
  const top = offset ? 157 : 142;
  const x = offset ? 95 : 65;
  const font = notebook ? 'cursive' : 'monospace';
  const rotation = offset ? 'translate(16 13) rotate(-1 390 440)' : '';
  const text = capture.lines.map((line, index) => `<text x="${x}" y="${top + index * (notebook ? 94 : 112)}" font-family="${font}" font-size="${notebook ? 30 : 28}" fill="#202933" letter-spacing=".7">${escapeXml(line)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="1030" viewBox="0 0 820 1030"><rect width="820" height="1030" fill="#d9dedf"/><rect x="17" y="17" width="786" height="996" rx="4" fill="${paper}" stroke="#b1b3b1" stroke-width="3"/>${strokes}<g transform="${rotation}">${text}</g><text x="65" y="963" font-size="17" fill="#666" font-family="sans-serif">FICTIONAL DOCUMENT - EVALUATION ONLY</text></svg>\n`;
}

/** Files in inputs/ are the ONLY files an extraction evaluator may read. */
export async function generateEvaluationFixtures(outputDir, { png = false, suite = 'legacy' } = {}) {
  const root = resolve(outputDir);
  if (suite === 'owner-records') {
    const { renderOwnerRecordInputs } = await import('./lib/record-fixture-renderer.mjs');
    const result = await renderOwnerRecordInputs(root, { png });
    const answers = join(root, 'answers');
    await mkdir(answers, { recursive: true });
    await writeFile(join(answers, 'expected.json'), await readFile(new URL('../tests/fixtures/everyday-records/ground-truth.json', import.meta.url)));
    return { ...result, expectedDirectory: answers };
  }
  if (suite !== 'legacy') throw new Error('Unknown extraction fixture suite.');
  const inputs = join(root, 'inputs');
  const answers = join(root, 'answers');
  await mkdir(inputs, { recursive: true });
  await mkdir(answers, { recursive: true });
  const truth = [];
  for (const capture of CAPTURES) {
    const svg = renderCaptureSvg(capture);
    await writeFile(join(inputs, `${capture.id}.svg`), svg, 'utf8');
    truth.push({ capture_id: capture.id, category: capture.category, ...capture.expected });
  }
  await writeFile(join(answers, 'expected.json'), `${JSON.stringify({ schema_version: 1, captures: truth }, null, 2)}\n`, 'utf8');
  if (png) {
    // Playwright renders locally without uploading source material to a provider.
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 820, height: 1030 }, deviceScaleFactor: 1 });
      await page.route('**/*', (route) => route.abort());
      for (const capture of CAPTURES) {
        await page.setContent(`<html><head><style>html,body{margin:0;padding:0}</style></head><body>${renderCaptureSvg(capture)}</body></html>`, { waitUntil: 'load' });
        await page.screenshot({ path: join(inputs, `${capture.id}.png`), animations: 'disabled' });
      }
    } finally {
      await browser.close();
    }
  }
  return { captures: truth.length, inputDirectory: inputs, expectedDirectory: answers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const suiteIndex = args.indexOf('--suite');
  const suite = suiteIndex < 0 ? 'legacy' : args[suiteIndex + 1];
  const options = args.filter((_, index) => index !== suiteIndex && (suiteIndex < 0 || index !== suiteIndex + 1));
  if (!['legacy', 'owner-records'].includes(suite) || options.some(arg => arg !== '--png') || args.filter(arg => arg === '--suite').length > 1) {
    process.stderr.write('Usage: node scripts/generate-extraction-fixtures.mjs [--png] [--suite legacy|owner-records]\n');
    process.exitCode = 2;
  } else {
    const dir = resolve('test-results/extraction-evaluation', suite === 'legacy' ? '' : suite);
    const result = await generateEvaluationFixtures(dir, { png: args.includes('--png'), suite });
    process.stdout.write(`Generated ${result.captures} synthetic captures in ${result.inputDirectory}; answer key isolated in ${result.expectedDirectory}.\n`);
  }
}
