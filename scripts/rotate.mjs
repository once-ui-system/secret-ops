#!/usr/bin/env node
/**
 * Rotate one target: new value -> Vercel preview -> redeploy + smoke ->
 * Vercel production -> redeploy + smoke. Stops before revoking anything;
 * revoke.mjs does that in a separately approved run.
 *
 *   node scripts/rotate.mjs <target> [--dry-run]
 *
 * Env: VERCEL_TOKEN, VERCEL_TEAM_ID, SUPABASE_ACCESS_TOKEN (supabase
 * sources), INCOMING_SECRET (manual sources), VERCEL_BYPASS_<PROJECT>
 * (optional, protection bypass for smoke requests).
 */
import { appendFileSync } from "node:fs";
import { vercelClient } from "./lib/vercel.mjs";
import { supabaseClient, rotationKeyName } from "./lib/supabase.mjs";
import { stagePreview, promoteProduction, dryRunStore } from "./lib/stage.mjs";
import { loadTargets, getTarget, generateSecret, manualSecret } from "./lib/targets.mjs";
import { smoke } from "./lib/smoke.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const id = args.find((a) => !a.startsWith("--"));
if (!id) {
  console.error("usage: rotate.mjs <target> [--dry-run]");
  process.exit(2);
}

const summary = [];
const log = (line) => {
  console.log(line);
  summary.push(`- ${line}`);
};
const mask = (value) => {
  // GitHub replaces masked strings with *** in every later log line.
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value}`);
};

async function newValue(target) {
  const src = target.source;
  if (src.type === "generated") return { value: generateSecret(src.bytes) };
  if (src.type === "manual") return { value: manualSecret(src) };
  if (src.type === "supabase") {
    if (dryRun) return { value: "dry-run-value", keyId: "(new key)", keyName: rotationKeyName() };
    const sb = supabaseClient({ token: need("SUPABASE_ACCESS_TOKEN") });
    const before = await sb.listKeys(src.ref);
    const key = await sb.createSecretKey(src.ref, rotationKeyName());
    const older = before.filter((k) => k.type === "secret" && k.id !== key.id).map((k) => `${k.id} (${k.name})`);
    return { value: key.value, keyId: key.id, keyName: key.name, older };
  }
  throw new Error(`unknown source type ${src.type}`);
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const target = getTarget(loadTargets(), id);
  const vercel = vercelClient({ token: need("VERCEL_TOKEN"), teamId: need("VERCEL_TEAM_ID") });
  // One store per destination for the whole run, so a dry run's simulated
  // preview step is visible to its production step.
  const stores = new Map(
    target.destinations.map((d) => {
      const s = d.shared ? vercel.sharedStore(d.projectId) : vercel.projectStore(d.project);
      return [d, dryRun ? dryRunStore(s) : s];
    }),
  );
  const store = (d) => stores.get(d);
  const projects = [...new Set(target.destinations.map((d) => d.project))];

  log(`target ${id}${dryRun ? " (dry run)" : ""}: ${target.destinations.map((d) => `${d.project}:${d.key}`).join(", ")}`);
  const fresh = await newValue(target);
  mask(fresh.value);
  if (fresh.keyId) log(`new Supabase key ${fresh.keyName} (${fresh.keyId})`);

  // 1. Preview
  const created = [];
  for (const d of target.destinations) {
    created.push({ d, newId: await stagePreview(store(d), { key: d.key, value: fresh.value, log }) });
  }
  for (const p of projects) {
    if (dryRun) {
      log(`would redeploy ${p} preview and smoke test`);
      continue;
    }
    const dep = await vercel.redeploy(p, { target: "preview", branch: target.previewBranch });
    if (!dep) {
      log(`${p} has no preview deployments (builds main only): preview check skipped, production redeploy is the test`);
      continue;
    }
    log(`${p} preview redeployed: ${dep.url}`);
    await smoke(dep.url, target.smoke, { project: p, log });
  }

  // 2. Production, only after every preview passed
  for (const { d, newId } of created) {
    await promoteProduction(store(d), { key: d.key, newId, log });
  }
  for (const p of projects) {
    if (dryRun) {
      log(`would redeploy ${p} production and smoke test`);
      continue;
    }
    const dep = await vercel.redeploy(p, { target: "production" });
    log(`${p} production redeployed: ${dep.url}`);
    await smoke(dep.url, target.smoke, { project: p, log });
  }

  // 3. What revoke needs
  if (target.source.type === "supabase") {
    const older = fresh.older?.length ? fresh.older.join(", ") : "none";
    log(`old secret keys still valid: ${older}. Legacy service_role (if used before) stays until legacy keys are disabled.`);
    log(`to revoke: run "Revoke old key" with target ${id} and the key ids above`);
  } else if (target.source.type === "manual") {
    log(`now expire the old key in the provider dashboard (${target.source.dashboard || "provider"})`);
  } else {
    log(`old value is gone from Vercel; nothing to revoke`);
  }
}

main()
  .catch((err) => {
    log(`FAILED: ${err.message}. Production is only changed after preview passes; check the steps above.`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Rotate ${id}\n${summary.join("\n")}\n`);
  });
