import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStatements, prepareMigration } from "../scripts/lib/sql.mjs";
import { selectFiles, planId } from "../scripts/migrate.mjs";

test("splits on top-level semicolons only", () => {
  const sql = `-- a; comment
create table t (x text default 'a;b');
/* block; */ create function f() returns void language plpgsql as $$
begin
  perform 1; -- inside the body
end $$;
do $outer$ begin execute $q$select 1;$q$; end $outer$;
select "we;ird" from t`;
  const s = splitStatements(sql);
  assert.equal(s.length, 4);
  assert.match(s[1], /create function/);
  assert.match(s[3], /select "we;ird"/);
});

test("removes a BEGIN ... COMMIT wrapper and keeps plpgsql BEGIN", () => {
  const p = prepareMigration(`-- header\nBEGIN;\ncreate table a (x int);\ndo $$ begin raise notice 'x'; end $$;\nCOMMIT;\n`);
  assert.deepEqual(p.problems, []);
  assert.equal(p.statements, 2);
  assert.doesNotMatch(p.sql, /COMMIT/);
});

test("refuses transaction control in the middle and CONCURRENTLY", () => {
  const p = prepareMigration(`create table a (x int);\ncommit;\ncreate index concurrently i on a (x);`);
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /transaction control/);
  assert.match(p.problems[1], /CONCURRENTLY/);
});

test("pending needs an ordered repo and a ledger", () => {
  const available = ["0001_a.sql", "0002_b.sql", "0003_c.sql"];
  assert.throws(() => selectFiles({ requested: "pending", available, ledger: [], ordered: true }), /baseline/);
  assert.throws(() => selectFiles({ requested: "pending", available, ledger: [{ path: "0001_a.sql" }], ordered: false }), /no order/);
  const r = selectFiles({ requested: "pending", available, ledger: [{ path: "0001_a.sql" }], ordered: true });
  assert.deepEqual(r.names, ["0002_b.sql", "0003_c.sql"]);
  assert.deepEqual(selectFiles({ requested: "0009_x.sql", available, ledger: [], ordered: true }).problems.length, 1);
});

test("plan id changes when a file changes", () => {
  const a = planId("ref", [{ path: "1.sql", sha256: "aa" }]);
  assert.notEqual(a, planId("ref", [{ path: "1.sql", sha256: "ab" }]));
  assert.notEqual(a, planId("other", [{ path: "1.sql", sha256: "aa" }]));
});
