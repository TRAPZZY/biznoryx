import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CAPTURES, generateEvaluationFixtures } from '../scripts/generate-extraction-fixtures.mjs';

test('extraction evaluation fixtures remain local, synthetic and separate from answer keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'biznoryx-extraction-eval-'));
  try {
    const result = await generateEvaluationFixtures(root);
    assert.equal(result.captures, 9);
    const inputs = await readdir(join(root, 'inputs'));
    assert.equal(inputs.length, 9);
    assert.ok(inputs.every((name) => name.endsWith('.svg')));
    assert.deepEqual(await readdir(join(root, 'answers')), ['expected.json']);
    const truth = JSON.parse(await readFile(join(root, 'answers', 'expected.json'), 'utf8'));
    assert.equal(truth.captures.length, 9);
    assert.equal(truth.captures.find((c) => c.capture_id === '05-unclear-amount').amount_minor, null);
    assert.equal(truth.captures.find((c) => c.capture_id === '06-loan-repayment').include_in_sales, false);
    const duplicates = truth.captures.filter((c) => c.duplicate_group === 'same-event-107');
    assert.equal(duplicates.length, 2);
    assert.equal(duplicates[0].transaction_id, duplicates[1].transaction_id);
    const first = await readFile(join(root, 'inputs', '07-duplicate-first.svg'), 'utf8');
    const second = await readFile(join(root, 'inputs', '08-duplicate-second.svg'), 'utf8');
    assert.notEqual(first, second, 'duplicate captures must have distinct source bytes');
    assert.doesNotMatch(first + second, /duplicate_group|duplicate_of|amount_minor|expected.json/);
    assert.equal(CAPTURES.length, new Set(CAPTURES.map((c) => c.id)).size);
    const before = await Promise.all(inputs.map((f) => readFile(join(root, 'inputs', f), 'utf8')));
    await generateEvaluationFixtures(root);
    const after = await Promise.all(inputs.map((f) => readFile(join(root, 'inputs', f), 'utf8')));
    assert.deepEqual(before, after, 'generator must be deterministic');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
===END TEST===