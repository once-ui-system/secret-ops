import { request } from "./http.mjs";

const API = "https://api.supabase.com";

/**
 * Supabase Management API, authenticated with a personal access token.
 * Only the new API keys (sb_secret_...) are created and revoked here. The
 * legacy service_role JWT can't be rotated per key: once every app uses a
 * new secret key, disable legacy keys in the dashboard instead.
 */
export function supabaseClient({ token, fetchImpl }) {
  const call = (path, opts = {}) =>
    request(`${API}${path}`, { ...opts, headers: { authorization: `Bearer ${token}` }, fetchImpl });

  return {
    listProjects: () => call(`/v1/projects`),
    /** Key metadata only; values stay hidden. */
    listKeys: (ref) => call(`/v1/projects/${ref}/api-keys?reveal=false`),
    async createSecretKey(ref, name) {
      const key = await call(`/v1/projects/${ref}/api-keys?reveal=true`, {
        method: "POST",
        body: { type: "secret", name, description: "Created by secret-ops rotate workflow" },
      });
      if (!key?.api_key) throw new Error(`Supabase returned no key value for ${ref}`);
      return { id: key.id, name: key.name, value: key.api_key };
    },
    deleteKey: (ref, id) => call(`/v1/projects/${ref}/api-keys/${id}?reason=${encodeURIComponent("rotated by secret-ops")}`, { method: "DELETE" }),
  };
}

/** Lowercase, digits and underscores, which Supabase accepts as a key name. */
export function rotationKeyName(now = new Date()) {
  const s = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `rot_${s}`;
}
