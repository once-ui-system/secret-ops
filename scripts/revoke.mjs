#!/usr/bin/env node
/**
 * Revoke old Supabase secret keys after a rotation has been verified.
 *
 *   node scripts/revoke.mjs <target> <keyId,keyId> [--dry-run]
 *
 * Refuses to delete the newest secret key, which is the one the rotate run
 * just put in Vercel.
 */
import { appendFileSync } from "node:fs";
import { supabaseClient } from "./lib/supabase.mjs";
import { loadTargets, getTarget } from "./lib/targets.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [id, idList] = args.filter((a) => !a.startsWith("--"));
const lines = [];
const log = (l) => {
  console.log(l);
  lines.push(`- ${l}`);
};

export function pickRevocable(keys, requested) {
  const secrets = keys.filter((k) => k.type === "secret");
  const newest = [...secrets].sort((a, b) => String(b.inserted_at ?? "").localeCompare(String(a.inserted_at ?? "")))[0];
  return requested.map((rid) => {
    const k = secrets.find((s) => s.id === rid);
    if (!k) return { id: rid, ok: false, why: "not a secret key in this project" };
    if (newest && k.id === newest.id) return { id: rid, ok: false, why: "newest secret key, likely the one in use" };
    return { id: rid, ok: true, name: k.name };
  });
}

async function main() {
  if (!id || !idList) throw new Error("usage: revoke.mjs <target> <keyId,keyId> [--dry-run]");
  const target = getTarget(loadTargets(), id);
  if (target.source.type !== "supabase") throw new Error(`${id} is not a Supabase target; revoke it in the provider dashboard`);
  const sb = supabaseClient({ token: process.env.SUPABASE_ACCESS_TOKEN });
  const keys = await sb.listKeys(target.source.ref);
  for (const r of pickRevocable(keys, idList.split(",").map((s) => s.trim()).filter(Boolean))) {
    if (!r.ok) {
      log(`skip ${r.id}: ${r.why}`);
      continue;
    }
    if (dryRun) log(`would delete ${r.id} (${r.name})`);
    else {
      await sb.deleteKey(target.source.ref, r.id);
      log(`deleted ${r.id} (${r.name})`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => {
      log(`FAILED: ${e.message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Revoke ${id}\n${lines.join("\n")}\n`);
    });
}
