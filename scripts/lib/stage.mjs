/**
 * Moves one variable to a new value in two steps, so production is only
 * touched after preview has run on the new value.
 *
 *   stagePreview:     old entries lose the preview (and development) target,
 *                     a new sensitive entry is created for preview only.
 *   promoteProduction: old entries lose production; the new entry gains it.
 *
 * Old entries left with no targets are deleted. Development never gets a
 * rotated secret: local work uses test keys from .env.local.
 */
const without = (targets, drop) => targets.filter((t) => !drop.includes(t));
const same = (a, b) => a.length === b.length && a.every((t) => b.includes(t));

async function shrink(store, entries, drop, log) {
  for (const e of entries) {
    const next = without(e.targets, drop);
    if (next.length === 0) {
      log(`${store.label}: delete old entry ${e.id} (${e.targets.join("+")})`);
      await store.remove(e.id);
    } else if (!same(next, e.targets)) {
      log(`${store.label}: old entry ${e.id} ${e.targets.join("+")} -> ${next.join("+")}`);
      await store.updateTargets(e.id, next);
    }
  }
}

export async function stagePreview(store, { key, value, log = console.log }) {
  const entries = await store.list(key);
  await shrink(store, entries, ["preview", "development"], log);
  log(`${store.label}: create ${key} (sensitive, preview)`);
  return store.create({ key, value, targets: ["preview"] });
}

export async function promoteProduction(store, { key, newId, log = console.log }) {
  const entries = (await store.list(key)).filter((e) => e.id !== newId);
  await shrink(store, entries, ["production"], log);
  log(`${store.label}: ${key} new entry ${newId} -> preview+production`);
  await store.updateTargets(newId, ["preview", "production"]);
}

/**
 * A store that changes nothing but keeps its own copy of the entries, so a
 * dry run's later steps see the earlier steps' (simulated) changes.
 */
export function dryRunStore(store) {
  let n = 0;
  const copies = new Map();
  const entries = async (key) => {
    if (!copies.has(key)) copies.set(key, (await store.list(key)).map((e) => ({ ...e, targets: [...e.targets] })));
    return copies.get(key);
  };
  const find = (id) => [...copies.values()].flat().find((e) => e.id === id);
  return {
    label: `${store.label} (dry run)`,
    list: async (key) => (await entries(key)).map((e) => ({ ...e, targets: [...e.targets] })),
    create: async ({ key, targets }) => {
      const id = `dry-${++n}`;
      (await entries(key)).push({ id, targets: [...targets], type: "sensitive" });
      return id;
    },
    updateTargets: async (id, targets) => {
      const e = find(id);
      if (e) e.targets = [...targets];
    },
    updateValue: async () => {},
    remove: async (id) => {
      for (const list of copies.values()) {
        const i = list.findIndex((e) => e.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    },
  };
}
