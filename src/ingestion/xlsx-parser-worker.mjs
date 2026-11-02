import { createRequire } from "node:module";
import { dirname, resolve, posix } from "node:path";
import { crc32 } from "node:zlib";
import { normalizeTabularUpload } from "./tabular-upload.mjs";
import { AuthError } from "../auth/core.mjs";

const require = createRequire(import.meta.url);
const MiB = 1024 * 1024;
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const STRICT = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const PACKAGE_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const STRICT_REL = "http://purl.oclc.org/ooxml/officeDocument/relationships/";

// Defense in depth in a disposable process, not a substitute for an OS/container
// RSS limit. The parent imposes a 24 MiB old-generation / 1 MiB semi-space cap.
// Native buffers are bounded by original (2 MiB), inflated archive (4 MiB), entry
// (2 MiB) and output (4 MiB) limits. Checkpoints stop above 64 MiB RSS but cannot
// interrupt synchronous native allocation; deployment still needs an OS cap.
const memoryWatch = setInterval(() => {
  checkMemory();
}, 25);
memoryWatch.unref();

if (process.send)
  process.once("message", async ({ bytes, sheet } = {}) => {
    let message;
    try {
      const result = await readWorkbook(bytes, sheet);
      message = { ok: true, result };
    } catch (error) {
      message = {
        ok: false,
        code:
          error instanceof AuthError
            ? error.code
            : error?.code === "MODULE_NOT_FOUND"
              ? "UPLOAD_PARSER_UNAVAILABLE"
              : "VALIDATION_FAILED",
        message:
          error instanceof AuthError
            ? error.message
            : error?.code === "MODULE_NOT_FOUND"
              ? "The XLSX parser dependencies are unavailable."
              : "The XLSX workbook or XML is malformed or unsupported.",
        ...(error?.sheets ? { sheets: error.sheets } : {}),
      };
    }
    clearInterval(memoryWatch);
    process.send(message, () => process.disconnect());
  });

