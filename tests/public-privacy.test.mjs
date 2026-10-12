import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createProductionApp } from "../src/webapp/production-app.mjs";

test("privacy resources are public HTML with working local links and no authentication", async () => {
  const { server } = createProductionApp({
    identityRepository: { authenticate() { throw new Error("Public pages must not authenticate."); } },
    emailVerificationRepository: {},
    production: true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/privacy.html", "/account-deletion.html"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type"), /^text\/html/);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const html = await response.text();
      assert.match(html, /<html lang="en">/);
      assert.match(html, /BIZNORYX/);
      assert.doesNotMatch(html, /<script\b|<form\b|contenteditable/i);
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href.startsWith("#")) {
          assert.ok(html.includes(`id="${href.slice(1)}"`), href);
        } else {
          assert.ok(href.startsWith("/"), href);
          const linked = await fetch(new URL(href, origin));
          assert.equal(linked.status, 200, href);
          const fragment = new URL(href, origin).hash.slice(1);
          if (fragment) assert.ok((await linked.text()).includes(`id="${fragment}"`), href);
          else await linked.text();
        }
      }
      const head = await fetch(origin + path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("published notice describes current providers and support-assisted deletion, not unreleased mobile cleanup", () => {
  const privacy = readFileSync("web-app/privacy.html", "utf8");
  const deletion = readFileSync("web-app/account-deletion.html", "utf8");
  for (const provider of ["Northflank", "Resend", "Paystack", "3CX", "Google Fonts", "Unsplash"]) {
    assert.ok(privacy.includes(provider), provider);
  }
  assert.match(privacy, /support-assisted/);
  assert.match(privacy, /not automatically deleted/);
  assert.match(privacy, /not a guarantee/);
  assert.match(deletion, /without signing in/);
  assert.match(deletion, /does not itself delete/);
  assert.match(deletion, /does not itself cancel/);
  assert.doesNotMatch(privacy + deletion, /revoked immediately|private deletion reference|operating-system protected storage|cleanup completes/);
  assert.ok(readFileSync("web-app/help.html", "utf8").includes('href="/privacy.html"'));
});
