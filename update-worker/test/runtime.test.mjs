import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const release = { tag_name: 'v0.0.1', draft: false, prerelease: false,
  html_url: 'https://github.com/CorrectRoadH/Voices/releases/tag/v0.0.1',
  published_at: '2026-10-18T12:07:16Z', body: 'First release' };

function runtime(outboundService) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: '.cloudflare/output/v0/workers/default/bundle/index.js',
    compatibilityDate: '2026-10-01',
    bindings: { GITHUB_REPO: 'CorrectRoadH/Voices' },
    outboundService,
  }));
}

// @concord-implements docs/feature/updates/use-case/check-updates.md
test('built Worker fetches a release in workerd without forwarding client parameters', async () => {
  let requests = 0;
  const mf = runtime(async request => {
    requests++;
    assert.equal(request.url, 'https://api.github.com/repos/CorrectRoadH/Voices/releases?per_page=100&page=1');
    return Response.json([release]);
  });
  try {
    const response = await mf.dispatchFetch('https://worker.test/?instanceId=private-client-id&version=dev');
    assert.equal((await response.json()).latestVersion, '0.0.1');
    assert.equal(requests, 1);
  } finally { await mf.dispose(); }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
test('built Worker refuses upstream redirects in workerd', async () => {
  let requests = 0;
  const mf = runtime(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/' } });
  });
  try {
    const response = await mf.dispatchFetch('https://worker.test/');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    assert.equal(requests, 1);
  } finally { await mf.dispose(); }
});
