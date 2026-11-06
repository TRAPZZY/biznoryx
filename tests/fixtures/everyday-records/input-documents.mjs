// Source documents only. The renderer must never import the ground-truth manifest.
export const documents = [
  { id: "01-supplier", style: "receipt", title: "DEMO Ade Provision Supplies", lines: [
    "Date: 18/10/2026", "Receipt: DEMO-001", "Currency: NGN", "",
    "Description       Qty         Unit price    Amount",
    "Bottled water     5 cartons   NGN 4,000     NGN 20,000",
    "Instant noodles   3 cartons   NGN 9,500     NGN 28,500", "",
    "Goods subtotal: NGN 48,500", "Transport: NGN 2,000", "Total: NGN 50,500", "Amount paid: NGN 40,000", "Balance: NGN 10,500",
  ] },
  { id: "02-sales", style: "notebook", title: "DEMO Bisi Shop", lines: [
    "19 Oct 2026", "Currency: NGN", "",
    "Rice 5kg - 2 packs - 15k total - cash",
    "Oil 1L - 3 bottles @ 2,500 - transfer paid",
    "Soap - 4 bars - 2k total",
    "Customer A paid 1k, owes 1k", "",
    "Total sales: 24,500", "Money received: 23,500", "Still owing: 1,000",
  ] },
  { id: "03-withdrawal", style: "notebook", title: "DEMO Chika Tailoring", lines: [
    "19/10/26", "Currency: NGN; dates DD/MM/YY", "",
    "Fuel                         8,500", "Delivery                     2k",
    "Thread and buttons           3,200", "Repair sewing machine        6,000",
    "Took home for food           5k", "", "Total money out              24,700",
  ] },
  { id: "04-service", style: "notebook", title: "DEMO Musa Repairs", lines: [
    "Job: DEMO-J04", "20 October 2026", "Currency: NGN", "",
    "Customer B - generator service", "Agreed job price: NGN 35,000", "Deposit received: NGN 20,000",
    "Balance when collected: NGN 15,000", "", "Parts used: NGN 12,500", "Transport: NGN 2,500",
    "Parts and transport paid today.", "Customer has not collected generator.", "Job completion not recorded.",
  ] },
  { id: "05-correction", style: "notebook", title: "DEMO Ngozi Foods", lines: [
    "20/10/2026", "Currency: NGN", "", "Bought flour:",
    "[crossed out: 4; replacement written above: 3] bags @ 18,000",
    "Final total: 54k", "Paid cash: 54k",
  ], correction: true },
  { id: "06-ambiguous", style: "receipt", title: "DEMO Market Supplies", lines: [
    "Date: 20/10/2026", "Currency: NGN", "", "Product: Cooking oil", "Quantity: 2 containers",
    "Total: NGN [1/7]5,000", "Paid: not shown",
  ], ambiguous: true },
  { id: "08-repayment", style: "notebook", title: "DEMO Bisi Shop", lines: [
    "20 October 2026", "Currency: NGN", "", "Customer A paid remaining 1k for yesterday's soap.",
    "Received by transfer.", "Old balance: 1,000", "New balance: 0",
  ] },
];

const receipt = documents[0];
documents.splice(6, 0,
  { ...receipt, id: "07-duplicate-a", capture: "straight" },
  { ...receipt, id: "07-duplicate-b", capture: "rotated" },
);

export function sourceText(document) {
  return ["SYNTHETIC TEST RECORD - NOT REAL BUSINESS EVIDENCE", document.title, ...document.lines].join("\n") + "\n";
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function sourceHtml(document, visual = false) {
  const lines = document.lines.map((line, index) => {
    let html = escape(line) || "&nbsp;";
    if (visual && document.correction && line.startsWith("[crossed out:")) html = '<span class="quantity-correction"><del>4</del><ins>3</ins></span> bags @ 18,000';
    if (visual && document.ambiguous && line.startsWith("Total:")) html = 'Total: &#8358;<span class="unclear-digit"><span>1</span><span>7</span></span>5,000';
    if (visual && document.style === "receipt") html = html.replaceAll("NGN ", "&#8358;");
    if (visual && document.style === "receipt" && /\s{2,}/.test(line)) {
      html = line.split(/\s{2,}/).map(column => `<span>${escape(column).replaceAll("NGN ", "&#8358;")}</span>`).join("");
      return `<div class="line line-columns">${html}</div>`;
    }
    return `<div class="line line-${index % 3}">${html}</div>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic test document</title><style>
    * { box-sizing: border-box; } body { margin: 0; padding: 55px; background: ${visual ? "#c9d0d2" : "white"}; color: #1b2426; }
    .paper { position: relative; width: 840px; min-height: 1040px; padding: 40px 42px 65px; background: #fff; border: 1px solid #bdc2c4; }
    .stamp { font: 13px Arial,sans-serif; color: #70483d; border: 1px solid #a4867c; padding: 8px; margin: 0 0 30px; text-align: center; }
    h1 { margin: 0 0 28px; font: bold 30px Arial,sans-serif; } .line { position: relative; min-height: 47px; font: 23px/47px 'Courier New',monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notebook .line { border-bottom: 1px solid #cbdcea; } .visual.notebook .line { font-family: 'Segoe Print','Comic Sans MS',cursive; font-size: 21px; letter-spacing: 0; }
    .visual.notebook .line-1 { transform: rotate(-0.35deg); } .visual.notebook .line-2 { transform: rotate(0.25deg); }
    .visual { box-shadow: 6px 12px 12px #28353830; } .rotated { transform: rotate(2deg) translate(-10px,-12px); filter: brightness(.88); }
    .receipt .line-columns { display: grid; grid-template-columns: 2.2fr 1.4fr 1.5fr 1.4fr; column-gap: 14px; white-space: normal; font-size: 21px; }
    .quantity-correction { display: inline-block; position: relative; margin-right: 10px; width: 24px; }
    del { text-decoration-thickness: 3px; text-decoration-color: #233f5c; } ins { position: absolute; top: -25px; left: 0; color: #233f5c; text-decoration: none; }
    .unclear-digit { display: inline-block; position: relative; width: 17px; height: 30px; vertical-align: middle; }
    .unclear-digit span { position: absolute; left: 0; top: -10px; opacity: .62; } .unclear-digit span + span { left: 2px; }
    footer { margin-top: 40px; font: 12px Arial,sans-serif; color: #647176; }
  </style></head><body><article class="paper ${escape(document.style)} ${visual ? "visual" : ""} ${document.capture === "rotated" ? "rotated" : ""}"><div class="stamp">SYNTHETIC TEST RECORD - NOT REAL BUSINESS EVIDENCE</div><h1>${escape(document.title)}</h1>${lines}<footer>Fictional extraction test</footer></article></body></html>`;
}
