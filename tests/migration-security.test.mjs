import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("migration gate permits SELECT policies but checks each writable policy independently", () => {
  const root = mkdtempSync(join(tmpdir(), "biznoryx-migration-security-"));
  const script = resolve("scripts/migration-check.mjs");
  try {
    mkdirSync(join(root, "db/migrations"), { recursive: true });
    mkdirSync(join(root, "db/bootstrap"), { recursive: true });
    writeFileSync(join(root, "db/bootstrap/runtime.sql"), "create role test_runtime nobypassrls;\n");
    writeFileSync(join(root, "db/migrations/0001_test.down.sql"), "begin; commit;\n");
    const readable = "create policy self_read on audit_events for select using (actor_user_id = current_user_id());";
    writeFileSync(join(root, "db/migrations/0001_test.sql"), `begin; ${readable} commit;\n`);
    assert.equal(spawnSync(process.execPath, [script], { cwd: root }).status, 0);
    const validWrite = "create policy safe_write on records for insert with check (organization_id = current_org_id());";
    const unsafeWrite = "create policy unsafe_write on records for update using (true);";
    writeFileSync(join(root, "db/migrations/0001_test.sql"), `begin; ${readable} ${validWrite} ${unsafeWrite} commit;\n`);
    const rejected = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /writable RLS policy without explicit WITH CHECK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
