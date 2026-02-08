async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const host = process.env.FIREBASE_HOSTING_EMULATOR_HOST || '127.0.0.1:5000';
  const base = `http://${host}`;

  let healthRes;
  for (let i = 0; i < 60; i++) {
    try {
      healthRes = await fetch(`${base}/api/health`);
      if (healthRes.ok) break;
    } catch {}
    await sleep(1000);
  }

  if (!healthRes || !healthRes.ok) {
    throw new Error(`Health endpoint not reachable via hosting emulator at ${base}`);
  }

  const health = await healthRes.json();
  const projectsRes = await fetch(`${base}/api/v1/projects`);
  const projects = await projectsRes.json();

  console.log(`hosting_base=${base}`);
  console.log(`health_status=${health.status}`);
  console.log(`projects_count=${Array.isArray(projects) ? projects.length : -1}`);
})();
