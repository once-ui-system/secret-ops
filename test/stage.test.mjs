import { test } from "node:test";
import assert from "node:assert/strict";
import { stagePreview, promoteProduction } from "../scripts/lib/stage.mjs";
import { pickRevocable } from "../scripts/revoke.mjs";
import { manualSecret } from "../scripts/lib/targets.mjs";
import { flag } from "../scripts/discover.mjs";

function memoryStore(entries) {
  let n = 0;
  const db = entries.map((e) => ({ ...e }));
  return {
    db,
    label: "mem",
    list: async (key) => db.filter((e) => e.key === key).map((e) => ({ ...e, targets: [...e.targets] })),
    create: async ({ key, value, targets }) => {
      const id = `new${++n}`;
      db.push({ id, key, value, targets: [...targets], type: "sensitive" });
      return id;
    },
    updateTargets: async (id, targets) => {
      db.find((e) => e.id === id).targets = [...targets];
    },
    updateValue: async (id, value) => {
      db.find((e) => e.id === id).value = value;
    },
    remove: async (id) => db.splice(db.findIndex((e) => e.id === id), 1),
  };
}
const quiet = () => {};

test("combined entry: preview first, production untouched until promote", async () => {
  const s = memoryStore([{ id: "old", key: "K", value: "v1", targets: ["development", "preview", "production"], type: "encrypted" }]);
  const newId = await stagePreview(s, { key: "K", value: "v2", log: quiet });
  assert.deepEqual(s.db.find((e) => e.id === "old").targets, ["production"]);
  assert.equal(s.db.find((e) => e.id === "old").value, "v1");
  assert.deepEqual(s.db.find((e) => e.id === newId).targets, ["preview"]);
  await promoteProduction(s, { key: "K", newId, log: quiet });
  assert.equal(s.db.length, 1);
  assert.deepEqual(s.db[0], { id: newId, key: "K", value: "v2", targets: ["preview", "production"], type: "sensitive" });
});

test("separate preview and production entries", async () => {
  const s = memoryStore([
    { id: "p", key: "K", value: "a", targets: ["production"], type: "sensitive" },
    { id: "q", key: "K", value: "a", targets: ["preview"], type: "sensitive" },
    { id: "other", key: "OTHER", value: "x", targets: ["preview"], type: "sensitive" },
  ]);
  const newId = await stagePreview(s, { key: "K", value: "b", log: quiet });
  assert.deepEqual(s.db.map((e) => e.id).sort(), [newId, "other", "p"].sort());
  await promoteProduction(s, { key: "K", newId, log: quiet });
  assert.deepEqual(s.db.map((e) => e.id).sort(), [newId, "other"].sort());
});

test("variable that did not exist yet", async () => {
  const s = memoryStore([]);
  const newId = await stagePreview(s, { key: "NEW", value: "z", log: quiet });
  await promoteProduction(s, { key: "NEW", newId, log: quiet });
  assert.deepEqual(s.db[0].targets, ["preview", "production"]);
});

test("revoke never deletes the newest secret key", () => {
  const keys = [
    { id: "a", type: "secret", name: "default", inserted_at: "2026-01-01" },
    { id: "b", type: "secret", name: "rot_202610252300", inserted_at: "2026-10-25" },
    { id: "c", type: "publishable", name: "default", inserted_at: "2026-01-01" },
  ];
  const r = pickRevocable(keys, ["a", "b", "c", "zzz"]);
  assert.deepEqual(r.map((x) => x.ok), [true, false, false, false]);
});

test("manual secret prefix guard", () => {
  assert.throws(() => manualSecret({ prefix: "sk_live_" }, { INCOMING_SECRET: "sk_test_123" }), /refusing/);
  assert.throws(() => manualSecret({}, {}), /empty/);
  assert.equal(manualSecret({ prefix: "whsec_" }, { INCOMING_SECRET: " whsec_abc \n" }), "whsec_abc");
});

test("inventory flags readable and development secrets", () => {
  assert.equal(flag({ key: "SUPABASE_SERVICE_ROLE_KEY", type: "encrypted", targets: ["development", "production"] }), "not sensitive, in development");
  assert.equal(flag({ key: "STRIPE_SECRET_KEY", type: "sensitive", targets: ["production"] }), "");
  assert.equal(flag({ key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", type: "encrypted", targets: ["development"] }), "");
});
