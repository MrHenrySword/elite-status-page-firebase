const HOSTING = process.env.FIREBASE_HOSTING_EMULATOR_HOST || '127.0.0.1:5000';
const BASE = `http://${HOSTING}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForOk(url, attempts = 75, delayMs = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function loadJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function runPerf(url, total = 200, concurrency = 20) {
  const latencies = [];
  let next = 0;

  async function worker() {
    while (true) {
      const id = next;
      next += 1;
      if (id >= total) return;
      const start = performance.now();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Perf request failed with ${res.status}`);
      await res.arrayBuffer();
      latencies.push(performance.now() - start);
    }
  }

  const startWall = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - startWall;

  latencies.sort((a, b) => a - b);
  return {
    requests: total,
    concurrency,
    durationMs,
    rps: (total / (durationMs / 1000)),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99)
  };
}

(async () => {
  await waitForOk(`${BASE}/api/health`);

  const home = await fetch(`${BASE}/`);
  const homeHtml = await home.text();
  assert(home.ok, 'Home route failed');
  assert(homeHtml.includes('/status-app.js'), 'Home page is not serving status-app.js');

  const appJs = await fetch(`${BASE}/status-app.js`);
  const appJsText = await appJs.text();
  assert(appJs.ok, 'status-app.js not served from hosting');
  assert(appJsText.includes('loadPublicSnapshotFromFirestore'), 'Client Firestore loader missing');

  const projectsResp = await loadJson(`${BASE}/api/v1/projects`);
  assert(projectsResp.res.ok, '/api/v1/projects failed');
  assert(Array.isArray(projectsResp.data) && projectsResp.data.length > 0, 'No projects returned');
  const slug = projectsResp.data[0].slug;

  const snapshotResp = await loadJson(`${BASE}/api/v1/projects/${slug}/public-snapshot`);
  assert(snapshotResp.res.ok, 'public-snapshot endpoint failed');
  assert(snapshotResp.data && Array.isArray(snapshotResp.data.components), 'Snapshot missing components');
  assert(snapshotResp.data.settings && typeof snapshotResp.data.settings === 'object', 'Snapshot missing settings');

  const projectPage = await fetch(`${BASE}/p/${encodeURIComponent(slug)}`);
  const projectHtml = await projectPage.text();
  assert(projectPage.ok, '/p/:slug route failed');
  assert(projectHtml.includes('/status-app.js'), '/p/:slug did not serve app shell');

  const subscribeEmail = `qa+${Date.now()}@example.com`;
  const subscribeResp = await loadJson(`${BASE}/api/v1/projects/${slug}/subscribers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: subscribeEmail })
  });
  assert(subscribeResp.res.status === 201 || subscribeResp.res.status === 409, 'Subscribe endpoint failed');

  const perf = await runPerf(`${BASE}/api/v1/projects/${slug}/public-snapshot`, 200, 20);

  console.log(`e2e_project_slug=${slug}`);
  console.log(`perf_requests=${perf.requests}`);
  console.log(`perf_concurrency=${perf.concurrency}`);
  console.log(`perf_duration_ms=${perf.durationMs.toFixed(2)}`);
  console.log(`perf_rps=${perf.rps.toFixed(2)}`);
  console.log(`perf_p50_ms=${perf.p50Ms.toFixed(2)}`);
  console.log(`perf_p95_ms=${perf.p95Ms.toFixed(2)}`);
  console.log(`perf_p99_ms=${perf.p99Ms.toFixed(2)}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
