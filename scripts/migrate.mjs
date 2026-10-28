#!/usr/bin/env node
/**
 * Applies a repo's migration files to one Supabase project, through the
 * Management API, with a rehearsal first.
 *
 *   node scripts/migrate.mjs <database> <files|pending> --source <dir> [--apply <plan>] [--baseline]
 *
 * Without --apply it only rehearses: every file runs inside one transaction
 * that is rolled back, so the real database is checked but not changed. It
 * prints a plan id: a hash of the project, the files and their contents.
 * --apply <plan> rehearses again, refuses unless the plan id still matches
 * (same files, same contents), then runs them in one transaction with the
 * ledger rows, so either every file lands and is recorded, or none does.
 * --baseline records files as already applied (run by hand earlier) without
 * running them; like --apply, it acts only when given the plan id that a
 * first, listing-only baseline run prints.
 *
 * The ledger lives in the project itself: secret_ops.migrations. Logs and the
 * job summary show file names, hashes and Postgres error text, never SQL.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { supabaseClient } from "./lib/supabase.mjs";
import { lit, prepareMigration } from "./lib/sql.mjs";

const LEDGER = `
create schema if not exists secret_ops;
revoke all on schema secret_ops from public;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema secret_ops from anon, authenticated';
  end if;
end $g$;
create table if not exists secret_ops.migrations (
  repo text not null,
  path text not null,
  sha256 text not null,
  commit text,
  how text not null check (how in ('applied', 'baseline')),
  run_url text,
  applied_at timestamptz not null default now(),
  primary key (repo, path)
);`;

export function loadDatabases(file = new URL("../databases.json", import.meta.url)) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function planId(ref, files) {
  return sha256(JSON.stringify([ref, files.map((f) => [f.path, f.sha256])])).slice(0, 12);
}

/** Migration files in apply order: numeric-aware, so 0100 follows 0099. */
export function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/**
 * Which requested files run. Recorded with the same hash: skipped. Recorded
 * with another hash: refused, since an applied migration must not change.
 */
export function selectFiles({ requested, available, ledger, ordered }) {
  const byPath = new Map(ledger.map((r) => [r.path, r]));
  const problems = [];
  let names;
  if (requested === "pending") {
    if (!ordered) throw new Error("this repo's file names have no order; name the files to run");
    if (!ledger.length) throw new Error("the ledger is empty; record what already ran with a baseline run first, or name the files");
    names = available.filter((f) => !byPath.has(f));
  } else {
    names = requested.split(",").map((s) => s.trim()).filter(Boolean);
    for (const f of names) if (!available.includes(f)) problems.push(`${f}: not in the repo's migration folder`);
  }
  return { names, byPath, problems };
}

