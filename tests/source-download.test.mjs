import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AuthError } from "../src/auth/core.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { ObjectStorageError } from "../src/storage/s3-object-storage.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(43);
const csv = Buffer.from('product,revenue\r\n"Caf\u00e9, large",120.00\r\n"Quoted ""item""",-3.50\r\n');

async function fixture(work, { role = "viewer", storedBody = csv, storageError, byteSize = csv.length, fileName = "sales.csv", quarantine = false, storageGate } = {}) {
  const reads = [];
  const queries = [];
  const pool = { async connect() { return {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("from organization_memberships")) return { rows: role ? [{ role }] : [] };
      if (sql.includes("from ingestion_runs")) {
        assert.equal(values[1], "org-a");
        return { rows: quarantine || values[0] !== id ? [] : [{ id: "raw-a", organization_id: "org-a", storage_key: "org/org-a/raw/source.csv",
          original_filename: fileName, content_type: "text/csv", byte_size: byteSize,
          checksum_sha256: createHash("sha256").update(csv).digest("hex"), status: "accepted" }] };
      }
      return { rows: [] };
    }, release() {},
  }; } };
  const repository = new PostgresDataIngestionRepository(pool);
  const service = new ProductionIngestionService({ repository, objectStorage: {
    async getObject(input) { reads.push(input); if (storageGate) await storageGate; if (storageError) throw storageError; return { body: storedBody }; },
  } });
  const { server } = createProductionApp({
    identityRepository: {
      async authenticate({ token: supplied }) {
        if (supplied !== token) throw new AuthError("Sign in again.", "SESSION_INVALID");
        return { user: { id: "user-a", emailVerifiedAt: new Date() }, session: { id: "session-a", activeOrganizationId: "org-a" } };
      },
    },
    emailVerificationRepository: {}, ingestionService: service, production: false,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (uploadId = id, headers = { cookie: `bnx_session=${token}` }, query = "") =>
    fetch(`${base}/api/ingestion/uploads/${uploadId}/download${query}`, { headers });
  try { await work({ request, reads, queries, base, repository }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("source download returns saved bytes to a viewer without subscription access", async () => fixture(async ({ request, reads }) => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), csv);
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="sales.csv";/);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(reads, [{ key: "org/org-a/raw/source.csv" }]);
}));

test("native bearer downloads keep browser cookies and storage keys out of the response", async () => fixture(async ({ request }) => {
  const response = await request(id, { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` }, "?organizationId=org-b&storageKey=secret");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), csv);
}));

test("signed-out and invalid native credentials cannot read a source", async () => fixture(async ({ request, reads }) => {
  assert.equal((await request(id, {})).status, 401);
  assert.equal((await request(id, { "x-biznoryx-client": "mobile-v1", authorization: "Bearer invalid" })).status, 401);
  assert.equal(reads.length, 0);
}));

test("foreign and malformed upload IDs do not reach private storage", async () => fixture(async ({ request, reads, queries }) => {
  // The real repository must constrain both run and raw object to the active tenant.
  const clientQueries = queries.length;
  const malformed = await request("not-a-uuid");
  assert.equal(malformed.status, 404);
  assert.equal(queries.length, clientQueries);
  const response = await request(foreignId);
  assert.equal(response.status, 404);
  assert.equal(reads.length, 0);
}));

for (const role of [null, "disabled"]) {
  test(`source download rejects ${role ?? "missing"} membership before storage access`, async () => fixture(async ({ request, reads }) => {
    assert.equal((await request()).status, role ? 403 : 404);
    assert.equal(reads.length, 0);
  }, { role }));
}

test("quarantined data cannot be downloaded", async () => fixture(async ({ request, reads }) => {
  assert.equal((await request()).status, 404);
  assert.equal(reads.length, 0);
}, { quarantine: true }));

test("missing source objects show a recoverable not-found error", async () => fixture(async ({ request }) => {
  const response = await request();
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /org\/org-a|source\.csv/);
}, { storageError: new ObjectStorageError("private storage key", "OBJECT_NOT_FOUND") }));

for (const storedBody of [Buffer.from("corrupted"), Buffer.alloc(csv.length, 0)]) {
  test(`source integrity rejects corrupted bytes of length ${storedBody.length}`, async () => fixture(async ({ request }) => {
    assert.equal((await request()).status, 503);
  }, { storedBody }));
}

test("oversized source metadata is rejected before fetching bytes", async () => fixture(async ({ request, reads }) => {
  assert.equal((await request()).status, 503);
  assert.equal(reads.length, 0);
}, { byteSize: 26 * 1024 * 1024 }));

test("download filenames cannot inject headers or paths, and preserve Unicode", async () => fixture(async ({ request }) => {
  const response = await request();
  assert.equal(response.status, 200);
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.doesNotMatch(disposition, /[\r\n]|\.\.|\/|\\/);
  assert.ok(disposition.includes("caf%C3%A9"));
  assert.equal(response.headers.get("x-injected"), null);
}, { fileName: '../caf\u00e9\r\nX-injected: yes.csv' }));

test("simultaneous source reads are bounded and retry works after completion", async () => {
  let release;
  const storageGate = new Promise(resolve => { release = resolve; });
  await fixture(async ({ request, reads }) => {
    const first = request();
    try {
      for (let attempt = 0; reads.length < 1 && attempt < 200; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(reads.length, 1);
      assert.equal((await request()).status, 503);
    } finally { release(); await Promise.allSettled([first]); }
    const response = await first;
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), csv);
    assert.equal((await request()).status, 200);
  }, { storageGate });
});

test("disconnecting clients cannot bypass the in-flight storage read limit", async () => {
  let release;
  const storageGate = new Promise(resolve => { release = resolve; });
  await fixture(async ({ request, reads, base }) => {
    const controller = new AbortController();
    const abandoned = fetch(`${base}/api/ingestion/uploads/${id}/download`, {
      headers: { cookie: `bnx_session=${token}` }, signal: controller.signal,
    }).catch(error => error);
    try {
      for (let attempt = 0; reads.length < 1 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(reads.length, 1);
      controller.abort();
      await abandoned;
      // The next HTTP round trip observes the closed socket before admission.
      const third = await fetch(`${base}/api/ingestion/uploads/${id}/download`, {
        headers: { cookie: `bnx_session=${token}` }, signal: AbortSignal.timeout(500),
      }).catch(() => null);
      assert.equal(third?.status, 503);
    } finally { release(); await Promise.allSettled([abandoned]); }
    assert.equal((await request()).status, 200);
  }, { storageGate });
});
