#!/usr/bin/env node
/**
 * Read-only inventory: Supabase projects and their API key metadata,
 * every Vercel project's variable names and environments, and the team's
 * shared variables. No values are requested. Writes inventory.md (and the
 * job summary in Actions) and flags secrets that are readable or reach
 * the Development environment.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { vercelClient } from "./lib/vercel.mjs";
import { supabaseClient } from "./lib/supabase.mjs";

const SECRETISH = /SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|_KEY$|DATABASE_URL|POSTGRES_URL/;

export function flag(v) {
  if (v.key.startsWith("NEXT_PUBLIC_") || !SECRETISH.test(v.key)) return "";
  const out = [];
  if (v.type !== "sensitive") out.push("not sensitive");
  if (v.targets.includes("development")) out.push("in development");
  return out.join(", ");
}

async function main() {
  const md = ["# Secret inventory", "", `Generated ${new Date().toISOString()}. Names only, no values.`, ""];
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    const sb = supabaseClient({ token: process.env.SUPABASE_ACCESS_TOKEN });
    md.push("## Supabase projects", "", "| Name | Ref | Keys (type: name) |", "|---|---|---|");
    for (const p of await sb.listProjects()) {
      let keys = "";
      try {
        keys = (await sb.listKeys(p.id || p.ref)).map((k) => `${k.type}: ${k.name}`).join("; ");
      } catch (e) {
        keys = `could not list (${e.status ?? e.message})`;
      }
      md.push(`| ${p.name} | ${p.id || p.ref} | ${keys} |`);
    }
    md.push("");
  }
  const vercel = vercelClient({ token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID });
  const projects = await vercel.listProjects();
  const byId = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  md.push("## Vercel project variables", "");
  for (const p of projects) {
    const envs = await vercel.listEnvMeta(p.name);
    if (!envs.length) continue;
    md.push(`### ${p.name}`, "", "| Key | Environments | Type | Problem |", "|---|---|---|---|");
    for (const v of envs) md.push(`| ${v.key} | ${v.targets.join(", ")}${v.gitBranch ? ` (${v.gitBranch})` : ""} | ${v.type} | ${flag(v)} |`);
    md.push("");
  }
  md.push("## Team shared variables", "", "| Key | Projects | Environments | Type | Problem |", "|---|---|---|---|---|");
  for (const v of await vercel.listSharedMeta()) {
    md.push(`| ${v.key} | ${v.projectIds.map((i) => byId[i] || i).join(", ")} | ${v.targets.join(", ")} | ${v.type} | ${flag(v)} |`);
  }
  const text = md.join("\n") + "\n";
  writeFileSync("inventory.md", text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
  });
}
