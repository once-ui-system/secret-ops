#!/usr/bin/env node
/** CI check: targets.json and databases.json are well formed and hold no values. */
import { readFileSync } from "node:fs";
import { loadTargets } from "./lib/targets.mjs";

const SOURCES = new Set(["supabase", "generated", "manual"]);
const VALUE_LIKE = /((sk|rk)_(live|test)_|whsec_|sb_secret_|re_)[A-Za-z0-9]{12,}|eyJhbGci/;
const errors = [];
const targets = loadTargets();
for (const [id, t] of Object.entries(targets)) {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) errors.push(`${id}: id must be <app>/<secret>`);
  if (!SOURCES.has(t.source?.type)) errors.push(`${id}: unknown source.type`);
  if (t.source?.type === "supabase" && !/^[a-z]{20}$/.test(t.source.ref || "")) errors.push(`${id}: bad Supabase ref`);
  for (const d of t.destinations || []) {
    if (!d.project || !/^[A-Z][A-Z0-9_]*$/.test(d.key || "")) errors.push(`${id}: destination needs project and an UPPER_CASE key`);
    if (d.key?.startsWith("NEXT_PUBLIC_")) errors.push(`${id}: ${d.key} is public, not a secret`);
    if (d.shared && !d.projectId) errors.push(`${id}: shared destination needs projectId`);
  }
}
if (VALUE_LIKE.test(JSON.stringify(targets))) errors.push("targets.json looks like it contains a secret value");
const databases = JSON.parse(readFileSync(new URL("../databases.json", import.meta.url), "utf8"));
for (const [id, d] of Object.entries(databases)) {
  if (!/^[a-z0-9-]+$/.test(id)) errors.push(`databases.json ${id}: id must be lowercase`);
  if (!/^[a-z]{20}$/.test(d.ref || "")) errors.push(`databases.json ${id}: bad Supabase ref`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(d.repo || "") || !d.dir || typeof d.ordered !== "boolean") errors.push(`databases.json ${id}: needs repo, dir and ordered`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`targets.json ok (${Object.keys(targets).length} targets)`);
