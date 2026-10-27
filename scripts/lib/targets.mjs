import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * targets.json names every rotatable secret. A target says where the new
 * value comes from (source) and which Vercel variables receive it
 * (destinations). The file holds ids and names only, never values.
 */
export function loadTargets(path = new URL("../../targets.json", import.meta.url)) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.targets;
}

export function getTarget(targets, id) {
  const t = targets[id];
  if (!t) throw new Error(`unknown target "${id}". Known: ${Object.keys(targets).sort().join(", ")}`);
  if (t.hold) throw new Error(`target "${id}" is on hold: ${t.hold}`);
  if (!t.destinations?.length) throw new Error(`target "${id}" has no destinations`);
  return t;
}

/** New random value for internal secrets (cron, state, bridge secrets). */
export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Value pasted by Lorant into the INCOMING_SECRET GitHub secret, for keys a
 * provider only rolls in its dashboard (Stripe). The prefix check stops a
 * test key or the wrong secret from reaching production.
 */
export function manualSecret(source, env = process.env) {
  const value = (env.INCOMING_SECRET || "").trim();
  if (!value) throw new Error("INCOMING_SECRET is empty: paste the rolled key into the repo secret first");
  if (source.prefix && !value.startsWith(source.prefix)) {
    throw new Error(`INCOMING_SECRET does not start with ${source.prefix}; refusing (wrong key pasted?)`);
  }
  return value;
}
