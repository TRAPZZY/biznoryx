import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { createRawObjectIdentity } from "../src/ingestion/raw-object-identity.mjs";

function createHarness() {
  const objects = new Map();
  const registrations = [];
  const storage = {
    async headObject({ key }) {
      return { exists: objects.has(key) };
    },
    async putObject({ key, body }) {
      objects.set(key, Buffer.from(body));
    },
    async deleteObject({ key }) {
      objects.delete(key);
    },
  };
  const repository = {
    async ensureManualUploadSource() {
      return { id: "source-1" };
    },
    async ensureStream() {
      return { id: "stream-1" };
    },
    async registerRawUpload(input) {
      registrations.push(input);
      return { ingestionRun: { status: "validated" } };
    },
  };
  const service = new ProductionIngestionService({
    repository,
    objectStorage: storage,
  });
  return { service, repository, storage, objects, registrations };
}

function upload(service, content) {
  return service.upload({
    organizationId: "org-1",
    actorUserId: "user-1",
    fileName: "sales.csv",
    period: "2026-01",
    content,
  });
}

function table(columnCount, rowCount) {
  const header = Array.from(
    { length: columnCount },
    (_, index) => `column_${index}`,
  ).join(",");
  const row = Array(columnCount).fill("1").join(",") + "\n";
  return header + "\n" + row.repeat(rowCount);
}

const overBudgetInputs = [
  ["row", () => table(1, 50001), /50,000 data rows/],
  ["column", () => table(201, 1), /200 columns/],
  ["cell", () => table(21, 47620), /1,000,000 data cells/],
  [
    "empty cell",
    () =>
      Array.from({ length: 21 }, (_, index) => `column_${index}`).join(",") +
      "\n" +
      (",".repeat(20) + "\n").repeat(47620),
    /1,000,000 data cells/,
  ],
  [
    "record",
    () => "description\n" + "x".repeat(1024 * 1024 + 2) + "\n",
    /1 MiB/,
  ],
  [
    "record one byte over",
    () => "description\n" + "x".repeat(1024 * 1024 + 1) + "\n",
    /1 MiB/,
  ],
  [
    "quoted multiline record",
    () => 'description\n"' + "x\n".repeat(524289) + '"\n',
    /1 MiB/,
  ],
  [
    "multibyte record",
    () => "description\n" + "\u00e9".repeat(524289) + "\n",
    /1 MiB/,
  ],
];

for (const [name, content, message] of overBudgetInputs) {
  test(`CSV ${name} budget rejects input before registration or storage`, async () => {
    const harness = createHarness();
    await assert.rejects(upload(harness.service, content()), (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.match(error.message, message);
      return true;
    });
    assert.equal(harness.registrations.length, 0);
    assert.equal(harness.objects.size, 0);
  });
}

for (const [name, content, message] of overBudgetInputs.slice(0, 3)) {
  test(`CSV ${name} budget aborts before parsing a malformed remainder`, async () => {
    const harness = createHarness();
    await assert.rejects(
      upload(harness.service, content() + '"unterminated'),
      (error) => {
        assert.equal(error.code, "VALIDATION_FAILED");
        assert.match(error.message, message);
        return true;
      },
    );
    assert.equal(harness.objects.size, 0);
  });
}

test("CSV column budget stops a delimiter-only record before allocating its remainder", async () => {
  const harness = createHarness();
  await assert.rejects(
    upload(harness.service, "value\n" + ",".repeat(100000) + '"unterminated'),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.match(error.message, /200 columns/);
      return true;
    },
  );
  assert.equal(harness.objects.size, 0);
});

for (const [name, content, rows, columns] of [
  ["row", () => table(1, 50000), 50000, 1],
  ["column", () => table(200, 1), 1, 200],
  ["cell", () => table(20, 50000), 50000, 20],
  ["record", () => "description\n" + "x".repeat(1024 * 1024) + "\n", 1, 1],
]) {
  test(`CSV input exactly at the ${name} budget is registered without truncation`, async () => {
    const harness = createHarness();
    const contentText = content();
    await upload(harness.service, contentText);
    assert.equal(harness.registrations[0].upload.rowCount, rows);
    assert.equal(harness.registrations[0].upload.columns.length, columns);
    assert.equal(
      [...harness.objects.values()][0].toString("utf8"),
      contentText,
    );
  });
}

test("CSV budgets count logical records and preserve BOM, CRLF, quoted commas and newlines", async () => {
  const harness = createHarness();
  const content =
    '\ufeffproduct,revenue\r\n\r\n"A, quoted\r\ncontinued",10.10\r\nB,20.20\r\n';
  await upload(harness.service, content);
  const metadata = harness.registrations[0].upload;
  assert.equal(metadata.rowCount, 2);
  assert.deepEqual(metadata.columns, [
    { name: "product", type: "text", required: true },
    { name: "revenue", type: "decimal", required: true },
  ]);
  assert.equal([...harness.objects.values()][0].toString("utf8"), content);
});

test("CSV row amplification is rejected in a process with a bounded heap", () => {
  const moduleUrl = new URL(
    "../src/ingestion/production-ingestion-service.mjs",
    import.meta.url,
  ).href;
  const script = `
    import { ProductionIngestionService } from ${JSON.stringify(moduleUrl)};
    const service = new ProductionIngestionService({ repository: {}, objectStorage: {} });
    try {
      await service.upload({ organizationId: 'org-1', actorUserId: 'user-1',
        fileName: 'sales.csv', period: '2026-01', content: 'amount\\n' + '1\\n'.repeat(1000000) });
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== 'VALIDATION_FAILED' || !/50,000 data rows/.test(error.message)) process.exitCode = 1;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 100000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(
    result.status,
    0,
    "The parser must reject amplification without exhausting its heap.",
  );
});

test("two ingestion instances preserve the successful upload when duplicate registration loses the race", async () => {
  const harness = createHarness();
  let headCalls = 0;
  let releaseHeads;
  const bothHeads = new Promise((resolve) => {
    releaseHeads = resolve;
  });
  harness.storage.headObject = async ({ key }) => {
    const exists = harness.objects.has(key);
    if (++headCalls === 2) releaseHeads();
    await bothHeads;
    return { exists };
  };
  harness.repository.registerRawUpload = async (input) => {
    if (harness.registrations.length) {
      throw new AuthError(
        "This file has already been uploaded.",
        "VALIDATION_FAILED",
      );
    }
    harness.registrations.push(input);
    return { ingestionRun: { status: "validated" } };
  };
  const second = new ProductionIngestionService({
    repository: harness.repository,
    objectStorage: harness.storage,
  });
  const content = "product,revenue\nA,10.00\n";
  const results = await Promise.allSettled([
    upload(harness.service, content),
    upload(second, content),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(harness.registrations.length, 1);
  const identity = createRawObjectIdentity({
    organizationId: "org-1",
    originalFilename: "sales.csv",
    content,
  });
  const preserved = harness.objects.get(identity.storageKey);
  assert.ok(
    preserved,
    "Duplicate cleanup must not delete committed raw evidence.",
  );
  assert.equal(preserved.toString("utf8"), content);
  assert.equal(
    createHash("sha256").update(preserved).digest("hex"),
    identity.checksumSha256,
  );
});
