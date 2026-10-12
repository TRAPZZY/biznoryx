import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

async function nativeHarness({ token = "a".repeat(43), responses = [] } = {}) {
  const records = new Map(token ? [["session", token]] : []);
  const calls = [];
  const listeners = new Map();
  const state = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    CapacitorHttp: { async request(input) { calls.push(input); const next = responses.shift(); return typeof next === "function" ? next(input) : next; } },
    App: { async addListener(name, handler) { listeners.set(name, handler); }, async minimizeApp() {} },
    Browser: {}, Filesystem: {}, Directory: { Cache: "CACHE" }, Share: {}, Purchases: {}, KeychainAccess: {},
    SecureStorage: {
      async setKeyPrefix() {}, async setSynchronize() {}, async setDefaultKeychainAccess() {},
      async get(key) { return records.get(key); }, async set(key, value) { records.set(key, value); },
      async remove(key) { records.delete(key); }, async clear() { records.clear(); },
    },
  };
  const key = "__nativeSessionTest" + Math.random().toString(36).slice(2);
  globalThis[key] = state;
  const bundled = await build({ entryPoints: ["mobile/native-entry.js"], bundle: true, write: false, format: "esm", platform: "node",
    define: { __BIZNORYX_MOBILE_CONFIG__: JSON.stringify({ apiOrigin: "https://biznoryx.example" }) },
    plugins: [{ name: "native-test-doubles", setup(plugin) {
      plugin.onResolve({ filter: /^@/ }, args => ({ path: args.path, namespace: "native-double" }));
      plugin.onResolve({ filter: /web-app\/app\.js$/ }, () => ({ path: "web-app", namespace: "app-double" }));
      plugin.onLoad({ filter: /.*/, namespace: "native-double" }, () => ({ contents: `export const {Capacitor,CapacitorHttp,App,Browser,Filesystem,Directory,Share,SecureStorage,KeychainAccess,Purchases}=globalThis[${JSON.stringify(key)}];` }));
      plugin.onLoad({ filter: /.*/, namespace: "app-double" }, () => ({ contents: "export {};" }));
    } }],
  });
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = { dispatchEvent() {} };
  globalThis.document = { body: { classList: { add() {} } }, addEventListener() {}, querySelector() { return {}; } };
  try {
    await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
    return { native: globalThis.window.biznoryxNative, records, calls, listeners, storage: state.SecureStorage,
      http: state.CapacitorHttp, filesystem: state.Filesystem, share: state.Share };
  } finally {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
    delete globalThis[key];
  }
}

test("native session expiry reported by session endpoint clears protected token but preserves scoped drafts", async () => {
  const harness = await nativeHarness({ responses: [{ status: 200, data: { authenticated: false } }, { status: 200, data: {} }] });
  harness.records.set("draft:user-a:org-a", "saved draft");
  await harness.native.request("session");
  assert.equal(harness.records.has("session"), false);
  assert.equal(harness.records.get("draft:user-a:org-a"), "saved draft");
  await harness.native.request("session");
  assert.equal(harness.calls[1].headers.Authorization, undefined);
});

test("native authentication refuses a late login response after explicit sign out", async () => {
  let completeLogin;
  const harness = await nativeHarness({ responses: [() => new Promise(resolve => { completeLogin = resolve; }), { status: 200, data: {} }] });
  const login = harness.native.request("sign-in", { email: "owner@example.com" });
  await harness.native.request("sign-out", {});
  completeLogin({ status: 200, data: { sessionToken: "b".repeat(43), authenticated: true } });
  await assert.rejects(login, /session changed/i);
  assert.equal(harness.records.has("session"), false);
});

test("native login persists only valid credentials and strips them from frontend responses", async () => {
  const harness = await nativeHarness({ token: null, responses: [
    { status: 200, data: { sessionToken: "b".repeat(43), authenticated: true } },
    { status: 200, data: { sessionToken: "bad-token" } },
  ] });
  const result = await harness.native.request("sign-in", {});
  assert.equal(result.sessionToken, undefined);
  assert.equal(harness.records.get("session"), "b".repeat(43));
  await assert.rejects(harness.native.request("sign-in", {}), /invalid session credential/i);
  assert.equal(harness.records.get("session"), "b".repeat(43));
});

test("native restart uses protected token; revocation clears it without erasing another scoped draft", async () => {
  const harness = await nativeHarness({ responses: [{ status: 401, data: { error: "SESSION_INVALID", message: "Session is not active." } }] });
  harness.records.set("draft:user-a:org-a", "draft-a");
  harness.records.set("draft:user-b:org-b", "draft-b");
  await assert.rejects(harness.native.request("dashboard"), /not active/);
  assert.equal(harness.calls[0].headers.Authorization, "Bearer " + "a".repeat(43));
  assert.equal(harness.records.has("session"), false);
  await assert.rejects(harness.native.loadDraftSnapshot("user-b:org-b"), /Sign in again/);
  assert.equal(harness.records.get("draft:user-b:org-b"), "draft-b");
});

