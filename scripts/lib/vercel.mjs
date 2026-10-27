import { request } from "./http.mjs";

const API = "https://api.vercel.com";

/**
 * Vercel env access for one destination: a project's own variables, or the
 * team's shared variables linked to that project. Both expose the same
 * five operations so the staging logic in stage.mjs is written once.
 */
export function vercelClient({ token, teamId, fetchImpl }) {
  const auth = { authorization: `Bearer ${token}` };
  const call = (path, opts = {}) =>
    request(`${API}${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}`, { ...opts, headers: auth, fetchImpl });

  function projectStore(project) {
    const p = encodeURIComponent(project);
    return {
      label: `vercel:${project}`,
      async list(key) {
        const data = await call(`/v10/projects/${p}/env`);
        return (data.envs || [])
          .filter((e) => e.key === key)
          .map((e) => ({ id: e.id, targets: [...(e.target || [])], type: e.type, gitBranch: e.gitBranch || null }));
      },
      async create({ key, value, targets }) {
        const data = await call(`/v10/projects/${p}/env`, {
          method: "POST",
          body: { key, value, type: "sensitive", target: targets },
        });
        const created = data.created ? [].concat(data.created)[0] : data;
        return created.id;
      },
      updateTargets: (id, targets) => call(`/v9/projects/${p}/env/${id}`, { method: "PATCH", body: { target: targets } }),
      updateValue: (id, value) => call(`/v9/projects/${p}/env/${id}`, { method: "PATCH", body: { value, type: "sensitive" } }),
      remove: (id) => call(`/v9/projects/${p}/env/${id}`, { method: "DELETE" }),
    };
  }

  // PATCH /v1/env answers 200 even when an update fails; the failures are in data.failed.
  async function patchShared(id, update) {
    const data = await call(`/v1/env`, { method: "PATCH", body: { updates: { [id]: update } } });
    if (data.failed?.length) throw new Error(`shared env update ${id} failed: ${data.failed[0].error?.code || "unknown"}`);
    return data;
  }

  function sharedStore(projectId) {
    return {
      label: `vercel-shared:${projectId}`,
      async list(key) {
        const data = await call(`/v1/env?projectId=${encodeURIComponent(projectId)}`);
        return (data.data || [])
          .filter((e) => e.key === key)
          .map((e) => ({ id: e.id, targets: [...(e.target || [])], type: e.type, projectIds: e.projectId || [] }));
      },
      async create({ key, value, targets }) {
        const data = await call(`/v1/env`, {
          method: "POST",
          body: { evs: [{ key, value }], type: "sensitive", target: targets, projectId: [projectId] },
        });
        return data.created?.[0]?.id;
      },
      updateTargets: (id, targets) => patchShared(id, { target: targets }),
      updateValue: (id, value) => patchShared(id, { value, type: "sensitive" }),
      remove: (id) => call(`/v1/env`, { method: "DELETE", body: { ids: [id] } }),
    };
  }

  async function listProjects() {
    const data = await call(`/v9/projects?limit=100`);
    return data.projects || [];
  }

  async function listEnvMeta(project) {
    const data = await call(`/v10/projects/${encodeURIComponent(project)}/env`);
    return (data.envs || []).map((e) => ({ key: e.key, targets: e.target || [], type: e.type, gitBranch: e.gitBranch || null }));
  }

  async function listSharedMeta() {
    const data = await call(`/v1/env`);
    return (data.data || []).map((e) => ({ key: e.key, targets: e.target || [], type: e.type, projectIds: e.projectId || [] }));
  }

  /**
   * Redeploy the newest READY deployment for a target and wait for it.
   * Returns null when a project has no READY preview deployment.
   */
  async function redeploy(project, { target, branch, timeoutMs = 15 * 60_000, pollMs = 10_000 }) {
    const q = new URLSearchParams({ projectId: project, state: "READY", limit: "20" });
    if (target === "production") q.set("target", "production");
    const list = await call(`/v6/deployments?${q}`);
    const candidates = (list.deployments || []).filter((d) =>
      target === "production" ? d.target === "production" : d.target !== "production" && (!branch || d.meta?.githubCommitRef === branch),
    );
    const base = candidates[0];
    // Projects that only build main (ignored build step) have no preview to
    // redeploy; the caller skips the preview check for them.
    if (!base && target !== "production") return null;
    if (!base) throw new Error(`no READY production deployment found for ${project}`);
    const body = { name: project, deploymentId: base.uid, ...(target === "production" ? { target: "production" } : {}) };
    const dep = await call(`/v13/deployments?forceNew=1`, { method: "POST", body });
    const started = Date.now();
    for (;;) {
      const d = await call(`/v13/deployments/${dep.id}`);
      if (d.readyState === "READY") return { id: d.id, url: `https://${d.url}` };
      if (d.readyState === "ERROR" || d.readyState === "CANCELED") throw new Error(`redeploy ${dep.id} ended ${d.readyState}`);
      if (Date.now() - started > timeoutMs) throw new Error(`redeploy ${dep.id} timed out`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  return { projectStore, sharedStore, listProjects, listEnvMeta, listSharedMeta, redeploy };
}