async function readWorkbook(bytes, requestedSheet) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 2 * MiB)
    fail("XLSX exceeds the 2 MiB original file limit or is empty.");
  if (bytes.readUInt32LE(0) !== 0x04034b50)
    fail("Only unencrypted XLSX ZIP workbooks are supported.");
  const yauzl = require("yauzl");
  const { SaxesParser } = require("saxes");
  checkMemory();
  const entries = await boundedArchive(bytes, yauzl);
  const state = {
    sheets: [],
    relationships: new Map(),
    worksheetInfo: new Map(),
    roots: new Map(),
    contentType: false,
  };
  for (const [path, data] of entries)
    inspectXml(path, data, SaxesParser, state);
  for (const path of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
  ]) {
    if (!entries.has(path))
      fail("The XLSX workbook is missing a required package part.");
  }
  if (!state.contentType || !state.sheets.length)
    fail("The XLSX workbook does not contain a supported worksheet.");
  const roots = state.relationships.get("_rels/.rels");
  if (
    !roots ||
    ![...roots.values()].some(
      (r) => r.target === "xl/workbook.xml" && /\/officeDocument$/.test(r.type),
    )
  )
    fail("The XLSX workbook relationship is missing.");
  // Inspect ALL sheets, not just the selected one. Bound sparse rectangular
  // allocation before read-excel-file can fill coordinate gaps with nulls.
  let denseCells = 0;
  for (const info of state.worksheetInfo.values()) {
    denseCells += Math.max(0, info.maxRow - 1) * info.width;
    if (denseCells > 50_000)
      fail(
        "The workbook exceeds this runtime's limit of 50,000 XLSX data cells.",
      );
  }
  for (const [relsPath, relations] of state.relationships) {
    const base =
      relsPath === "_rels/.rels" ? "" : posix.dirname(posix.dirname(relsPath));
    for (const rel of relations.values()) {
      const target = rel.target.startsWith("/")
        ? rel.target.slice(1)
        : posix.join(base, rel.target);
      if (!entries.has(target))
        fail("A workbook relationship points to a missing package part.");
    }
  }
  const names = state.sheets.map((s) => s.name);
  let selectedSheet;
  if (requestedSheet === undefined) {
    if (names.length !== 1) {
      const error = new AuthError(
        "Select a sheet explicitly before uploading this workbook.",
        "SHEET_SELECTION_REQUIRED",
      );
      error.sheets = names;
      throw error;
    }
    selectedSheet = names[0];
  } else
    selectedSheet =
      typeof requestedSheet === "number"
        ? names[requestedSheet - 1]
        : requestedSheet;
  if (!names.includes(selectedSheet))
    fail("The selected sheet was not found in the workbook.");
  const workbookRels = state.relationships.get("xl/_rels/workbook.xml.rels");
  const seenTargets = new Set();
  let selectedInfo;
  for (const s of state.sheets) {
    const relation = workbookRels?.get(s.id);
    if (
      !relation ||
      ![`${DOCUMENT_REL}worksheet`, `${STRICT_REL}worksheet`].includes(
        relation.type,
      )
    )
      fail("Workbook sheet relationships are invalid.");
    // Match the maintained parser\'s documented package path resolution exactly.
    const target = relation.target.startsWith("/")
      ? relation.target.slice(1)
      : `xl/${relation.target}`;
    const info = state.worksheetInfo.get(target);
    if (!info || seenTargets.has(target))
      fail("Workbook sheet relationships are invalid or duplicated.");
    seenTargets.add(target);
    if (s.name === selectedSheet) selectedInfo = info;
  }
  // The parser never receives the hostile archive. Rebuild bounded, verified
  // entries with a maintained ZIP writer so local-vs-central-header differences,
  // hidden local entries and data descriptors cannot bypass the preflight.
  const { zipSync } = require("fflate");
  const { readSheet } = require("read-excel-file/node");
  const canonical = zipSync(Object.fromEntries(entries), { level: 0 });
  checkMemory();
  const data = await readSheet(
    Buffer.from(canonical.buffer, canonical.byteOffset, canonical.byteLength),
    selectedSheet,
    {
      trim: false,
      parseNumber: (numericText) => ({ numericText }),
    },
  );
  checkMemory();
  if (
    data.length < 2 ||
    data.length !== selectedInfo.maxRow ||
    data[0].length !== selectedInfo.width
  ) {
    fail(
      "The worksheet must contain a header and data rows without discarded trailing rows or columns.",
    );
  }
  const columnKinds = Array.from(
    { length: selectedInfo.width },
    () => new Set(),
  );
  let csvBytes = 0;
  const lines = [];
  const previewRows = [];
  for (let r = 0; r < data.length; r++) {
    if (r % 100 === 0) checkMemory();
    let recordBytes = 0;
    const values = data[r].map((value, c) => {
      if (r === 0 && typeof value !== "string")
        fail("The worksheet header must contain nonempty text column names.");
      if (value instanceof Date)
        throw new AuthError(
          "Excel date-valued cells require an approved date profile. Export dates as explicit ISO text or CSV.",
          "DATE_REVIEW_REQUIRED",
        );
      let text, kind;
      if (value === null) {
        text = "";
        kind = null;
      } else if (typeof value === "string") {
        text = value;
        kind = "text";
      } else if (typeof value === "boolean") {
        text = String(value);
        kind = "boolean";
      } else if (typeof value?.numericText === "string") {
        text = value.numericText;
        kind = "decimal";
      } else fail("The worksheet contains an unsupported value type.");
      if (text.includes("\0"))
        fail("Worksheet text cannot contain NUL characters.");
      recordBytes += Buffer.byteLength(text, "utf8");
      if (recordBytes > MiB)
        fail("An upload record exceeds the 1 MiB data limit.");
      if (r > 0 && kind !== null && text !== "") columnKinds[c].add(kind);
      return text;
    });
    if (r > 0 && r <= 5) previewRows.push(values);
    // Quote empty single-column rows too, preserving their worksheet positions.
    const line =
      values
        .map((v) =>
          /[",\r\n]|^\s|\s$/.test(v) || (v === "" && values.length === 1)
            ? `"${v.replaceAll('"', '""')}"`
            : v,
        )
        .join(",") + "\n";
    csvBytes += Buffer.byteLength(line, "utf8");
    if (csvBytes > 4 * MiB)
      fail("Normalized XLSX CSV exceeds this runtime's 4 MiB limit.");
    lines.push(line);
  }
  const normalized = await normalizeTabularUpload({
    fileName: "normalized.csv",
    content: lines.join(""),
  });
  normalized.columns = normalized.columns.map((column, i) => {
    const type = columnKinds[i].size === 1 ? [...columnKinds[i]][0] : "text";
    return { ...column, type, dataType: type };
  });
  return {
    normalizedContent: normalized.normalizedContent,
    columns: normalized.columns,
    rowCount: normalized.rowCount,
    sheets: names,
    selectedSheet,
    previewRows,
    previewRowNumbers: previewRows.map((_, i) => i + 2),
    rowConvention: { headerRow: 1, firstDataRow: 2, unit: "worksheet-row" },
    parserVersion: `tabular-upload/1;read-excel-file@${require("read-excel-file/package.json").version};yauzl@${require("yauzl/package.json").version};saxes@${require("saxes/package.json").version};fflate@${require(resolve(dirname(require.resolve("fflate")), "../package.json")).version}`,
  };
}

