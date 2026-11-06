import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { deflateRawSync, crc32 } from "node:zlib";
import { AuthError } from "../src/auth/core.mjs";
import { normalizeTabularUpload } from "../src/ingestion/tabular-upload.mjs";

const require = createRequire(import.meta.url);
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const text = (ref, value) =>
  `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
const num = (ref, value, attributes = "") =>
  `<c r="${ref}" ${attributes}><v>${value}</v></c>`;
const table = (rows) =>
  `<worksheet xmlns="${NS}"><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells}</row>`).join("")}</sheetData></worksheet>`;
const standard = () =>
  table([
    text("A1", "Account") +
      text("B1", "Amount") +
      text("C1", "Date") +
      text("D1", "Active"),
    text("A2", "00123") +
      num("B2", "88259496234518.57") +
      text("C2", "03/04/2026") +
      num("D2", "1", 't="b"'),
    text("A3", "00000") +
      num("B3", "1.0000000000000001") +
      text("C3", "2026-11-02") +
      num("D3", "0", 't="b"'),
  ]);

// Synthetic, actual OOXML workbooks. This tiny ZIP writer is test-only and
// independently emits stored/deflated entries, CRCs and central-directory data.
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value, options = {}] of entries) {
    const nameBytes = Buffer.from(name),
      bytes = Buffer.from(value);
    const compressed = options.stored ? bytes : deflateRawSync(bytes);
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(options.flags ?? 0, 6);
    header.writeUInt16LE(options.stored ? 0 : 8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(options.declaredSize ?? bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function workbook({
  sheets = [["Sales", standard()]],
  extra = [],
  overrides = {},
} = {}) {
  const parts = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `<Relationships xmlns="${PKG}"><Relationship Id="root" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map(([name], i) => `<sheet name="${escape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ...Object.fromEntries(
      sheets.map(([, xml], i) => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
    ),
    ...overrides,
  };
  return zip([...Object.entries(parts), ...extra]);
}

const xlsx = (content, sheet) =>
  normalizeTabularUpload({ fileName: "sales.xlsx", content, sheet });
async function rejectsUpload(input, pattern, code = "VALIDATION_FAILED") {
  await assert.rejects(normalizeTabularUpload(input), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}
const rejectsWorkbook = (bytes, pattern, code) =>
  rejectsUpload({ fileName: "sales.xlsx", content: bytes }, pattern, code);

test("CSV preserves every original byte, BOM, CRLF, whitespace and exact decimals", async () => {
  const content =
    '\uFEFF Account ,Amount,Date\r\n"00123",88259496234518.57,03/04/2026\r\n00001,1.0000000000000001,2026-11-02\r\n';
  const result = await normalizeTabularUpload({
    fileName: "sales.CSV",
    content,
  });
  assert.equal(result.normalizedContent, content);
  assert.deepEqual(result.originalBytes, Buffer.from(content));
  assert.equal(result.originalContentType, "text/csv");
  assert.equal(result.format, "csv");
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.columns, [
    {
      name: "Account",
      type: "text",
      required: true,
      dataType: "text",
      nullable: false,
    },
    {
      name: "Amount",
      type: "decimal",
      required: true,
      dataType: "decimal",
      nullable: false,
    },
    {
      name: "Date",
      type: "text",
      required: true,
      dataType: "text",
      nullable: false,
    },
  ]);
  assert.match(result.parserVersion, /csv-parse@7\.0\.3/);
});

test("CSV accepts Buffer and canonical base64 with the same original bytes", async () => {
  const bytes = Buffer.from('a,b\n"line\nnext",0.10\n');
  for (const source of [
    { content: bytes },
    { contentBase64: bytes.toString("base64") },
  ]) {
    const result = await normalizeTabularUpload({
      fileName: "a.csv",
      ...source,
    });
    assert.deepEqual(result.originalBytes, bytes);
    assert.equal(result.normalizedContent, bytes.toString());
    assert.equal(result.rowCount, 1);
  }
});

test("invalid inputs, malformed base64 and invalid UTF-8 fail closed", async () => {
  for (const contentBase64 of [
    "a",
    "!!!!",
    "YQ",
    "YR==",
    "YQ==\n",
    "",
    "data:text/csv;base64,YQ==",
  ]) {
    await rejectsUpload(
      { fileName: "a.csv", contentBase64 },
      /base64|content/i,
    );
  }
  await rejectsUpload(
    { fileName: "a.csv", content: "a\n1", contentBase64: "YQ==" },
    /exactly one/i,
  );
  await rejectsUpload(
    { fileName: "a.csv", content: Buffer.from([0xff]) },
    /UTF-8/,
  );
  await rejectsUpload({ fileName: "a.csv", content: "a\n\ud800" }, /UTF-8/);
  await rejectsUpload(
    { fileName: "a.xlsx", content: "not binary" },
    /binary|base64/i,
  );
  for (const fileName of [
    "a.xls",
    "a.xlsm",
    "a.tsv",
    "a.txt",
    "a.json",
    "../a.csv",
    "",
  ]) {
    await rejectsUpload({ fileName, content: "a\n1" }, /CSV|XLSX|file name/i);
  }
});

test("CSV rejects missing/duplicate/oversize headers and malformed/ragged input", async () => {
  for (const content of [
    "",
    "a,b",
    ",b\n1,2",
    "A, a\n1,2",
    "a,b\n1",
    'a\n"unclosed',
    `${"a".repeat(161)}\n1`,
  ]) {
    await rejectsUpload(
      { fileName: "a.csv", content },
      /content|header|column|parsed|160/i,
    );
  }
});

test("CSV enforces original byte, record, row, column and cell budgets", async () => {
  for (const content of [
    Buffer.alloc(25 * 1024 * 1024 + 1, 65),
    `a\n${"x".repeat(1024 * 1024 + 1)}`,
  ]) {
    await rejectsUpload({ fileName: "a.csv", content }, /25 MiB|1 MiB/);
  }
  await rejectsUpload(
    { fileName: "a.csv", content: "a\n" + "1\n".repeat(50_001) },
    /50,000/,
  );
  await rejectsUpload(
    {
      fileName: "a.csv",
      content:
        Array.from({ length: 201 }, (_, i) => `h${i}`).join(",") +
        "\n" +
        "1,".repeat(200) +
        "1",
    },
    /200/,
  );
  const header = Array.from({ length: 200 }, (_, i) => `h${i}`).join(",");
  await rejectsUpload(
    {
      fileName: "a.csv",
      content: header + "\n" + ("1,".repeat(199) + "1\n").repeat(5001),
    },
    /1,000,000/,
  );
  const allowed = await normalizeTabularUpload({
    fileName: "a.csv",
    content: "a\n" + "1\n".repeat(50_000),
  });
  assert.equal(allowed.rowCount, 50_000);
});

test("real XLSX fixture: exact numeric lexemes, leading zeros, booleans, dates and original bytes", async () => {
  const bytes = workbook();
  // Independent parser acceptance proves the fixture is a readable workbook.
  const { readSheet } = require("read-excel-file/node");
  assert.equal(
    (await readSheet(bytes, { parseNumber: (v) => v }))[1][1],
    "88259496234518.57",
  );
  const result = await xlsx(bytes);
  assert.deepEqual(result.originalBytes, bytes);
  assert.equal(
    result.originalContentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    result.normalizedContent,
    "Account,Amount,Date,Active\n00123,88259496234518.57,03/04/2026,true\n00000,1.0000000000000001,2026-11-02,false\n",
  );
  assert.equal(result.rowCount, 2);
  assert.deepEqual(
    result.columns.map((c) => c.type),
    ["text", "decimal", "text", "boolean"],
  );
  assert.deepEqual(result.sheets, ["Sales"]);
  assert.equal(result.selectedSheet, "Sales");
  assert.equal(result.format, "xlsx");
  assert.match(result.parserVersion, /read-excel-file@9\.3\.14/);
  const encoded = await normalizeTabularUpload({
    fileName: "sales.xlsx",
    contentBase64: bytes.toString("base64"),
  });
  assert.equal(encoded.normalizedContent, result.normalizedContent);
});

test("multiple sheets require explicit selection by exact name or one-based index", async () => {
  const bytes = workbook({
    sheets: [
      ["Sales", standard()],
      ["Other", table([text("A1", "Code"), text("A2", "0007")])],
    ],
  });
  await assert.rejects(xlsx(bytes), (error) => {
    assert.equal(error.code, "SHEET_SELECTION_REQUIRED");
    assert.deepEqual(error.sheets, ["Sales", "Other"]);
    return true;
  });
  for (const sheet of ["Other", 2]) {
    const result = await xlsx(bytes, sheet);
    assert.equal(result.normalizedContent, "Code\n0007\n");
    assert.equal(result.selectedSheet, "Other");
  }
  for (const sheet of ["missing", 0, -1, 3, 1.5, {}, ""]) {
    await rejectsUpload(
      { fileName: "a.xlsx", content: bytes, sheet },
      /sheet/i,
    );
  }
});

test("XLSX rejects formulas even with cached values, errors and external links anywhere", async () => {
  for (const cell of [
    '<c r="A2"><f>1+1</f><v>2</v></c>',
    '<c r="A2"><f>1+1</f></c>',
    '<c r="A2" t="str"><v>cached</v></c>',
    '<c r="A2" t="e"><v>#N/A</v></c>',
  ]) {
    await rejectsWorkbook(
      workbook({ sheets: [["Data", table([text("A1", "a"), cell])]] }),
      /formula|error/i,
    );
  }
  await rejectsWorkbook(
    workbook({
      extra: [
        [
          "xl/worksheets/_rels/sheet1.xml.rels",
          `<Relationships xmlns="${PKG}"><Relationship Id="link" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`,
        ],
      ],
    }),
    /external/i,
  );
  await rejectsWorkbook(
    workbook({
      extra: [["xl/externalLinks/externalLink1.xml", "<externalLink/>"]],
    }),
    /external/i,
  );
  await rejectsWorkbook(
    workbook({
      sheets: [
        ["Safe", standard()],
        ["Unsafe", table([text("A1", "a"), '<c r="A2"><f>1</f><v>1</v></c>'])],
      ],
    }),
    /formula/i,
  );
});

test("XLSX rejects macro, encrypted and malformed archives and XML entities", async () => {
  await rejectsWorkbook(
    workbook({ extra: [["xl/vbaProject.bin", "macro"]] }),
    /macro|binary/i,
  );
  await rejectsWorkbook(
    workbook({
      overrides: {
        "[Content_Types].xml":
          '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
      },
    }),
    /macro/i,
  );
  await rejectsWorkbook(
    zip([["EncryptedPackage", "secret", { flags: 1 }]]),
    /encrypt/i,
  );
  await rejectsWorkbook(Buffer.from("not a ZIP"), /ZIP|encrypted|XLSX/i);
  await rejectsWorkbook(workbook().subarray(0, 90), /ZIP|archive/i);
  await rejectsWorkbook(
    workbook({
      sheets: [
        [
          "Data",
          `<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///secret">]>${standard()}`,
        ],
      ],
    }),
    /DOCTYPE|entit/i,
  );
  await rejectsWorkbook(
    workbook({ sheets: [["Data", "<worksheet>"]] }),
    /XML|workbook/i,
  );
});

test("ZIP limits include actual expansion, lying sizes, member counts, paths and CRC integrity", async () => {
  await rejectsWorkbook(
    workbook({
      extra: Array.from({ length: 257 }, (_, i) => [`extra/${i}.xml`, "<x/>"]),
    }),
    /256|entries|members/i,
  );
  const expanded = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
  await rejectsWorkbook(
    workbook({ extra: [["extra/huge.xml", expanded]] }),
    /entry|expan|decompress/i,
  );
  await rejectsWorkbook(
    workbook({ extra: [["extra/lie.xml", expanded, { declaredSize: 32 }]] }),
    /size|expan|decompress/i,
  );
  await rejectsWorkbook(
    workbook({
      extra: Array.from({ length: 5 }, (_, i) => [
        `extra/${i}.xml`,
        Buffer.alloc(950_000, 32),
      ]),
    }),
    /4 MiB|total|expan/i,
  );
  await rejectsWorkbook(
    workbook({ extra: [["xl/workbook.xml", "<x/>"]] }),
    /duplicate/i,
  );
  await rejectsWorkbook(
    workbook({ extra: [["../escape.xml", "<x/>"]] }),
    /path|relative/i,
  );
  const corrupt = zip([["xl/workbook.xml", "<workbook/>", { stored: true }]]);
  corrupt[30 + Buffer.byteLength("xl/workbook.xml") + 1] ^= 1;
  await rejectsWorkbook(corrupt, /CRC|integrity/i);
});

test("XLSX rejects sparse coordinate expansion, excess columns and missing/duplicate headers", async () => {
  for (const [xml, pattern] of [
    [table([text("A1", "a"), num("A10002", "1")]), /row|10,000/i],
    [table([text("A1", "a"), num("GS2", "1")]), /column|200/i],
    [
      `<worksheet xmlns="${NS}"><sheetData><row r="1">${text("A1", "a")}</row><row r="252">${num("GR252", "1")}</row></sheetData></worksheet>`,
      /cell|50,000/i,
    ],
    [table([text("B1", "b"), num("B2", "1")]), /empty column|header/i],
    [
      table([
        text("A1", "A") + text("B1", " a "),
        num("A2", "1") + num("B2", "2"),
      ]),
      /duplicate/i,
    ],
    [table([text("A1", "a")]), /header.*data|data row/i],
  ])
    await rejectsWorkbook(workbook({ sheets: [["Data", xml]] }), pattern);
});

test("XLSX dates require review; exact text dates stay text and missing cells stay empty", async () => {
  const styles = `<styleSheet xmlns="${NS}"><cellXfs count="1"><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const rels = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="style" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  await rejectsWorkbook(
    workbook({
      sheets: [["Data", table([text("A1", "Date"), num("A2", "60", 's="0"')])]],
      overrides: {
        "xl/styles.xml": styles,
        "xl/_rels/workbook.xml.rels": rels,
      },
    }),
    /date/i,
    "DATE_REVIEW_REQUIRED",
  );
  const result = await xlsx(
    workbook({
      sheets: [
        [
          "Data",
          table([
            text("A1", "Code") + text("B1", "Note"),
            text("A2", "0001"),
            text("A3", "=SUM(A1)") + text("B3", 'a,"b"\nnext'),
          ]),
        ],
      ],
    }),
  );
  assert.equal(
    result.normalizedContent,
    'Code,Note\n0001,\n=SUM(A1),"a,""b""\nnext"\n',
  );
  assert.equal(result.columns[1].required, false);
});