test("native storage failure cannot leave a falsely persisted login", async () => {
  const harness = await nativeHarness({ token: null, responses: [
    { status: 200, data: { sessionToken: "b".repeat(43), authenticated: true } },
    { status: 200, data: {} },
  ] });
  harness.storage.set = async () => { throw new Error("device store unavailable"); };
  await assert.rejects(harness.native.request("sign-in", {}), /protected storage/);
  await harness.native.request("session");
  assert.equal(harness.calls[1].headers.Authorization, undefined);
  assert.equal(harness.records.has("session"), false);
});

test("native malformed responses fail visibly and invalid cached credentials are removed", async () => {
  const harness = await nativeHarness({ token: "invalid", responses: [{ status: 200, data: "not-json" }] });
  assert.equal(harness.records.has("session"), false);
  await assert.rejects(harness.native.request("session"), /unreadable response/);
  assert.equal(harness.calls[0].headers.Authorization, undefined);
});

test("native organization switching rejects responses from the previous organization", async () => {
  let finishDashboard;
  const harness = await nativeHarness({ responses: [
    () => new Promise(resolve => { finishDashboard = resolve; }),
    { status: 200, data: { organizationId: "org-b" } },
  ] });
  const dashboard = harness.native.request("dashboard");
  await harness.native.request("organizations/switch", { organizationId: "org-b" });
  finishDashboard({ status: 200, data: { organizationId: "org-a" } });
  await assert.rejects(dashboard, /session changed/i);
  assert.equal(harness.records.get("session"), "a".repeat(43));
});

test("native export cannot write or share a report delivered after sign out", async () => {
  let finishExport;
  const harness = await nativeHarness({ responses: [{ status: 200, data: {} }] });
  let writes = 0;
  let shares = 0;
  harness.http.get = () => new Promise(resolve => { finishExport = resolve; });
  harness.filesystem.writeFile = async () => { writes++; return { uri: "file://report" }; };
  harness.filesystem.deleteFile = async () => {};
  harness.share.share = async () => { shares++; };
  const pending = harness.native.exportReport({ path: "evidence-report?format=pdf", filename: "report.pdf" });
  await harness.native.request("sign-out", {});
  finishExport({ status: 200, data: "report-bytes" });
  await assert.rejects(pending, /session changed/i);
  assert.equal(writes, 0);
  assert.equal(shares, 0);
});

test("native export clears the cached file if organization changes during a write", async () => {
  let finishWrite;
  const harness = await nativeHarness({ responses: [{ status: 200, data: { organizationId: "org-b" } }] });
  let written;
  let removed;
  let shares = 0;
  harness.http.get = async () => ({ status: 200, data: "report-bytes" });
  harness.filesystem.writeFile = input => { written = input; return new Promise(resolve => { finishWrite = resolve; }); };
  harness.filesystem.deleteFile = async input => { removed = input; };
  harness.share.share = async () => { shares++; };
  const pending = harness.native.exportReport({ path: "evidence-report?format=pdf", filename: "report.pdf" });
  await new Promise(resolve => setImmediate(resolve));
  await harness.native.request("organizations/switch", { organizationId: "org-b" });
  finishWrite({ uri: "file://report" });
  await assert.rejects(pending, /session changed/i);
  assert.equal(shares, 0);
  assert.deepEqual(removed, { path: written.path, directory: "CACHE" });
});

test("native successful report exports use isolated cache paths and clean up after sharing", async () => {
  const harness = await nativeHarness();
  const written = [];
  const shared = [];
  const removed = [];
  harness.http.get = async input => {
    assert.equal(input.headers.Authorization, "Bearer " + "a".repeat(43));
    return { status: 200, data: "report-bytes" };
  };
  harness.filesystem.writeFile = async input => { written.push(input); return { uri: "file://" + input.path }; };
  harness.filesystem.deleteFile = async input => { removed.push(input); };
  harness.share.share = async input => { shared.push(input); };
  await Promise.all([1, 2].map(() => harness.native.exportReport({ path: "evidence-report?format=pdf", filename: "report.pdf" })));
  assert.notEqual(written[0].path, written[1].path);
  for (let index = 0; index < 2; index++) {
    assert.match(written[index].path, /^[0-9a-f-]{36}-report\.pdf$/);
    assert.equal(written[index].data, "report-bytes");
    assert.deepEqual(shared[index].files, ["file://" + written[index].path]);
    assert.deepEqual(removed[index], { path: written[index].path, directory: "CACHE" });
  }
});