function boundedArchive(bytes, yauzl) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, archive) => {
        if (error)
          return reject(
            new AuthError(
              "The XLSX ZIP archive is malformed.",
              "VALIDATION_FAILED",
            ),
          );
        const entries = new Map(),
          names = new Set();
        let total = 0,
          count = 0,
          failed = false;
        const stop = (failure) => {
          if (failed) return;
          failed = true;
          archive.close();
          reject(
            failure instanceof AuthError
              ? failure
              : new AuthError(
                  "XLSX ZIP path, integrity or decompressed size is invalid.",
                  "VALIDATION_FAILED",
                ),
          );
        };
        archive.on("error", stop);
        archive.on("end", () => {
          if (!failed) resolve(entries);
        });
        archive.on("entry", (entry) => {
          if (failed) return;
          try {
            if (++count > 256 || archive.entryCount > 256)
              fail("The XLSX ZIP exceeds the limit of 256 archive entries.");
            const name = entry.fileName;
            if (entry.generalPurposeBitFlag & 0x41)
              fail("Encrypted XLSX archives are not supported.");
            if (/vba|macro|encryptedpackage|encryptioninfo/i.test(name))
              fail("Macros and encrypted workbook parts are not supported.");
            if (
              /externalLinks|connections|queryTables|embeddings|activeX|customXml/i.test(
                name,
              )
            )
              fail(
                "External links and active workbook content are not supported.",
              );
            if (
              name.length > 255 ||
              /[\\\x00-\x1f:%]/.test(name) ||
              name.startsWith("/") ||
              name
                .replace(/\/$/, "")
                .split("/")
                .some((p) => !p || p === "." || p === "..")
            )
              fail("The ZIP archive contains an invalid entry path.");
            if (names.has(name.toLowerCase()))
              fail("The ZIP archive contains duplicate entry paths.");
            names.add(name.toLowerCase());
            if (![0, 8].includes(entry.compressionMethod))
              fail("The ZIP compression method is unsupported.");
            if (entry.uncompressedSize > 2 * MiB)
              fail(
                "An XLSX ZIP entry exceeds the 2 MiB decompressed entry limit.",
              );
            // Count every decompressed byte, including parts the XLSX parser ignores.
            archive.openReadStream(entry, async (streamError, stream) => {
              if (streamError) return stop(streamError);
              try {
                const chunks = [];
                let size = 0,
                  checksum = 0;
                for await (const chunk of stream) {
                  size += chunk.length;
                  total += chunk.length;
                  if (size > 2 * MiB || total > 4 * MiB)
                    fail(
                      "The XLSX ZIP exceeds the 2 MiB entry or 4 MiB total decompressed expansion limit.",
                    );
                  checkMemory();
                  checksum = crc32(chunk, checksum);
                  chunks.push(chunk);
                }
                if (size !== entry.uncompressedSize || checksum !== entry.crc32)
                  fail(
                    "XLSX ZIP CRC integrity or decompressed size is invalid.",
                  );
                if (!name.endsWith("/")) {
                  if (!/\.(?:xml|rels)$/.test(name))
                    fail(
                      "Binary workbook parts are unsupported; upload a plain XLSX table.",
                    );
                  entries.set(name, Buffer.concat(chunks, size));
                }
                if (!failed) archive.readEntry();
              } catch (failure) {
                stream.destroy();
                stop(failure);
              }
            });
          } catch (failure) {
            stop(failure);
          }
        });
        archive.readEntry();
      },
    );
  });
}

