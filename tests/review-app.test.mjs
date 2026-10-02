import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createReviewApp } from '../src/webapp/review-app.mjs';

test('review app protects dashboard behind an authenticated session', async () => {
  const app = createReviewApp();
  const baseUrl = await listen(app.server);
  try {
    const response = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(response.status, 401);
  } finally {
    await close(app.server);
  }
});

test('review app signs in and returns tenant-scoped dashboard state', async () => {
  const app = createReviewApp();
  const baseUrl = await listen(app.server);
  try {
    const signedIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(app.runtime.reviewAccount)
    });
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get('set-cookie');
    const session = await signedIn.json();
    const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    const body = await dashboard.json();
    assert.equal(body.shell.activeOrganization.name, 'Acme Retail Group');
    assert.deepEqual(body.series, []);
    assert.deepEqual(body.uploads, []);
    assert.equal(session.shell.state, 'ready');
  } finally {
    await close(app.server);
  }
});

test('review app password recovery resets credentials and revokes prior sessions', async () => {
  const app = createReviewApp();
  const baseUrl = await listen(app.server);

  try {
    const signedIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(app.runtime.reviewAccount)
    });
    const oldCookie = signedIn.headers.get('set-cookie');

    const requested = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: app.runtime.reviewAccount.email })
    });
    assert.equal(requested.status, 202);
    const reset = await requested.json();
    assert.match(reset.reviewCode, /^\d{8}$/);

    const confirmed = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: app.runtime.reviewAccount.email,
        code: reset.reviewCode,
        newPassword: 'ReplacementPassword2026!'
      })
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).reset, true);

    const oldSession = await fetch(`${baseUrl}/api/session`, {
      headers: { cookie: oldCookie }
    });
    assert.equal(oldSession.status, 401);

    const newSignIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: app.runtime.reviewAccount.email,
        password: 'ReplacementPassword2026!'
      })
    });
    assert.equal(newSignIn.status, 200);

    const reusedCode = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: app.runtime.reviewAccount.email,
        code: reset.reviewCode,
        newPassword: 'AnotherReplacementPassword2026!'
      })
    });
    assert.equal(reusedCode.status, 400);
  } finally {
    await close(app.server);
  }
});

test('review app requires CSRF for tenant mutations', async () => {
  const app = createReviewApp();
  const baseUrl = await listen(app.server);
  try {
    const signedIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(app.runtime.reviewAccount)
    });
    const cookie = signedIn.headers.get('set-cookie');
    const noCsrf = await fetch(`${baseUrl}/api/onboarding/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ industry: 'Retail', model: 'Stores' })
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await close(app.server);
  }
});

test('review app blocks organization switching IDOR attempts', async () => {
  const app = createReviewApp();
  const outsider = app.runtime.identity.createUser({
    email: 'outsider@example.com',
    displayName: 'Outsider',
    password: 'OutsiderPassphrase2026!'
  });
  const outsiderOrg = app.runtime.organizations.createOrganization({
    name: 'Outsider Org',
    slug: 'outsider-org',
    actorUserId: outsider.id
  }).organization;
  const baseUrl = await listen(app.server);
  try {
    const signedIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(app.runtime.reviewAccount)
    });
    const cookie = signedIn.headers.get('set-cookie');
    const session = await signedIn.json();
    const switched = await fetch(`${baseUrl}/api/organizations/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, cookie },
      body: JSON.stringify({ organizationId: outsiderOrg.id })
    });
    assert.equal(switched.status, 404);
  } finally {
    await close(app.server);
  }
});

test('review app binds a slow upload to the organization authorized at request start', async () => {
  const app = createReviewApp();
  const [firstOrganizationId, secondOrganizationId] = app.runtime.seededOrganizations;
  const baseUrl = await listen(app.server);
  try {
    const signedIn = await fetch(`${baseUrl}/api/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(app.runtime.reviewAccount)
    });
    const cookie = signedIn.headers.get('set-cookie');
    const session = await signedIn.json();
    const uploadBody = JSON.stringify({
      fileName: 'january.csv',
      period: '2026-01',
      content: 'revenue\n100.00\n'
    });
    const pendingUpload = slowPost({
      url: `${baseUrl}/api/ingestion/upload`,
      cookie,
      csrfToken: session.csrfToken,
      firstChunk: uploadBody.slice(0, 1)
    });

    await pendingUpload.started;
    const switched = await fetch(`${baseUrl}/api/organizations/switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
        cookie
      },
      body: JSON.stringify({ organizationId: secondOrganizationId })
    });
    assert.equal(switched.status, 200);

    const uploadResponse = await pendingUpload.finish(uploadBody.slice(1));
    assert.equal(uploadResponse.status, 200);
    const upload = [...app.runtime.uploads.values()][0];
    assert.equal(upload.organizationId, firstOrganizationId);
    assert.notEqual(upload.organizationId, secondOrganizationId);
  } finally {
    await close(app.server);
  }
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function slowPost({ url, cookie, csrfToken, firstChunk }) {
  const parsed = new URL(url);
  let markStarted;
  let outgoing;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const response = new Promise((resolve, reject) => {
    outgoing = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        cookie,
        'Transfer-Encoding': 'chunked'
      }
    });
    outgoing.on('response', (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    outgoing.on('error', reject);
    outgoing.write(firstChunk, () => markStarted());
  });
  return {
    started,
    async finish(rest) {
      outgoing.end(rest);
      return response;
    }
  };
}
