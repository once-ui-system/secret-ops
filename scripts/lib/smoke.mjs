/**
 * Requests each smoke path on a fresh deployment and fails on an
 * unexpected status. Deployments behind Vercel Authentication need the
 * project's protection bypass secret in VERCEL_BYPASS_<PROJECT> (dashes
 * become underscores); without it only the READY state is checked.
 */
export async function smoke(baseUrl, checks = [], { project, log = console.log, env = process.env, fetchImpl = fetch } = {}) {
  if (!checks.length) {
    log(`${project}: no smoke checks configured, deployment READY is the only check`);
    return;
  }
  const name = `VERCEL_BYPASS_${project.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  // In Actions the repo secrets arrive as one JSON blob (see rotate.yml).
  const bypass = env[name] || safeJson(env.ALL_SECRETS)[name];
  if (!bypass) {
    log(`${project}: no VERCEL_BYPASS secret, skipped HTTP smoke checks (deployment is READY)`);
    return;
  }
  for (const c of checks) {
    const url = new URL(c.path, baseUrl);
    const res = await fetchImpl(url, { headers: { "x-vercel-protection-bypass": bypass }, redirect: "manual" });
    const expect = [].concat(c.expect ?? 200);
    if (!expect.includes(res.status)) throw new Error(`smoke ${project} ${c.path}: got ${res.status}, expected ${expect.join("/")}`);
    log(`${project}: smoke ${c.path} ${res.status}`);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}