function inspectXml(path, bytes, SaxesParser, state) {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    fail("XLSX XML DOCTYPE and entity declarations are unsupported.");
  if (
    path === "[Content_Types].xml" &&
    /macroEnabled|vbaProject|macrosheet/i.test(xml)
  )
    fail("Macro workbook content is unsupported.");
  const sheetFile = /^xl\/worksheets\/[^/]+\.xml$/.test(path);
  const info = {
    maxRow: 0,
    width: 0,
    row: 0,
    column: 0,
    cell: null,
    sheetData: 0,
  };
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let nodes = 0;
  parser.on("xmldecl", (d) => {
    if (d.encoding && !/^utf-?8$/i.test(d.encoding))
      fail("Workbook XML must use UTF-8.");
  });
  parser.on("opentag", (tag) => {
    const name = tag.local,
      parent = stack.at(-1);
    const attr = (key) => tag.attributes[key]?.value;
    if (++nodes > 2_000_000 || stack.length > 64)
      fail("Workbook XML exceeds its structure limit.");
    if (!stack.length) state.roots.set(path, name);
    if (["f", "formula", "definedName"].includes(name) || attr("t") === "str")
      fail(
        "Formula cells and named formulas, including cached results, are unsupported. Export values only.",
      );
    if (
      ["externalLink", "externalReference", "oleObject", "ddeLink"].includes(
        name,
      )
    )
      fail("External workbook links are unsupported.");
    if (["mergeCell", "AlternateContent", "extLst"].includes(name))
      fail(
        "Merged cells and extension content are unsupported; upload a plain table.",
      );
    if (
      path === "[Content_Types].xml" &&
      name === "Override" &&
      attr("PartName") === "/xl/workbook.xml" &&
      attr("ContentType") ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    )
      state.contentType = true;
    if (path.endsWith(".rels") && name === "Relationship") {
      if (tag.prefix || tag.uri !== PACKAGE_REL)
        fail("Workbook relationship XML is unsupported.");
      const id = attr("Id"),
        target = attr("Target"),
        type = attr("Type");
      if (
        !id ||
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(id) ||
        ["__proto__", "constructor", "prototype"].includes(id)
      )
        fail("Invalid workbook relationship identifier.");
      if (
        !target ||
        /[\\:\x00-\x1f%?#]/.test(target) ||
        target.startsWith("//") ||
        attr("TargetMode") === "External" ||
        /externalLink|hyperlink|vba|macro|oleObject|connection/i.test(
          type ?? "",
        )
      )
        fail(
          "External relationships and active workbook links are unsupported.",
        );
      if (attr("TargetMode") && attr("TargetMode") !== "Internal")
        fail("Unsupported workbook relationship mode.");
      const relations = state.relationships.get(path) ?? new Map();
      if (relations.has(id))
        fail("Duplicate workbook relationship identifier.");
      if (
        path === "xl/_rels/workbook.xml.rels" &&
        target.split("/").some((p) => p === ".." || p === ".")
      )
        fail("Unsupported workbook relationship path.");
      relations.set(id, { target, type });
      state.relationships.set(path, relations);
    }
    if (path === "xl/workbook.xml" && name === "sheet") {
      if (tag.prefix || ![MAIN, STRICT].includes(tag.uri))
        fail("Unsupported workbook sheet XML.");
      const sheetName = attr("name"),
        id = Object.values(tag.attributes).find(
          (a) => a.local === "id" && /\/relationships$/.test(a.uri),
        )?.value;
      if (
        !sheetName ||
        !id ||
        state.sheets.length >= 32 ||
        state.sheets.some(
          (s) =>
            s.name.toLowerCase() === sheetName.toLowerCase() || s.id === id,
        )
      )
        fail(
          "Workbook sheet names or identifiers are invalid or exceed 32 sheets.",
        );
      state.sheets.push({ name: sheetName, id });
    }
    if (sheetFile) {
      if (tag.prefix || ![MAIN, STRICT].includes(tag.uri))
        fail("Unsupported worksheet XML namespace.");
      if (name === "sheetData") {
        if (parent !== "worksheet" || ++info.sheetData !== 1)
          fail("Worksheet data structure is invalid.");
      } else if (name === "row") {
        if (parent !== "sheetData") fail("Worksheet row structure is invalid.");
        const row = integer(attr("r"), "row");
        if (row > 10_001)
          fail(
            "The worksheet exceeds this runtime's limit of 10,000 XLSX data rows.",
          );
        if (row <= info.maxRow)
          fail("Worksheet row coordinates are duplicated or out of order.");
        info.maxRow = info.row = row;
        info.column = 0;
      } else if (name === "c") {
        if (
          parent !== "row" ||
          !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(attr("r") ?? "")
        )
          fail("Worksheet cell coordinates are invalid.");
        const [, letters, rowText] = /^([A-Z]+)(\d+)$/.exec(attr("r"));
        const row = integer(rowText, "row");
        let column = 0;
        for (const letter of letters)
          column = column * 26 + letter.charCodeAt(0) - 64;
        if (row > 10_001)
          fail(
            "The worksheet exceeds this runtime's limit of 10,000 XLSX data rows.",
          );
        if (column > 200)
          fail("The worksheet exceeds the limit of 200 columns.");
        if (row !== info.row || column <= info.column)
          fail(
            "Worksheet cell coordinates conflict with their row or are duplicated.",
          );
        info.column = column;
        info.width = Math.max(info.width, column);
        if ((info.maxRow - 1) * info.width > 50_000)
          fail(
            "The worksheet exceeds this runtime's limit of 50,000 XLSX data cells.",
          );
        const type = attr("t") ?? "n";
        if (type === "d")
          throw new AuthError(
            "Excel date cells require an approved date profile. Export explicit ISO text or CSV.",
            "DATE_REVIEW_REQUIRED",
          );
        if (type === "e") fail("Worksheet error cells are unsupported.");
        if (!["n", "s", "inlineStr", "b"].includes(type))
          fail("Unsupported worksheet cell type.");
        info.cell = { type, text: "", values: 0 };
      } else if (name === "v") {
        if (parent !== "c" || !info.cell || ++info.cell.values > 1)
          fail("Worksheet cell values are malformed.");
      }
    }
    stack.push(name);
  });
  parser.on("text", (text) => {
    if (sheetFile && stack.at(-1) === "v" && info.cell) info.cell.text += text;
  });
  parser.on("cdata", () => {
    fail("Workbook XML CDATA is unsupported.");
  });
  parser.on("closetag", (tag) => {
    if (sheetFile && tag.local === "c") {
      const cell = info.cell;
      if (
        cell.type === "n" &&
        cell.text &&
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(cell.text)
      )
        fail("Worksheet numeric value is invalid.");
      info.cell = null;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (sheetFile) {
    if (state.roots.get(path) !== "worksheet" || info.sheetData !== 1)
      fail("Worksheet XML is invalid.");
    state.worksheetInfo.set(path, info);
  }
}

function integer(text, label) {
  if (!/^[1-9]\d{0,6}$/.test(text ?? ""))
    fail(`Worksheet ${label} coordinate is invalid.`);
  return Number(text);
}

function fail(message) {
  throw new AuthError(message, "VALIDATION_FAILED");
}

function checkMemory() {
  if (process.memoryUsage().rss > 64 * MiB) process.exit(72);
}
