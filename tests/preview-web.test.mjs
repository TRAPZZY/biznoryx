import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewState } from '../src/preview/state.mjs';

test('preview state is honest about launch readiness boundaries', () => {
  const state = previewState();

  assert.equal(state.releaseState, 'controlled_beta_ready');
  assert.equal(state.productionTruth.status, 'not_public_production_launched');
  assert.ok(state.nextWork.some((item) => item.includes('real authenticated web app shell')));
});

test('preview page includes dashboard and launch readiness surfaces', () => {
  const html = readFileSync('web-preview/index.html', 'utf8');
  const css = readFileSync('web-preview/styles.css', 'utf8');
  const js = readFileSync('web-preview/app.js', 'utf8');

  assert.match(html, /Business Pulse/);
  assert.match(html, /Launch Readiness/);
  assert.match(css, /metrics-grid/);
  assert.match(js, /api\/preview-state/);
});