function sumLine(lines, l) {
  console.log(l);
  lines.push(l);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const VALUED = new Set(["--source", "--apply"]);
  const [dbId, requested] = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
  const source = opt("--source");
  const applyPlan = opt("--apply");
  const baseline = args.includes("--baseline");
  if (!dbId || !requested || !source) throw new Error("usage: migrate.mjs <database> <files|pending> --source <dir> [--apply <plan>] [--baseline]");

  const db = loadDatabases()[dbId];
  if (!db) throw new Error(`unknown database ${dbId}; add it to databases.json`);
  const dir = join(source, db.dir);
  if (!existsSync(dir)) throw new Error(`${db.repo} has no ${db.dir}`);

  const sb = supabaseClient({ token: process.env.SUPABASE_ACCESS_TOKEN });
  const run = (sql) => sb.query(db.ref, sql);
  const commit = process.env.SOURCE_COMMIT || null;
  const runUrl = process.env.RUN_URL || null;
  const lines = [`## ${baseline ? "Baseline" : applyPlan ? "Apply" : "Rehearsal"}: ${dbId} (${db.ref})`, "", `Source: ${db.repo}@${(commit || "?").slice(0, 7)}`, ""];

  const project = (await sb.listProjects()).find((p) => p.id === db.ref || p.ref === db.ref);
  if (!project) throw new Error(`Supabase project ${db.ref} is not visible to this token`);
  sumLine(lines, `- Supabase project: ${project.name} (${db.ref})`);

  // The guard every run starts with: a table created inside BEGIN ... ROLLBACK
  // must be gone afterwards. If it isn't, the API isn't running our text as one
  // transaction and a rehearsal would not be safe, so stop.
  const probe = `secret_ops_probe_${randomBytes(4).toString("hex")}`;
  await run(`begin; create table public.${probe} (x int); rollback;`);
  const [left] = await run(`select to_regclass('public.${probe}') is not null as left`);
  if (left?.left) {
    await run(`drop table if exists public.${probe};`);
    throw new Error("rollback check failed: the API committed inside BEGIN ... ROLLBACK. Nothing else was run.");
  }
  sumLine(lines, "- Rollback check passed: a rehearsal leaves the database unchanged.");

  const [has] = await run(`select to_regclass('secret_ops.migrations') is not null as has`);
  const ledger = has?.has ? await run(`select path, sha256, how, applied_at from secret_ops.migrations where repo = ${lit(db.repo)} order by applied_at, path`) : [];
  sumLine(lines, `- Ledger: ${ledger.length} file(s) recorded for ${db.repo}.`);

  const available = listMigrationFiles(dir);
  const { names, byPath, problems } = selectFiles({ requested, available, ledger, ordered: db.ordered });
  const files = [];
  for (const path of names) {
    const raw = readFileSync(join(dir, path), "utf8");
    const hash = sha256(raw);
    const rec = byPath.get(path);
    if (rec && rec.sha256 === hash) {
      sumLine(lines, `- ${path}: already recorded (${rec.how}), skipped.`);
      continue;
    }
    if (rec) {
      problems.push(`${path}: recorded with a different hash; an applied migration must not change, add a new file instead`);
      continue;
    }
    const prep = prepareMigration(raw);
    if (!baseline) for (const p of prep.problems) problems.push(`${path}: ${p}`);
    files.push({ path, sha256: hash, sql: prep.sql, statements: prep.statements });
  }
  if (problems.length) throw new Error(problems.join("\n"));
  if (!files.length) {
    sumLine(lines, "- Nothing to run.");
    return finish(lines);
  }
  const plan = planId(db.ref, files);
  for (const f of files) sumLine(lines, `- ${f.path}: ${f.statements} statements, sha256 ${f.sha256.slice(0, 12)}`);

  const record = (f, how) =>
    `reset role; insert into secret_ops.migrations (repo, path, sha256, commit, how, run_url) values (${[db.repo, f.path, f.sha256, commit, how, runUrl].map(lit).join(", ")});`;

  if (baseline) {
    sumLine(lines, `- Plan id: \`${plan}\``);
    if (applyPlan !== plan) {
      sumLine(lines, `- Not recorded. To record these files as already applied, run again with plan \`${plan}\`.`);
      return finish(lines);
    }
    await run(`begin; ${LEDGER} ${files.map((f) => record(f, "baseline")).join("\n")} commit;`);
    sumLine(lines, `- Recorded ${files.length} file(s) as applied earlier. None of them ran.`);
    return finish(lines);
  }

  // Rehearsal: all files in order, in one transaction that is rolled back.
  // On failure, rerun growing prefixes to name the file that broke.
  const rehearse = (fs) => run(`begin; ${fs.map((f) => f.sql).join("\n;\n")}\n; rollback;`);
  try {
    await rehearse(files);
  } catch (err) {
    let culprit = files[files.length - 1].path;
    for (let k = 1; k < files.length; k++) {
      try {
        await rehearse(files.slice(0, k));
      } catch {
        culprit = files[k - 1].path;
        break;
      }
    }
    sumLine(lines, `- Rehearsal FAILED at ${culprit}: ${err.message.replace(/^POST \S+ -> /, "")}`);
    sumLine(lines, "- Nothing was changed.");
    finish(lines);
    process.exit(1);
  }
  sumLine(lines, `- Rehearsal passed and was rolled back. Plan id: \`${plan}\``);

  if (!applyPlan) {
    sumLine(lines, `- To apply, run again with plan \`${plan}\`.`);
    return finish(lines);
  }
  if (applyPlan !== plan) throw new Error(`plan ${applyPlan} does not match ${plan}: the files or their contents changed since the rehearsal. Rehearse again.`);

  await run(`begin; ${LEDGER}\n${files.map((f) => `${f.sql}\n;\n${record(f, "applied")}`).join("\n")}\ncommit;`);
  const after = await run(`select count(*)::int as n from secret_ops.migrations where repo = ${lit(db.repo)} and path in (${files.map((f) => lit(f.path)).join(", ")})`);
  sumLine(lines, `- Applied ${files.length} file(s) in one transaction; ${after[0]?.n ?? 0} recorded in secret_ops.migrations.`);
  return finish(lines);
}

function finish(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Failed:** ${err.message.replace(/\n/g, "; ")}\n`);
    process.exit(1);
  });
}
