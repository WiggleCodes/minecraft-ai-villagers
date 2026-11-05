// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// The planner: figures out how to get any item from what a villager has, with no AI. It searches backwards
// through Minecraft's recipes, smelting, mining and hunting (iron_pickaxe <- iron_ingot <- smelt raw_iron
// <- mine iron_ore, which needs a stone_pickaxe <- cobblestone ...) and returns the first step that can be
// done right now. Used by the autopilot for long-term goals, and by the AI through the figure_out tool.

// output <- input, cooked in a furnace
const SMELT = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', stone: 'cobblestone', glass: 'sand',
  smooth_stone: 'stone', charcoal: 'log', brick: 'clay_ball', cooked_beef: 'beef', cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken', cooked_mutton: 'mutton', baked_potato: 'potato', cooked_cod: 'cod', cooked_salmon: 'salmon',
};
// item <- block mined, with the pickaxe level it needs (0 hand, 1 wooden, 2 stone, 3 iron)
const MINE = {
  raw_iron: ['iron_ore', 2], raw_gold: ['gold_ore', 3], raw_copper: ['copper_ore', 2], coal: ['coal_ore', 1],
  diamond: ['diamond_ore', 3], redstone: ['redstone_ore', 3], lapis_lazuli: ['lapis_ore', 2], cobblestone: ['stone', 1],
  log: ['log', 0], sand: ['sand', 0], dirt: ['dirt', 0], gravel: ['gravel', 0], flint: ['gravel', 0], clay_ball: ['clay', 0],
  wheat_seeds: ['short_grass', 0], sugar_cane: ['sugar_cane', 0], pumpkin: ['pumpkin', 0], sweet_berries: ['sweet_berry_bush', 0],
};
// item <- animal
const HUNT = { wool: 'sheep', mutton: 'sheep', leather: 'cow', beef: 'cow', porkchop: 'pig', chicken: 'chicken', feather: 'chicken', rabbit: 'rabbit' };
const PICKAXES = { 1: 'wooden_pickaxe', 2: 'stone_pickaxe', 3: 'iron_pickaxe' };
// item <- grown on a farm (harvest ripe crops; build_farm by water to start one)
const FARM = ['wheat', 'carrot', 'potato', 'beetroot'];

/** Items that are interchangeable for planning (any planks, any log, any wool...). */
function family(name) {
  for (const f of ['planks', 'log', 'wool', 'wood', 'stem']) if (name.endsWith(`_${f}`) || name === f) return f === 'stem' || f === 'wood' ? 'log' : f;
  return name;
}

/**
 * How many of `item` (or its family) the villager has, including what it's wearing or holding.
 * inv: { name: count }, worn: [names]
 */
function haveCount(inv, worn, item) {
  const fam = family(item);
  let n = Object.entries(inv).filter(([k]) => family(k) === fam || k === item).reduce((s, [, c]) => s + c, 0);
  if (worn.includes(item)) n += 1;
  return n;
}

function pickLevel(inv) {
  if (inv.netherite_pickaxe || inv.diamond_pickaxe) return 4;
  if (inv.iron_pickaxe) return 3;
  if (inv.stone_pickaxe) return 2;
  if (inv.wooden_pickaxe || inv.golden_pickaxe) return 1;
  return 0;
}

/**
 * The first step towards having `count` of `item`, or null if it's already had (or can't be worked out).
 * Returns { name, input, why } in the same shape as autopilot steps.
 */
export function planNext(bot, mcData, item, count = 1, opts = {}) {
  const inv = {};
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;
  const worn = bot.inventory.slots.filter(Boolean).map((s) => s.name);
  const seen = new Set();
  const nearFurnace = () => !!bot.findBlock({ matching: ['furnace', 'smoker', 'blast_furnace'].map((n) => mcData.blocksByName[n]?.id).filter(Boolean), maxDistance: 32 });

  // need() returns null when the item is already had, a step to take, or IMPOSSIBLE when this way can't
  // work (unknown source, or a loop like "a bed needs a bed"): then the caller tries another recipe.
  function need(name, n, depth) {
    if (haveCount(inv, worn, name) >= n) return null;
    if (depth > 8 || seen.has(name)) return IMPOSSIBLE;
    // The village may already have it in a chest: much quicker than making it from scratch.
    const stash = opts.fromChest?.(name);
    if (stash) {
      const take = Math.min(stash.count, n - haveCount(inv, worn, name));
      return { name: 'use_chest', input: { operation: 'withdraw', item: stash.item, count: take, x: stash.pos.x, y: stash.pos.y, z: stash.pos.z }, why: `taking ${take} ${stash.item} from the chest at ${stash.pos.x}, ${stash.pos.y}, ${stash.pos.z}${opts.goal && opts.goal !== name ? ` for ${opts.goal}` : ''}` };
    }
    seen.add(name);
    try {
      const fam = family(name);
      // Mine it?
      const mine = MINE[name] ?? MINE[fam];
      if (mine) {
        const [block, level] = mine;
        if (pickLevel(inv) < level) {
          const s = need(PICKAXES[level], 1, depth + 1);
          return s ?? { name: 'craft', input: { item: PICKAXES[level] }, why: `making a ${PICKAXES[level]} to mine ${block}` };
        }
        return { name: 'collect_block', input: { block, count: Math.max(n - haveCount(inv, worn, name), 1) + 2 }, why: `mining ${block} for ${opts.goal ?? name}` };
      }
      // Hunt it?
      if (HUNT[fam] ?? HUNT[name]) return { name: 'attack', input: { target: HUNT[fam] ?? HUNT[name] }, why: `hunting a ${HUNT[fam] ?? HUNT[name]} for ${name}` };
      // Grow it?
      if (FARM.includes(name)) return { name: 'harvest_crops', input: {}, why: `harvesting ${name} for ${opts.goal ?? name}` };
      // Smelt it?
      if (SMELT[name]) {
        const input = SMELT[name];
        const short = n - haveCount(inv, worn, name);
        const s1 = need(input, short, depth + 1);
        if (s1) return s1;
        if (!nearFurnace() && !inv.furnace) return need('furnace', 1, depth + 1) ?? { name: 'craft', input: { item: 'furnace' }, why: 'making a furnace' };
        if (!(inv.coal || inv.charcoal) && haveCount(inv, worn, 'planks') < 2 && haveCount(inv, worn, 'log') < 1) return need('log', 2, depth + 1);
        return { name: 'smelt', input: { item: input, count: short }, why: `smelting ${input} into ${name} for ${opts.goal ?? name}` };
      }
      // Craft it: try recipe variants, the ones we're closest to having first, until one can work.
      const id = mcData.itemsByName[name]?.id ?? mcData.itemsByName[`oak_${fam}`]?.id;
      if (id == null) return IMPOSSIBLE;
      const recipes = bot.recipesAll(id, null, true);
      if (!recipes.length) return IMPOSSIBLE;
      const missing = (r) => r.delta.filter((d) => d.count < 0)
        .reduce((m, d) => m + Math.max(0, -d.count * Math.ceil(n / (r.result.count || 1)) - haveCount(inv, worn, mcData.items[d.id].name)), 0);
      for (const recipe of [...recipes].sort((a, b) => missing(a) - missing(b)).slice(0, 8)) {
        const times = Math.ceil((n - haveCount(inv, worn, name)) / (recipe.result.count || 1));
        let blocked = false;
        for (const d of recipe.delta.filter((x) => x.count < 0)) {
          const s = need(mcData.items[d.id].name, -d.count * times, depth + 1);
          if (s === IMPOSSIBLE) { blocked = true; break; }
          if (s) return s;
        }
        if (blocked) continue;
        // Generic "planks" lets crafting use whatever wood we have (a recipe may list cherry planks).
        const craftName = fam === 'planks' ? 'planks' : name;
        return { name: 'craft', input: { item: craftName, count: n }, why: `crafting ${craftName}${opts.goal && opts.goal !== name ? ` for ${opts.goal}` : ''}` };
      }
      return IMPOSSIBLE;
    } finally {
      seen.delete(name);
    }
  }
  const step = need(item, count, 0);
  return step === IMPOSSIBLE ? null : step;
}

const IMPOSSIBLE = Object.freeze({ impossible: true });

/**
 * Look items up in the chests the village knows about (contents seen in the last 2 hours, within 64 blocks).
 * Returns (item) => { item, count, pos } | null, for planNext's fromChest option.
 */
export function chestLookup(agent) {
  const me = agent.bot?.entity?.position;
  if (!me) return () => null;
  const chests = Object.entries(agent.store.village.chests ?? {})
    .map(([key, c]) => {
      const [x, y, z] = key.split(',').map(Number);
      return { pos: { x, y, z }, contents: c.contents ?? {}, t: Date.parse(c.t) };
    })
    .filter((c) => Date.now() - c.t < 2 * 3_600_000 && Math.hypot(c.pos.x - me.x, c.pos.z - me.z) < 64);
  return (want) => {
    const fam = family(want);
    for (const c of chests) {
      for (const [name, count] of Object.entries(c.contents)) {
        if (count > 0 && (name === want || family(name) === fam)) return { item: name, count, pos: c.pos };
      }
    }
    return null;
  };
}

/** A readable chain of how to get an item (for the AI's figure_out tool). */
export function explain(mcData, item, depth = 0, seen = new Set()) {
  const pad = '  '.repeat(depth);
  if (depth > 6 || seen.has(item)) return `${pad}- ${item}`;
  seen.add(item);
  const fam = family(item);
  const mine = MINE[item] ?? MINE[fam];
  if (mine) return `${pad}- ${item}: mine ${mine[0]}${mine[1] ? ` (needs a ${PICKAXES[mine[1]]})` : ''}`;
  if (HUNT[fam] ?? HUNT[item]) return `${pad}- ${item}: hunt a ${HUNT[fam] ?? HUNT[item]}`;
  if (FARM.includes(item)) return `${pad}- ${item}: grow it on a farm (build_farm next to water, then harvest_crops when ripe)`;
  if (SMELT[item]) return `${pad}- ${item}: smelt ${SMELT[item]} in a furnace (with fuel)\n${explain(mcData, SMELT[item], depth + 1, seen)}`;
  const id = mcData.itemsByName[item]?.id;
  const names = (rec) => (rec.inShape ?? [rec.ingredients ?? []]).flat().filter((x) => x != null).map((x) => mcData.items[typeof x === 'object' ? x.id : x]?.name);
  // Prefer the oak / plain variant over exotic ones (cherry, blackstone...) and never "dye a bed" style loops.
  const all = (id != null && mcData.recipes?.[id]) || [];
  const r = all.find((rec) => names(rec).some((n) => /^oak_|^cobblestone$|_wool$/.test(n)) && !names(rec).includes(item)) ?? all.find((rec) => !names(rec).includes(item));
  if (!r) return `${pad}- ${item}: find it in the world`;
  const counts = {};
  for (const n0 of names(r)) {
    if (!n0) continue;
    const n = family(n0) === 'planks' ? 'planks (any wood)' : family(n0) === 'log' ? 'log (any wood)' : n0;
    counts[n] = (counts[n] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([n, c]) => `${c} ${n}`);
  const table = r.inShape && (r.inShape.length > 2 || r.inShape.some((row) => row.length > 2)) ? ' at a crafting table' : '';
  const sub = Object.keys(counts).map((n) => (n.startsWith('planks') ? 'oak_planks' : n.startsWith('log') ? 'log' : n));
  return `${pad}- ${item}: craft from ${parts.join(' + ')}${table}\n${sub.map((n) => explain(mcData, n, depth + 1, seen)).join('\n')}`;
}

// What each role works towards in the long run, in order (the planner works out how).
export const ROLE_GOALS = {
  miner: ['stone_pickaxe', 'iron_pickaxe', 'iron_helmet'],
  blacksmith: ['stone_pickaxe', 'furnace', 'iron_pickaxe', 'iron_chestplate', 'shield', 'iron_leggings'],
  guard: ['stone_sword', 'shield', 'iron_sword', 'iron_chestplate'],
  hunter: ['stone_sword', 'iron_sword'],
  shepherd: ['white_bed'],
  farmer: ['wooden_hoe', 'bread'],
  cook: ['furnace', 'bread'],
  builder: ['stone_pickaxe', 'stone_axe'],
  mason: ['stone_pickaxe', 'iron_pickaxe'],
  lumberjack: ['stone_axe', 'iron_axe'],
  quartermaster: ['chest'],
  default: ['stone_pickaxe', 'iron_pickaxe'],
};
export function goalsFor(role) {
  const key = Object.keys(ROLE_GOALS).find((k) => role.toLowerCase().includes(k));
  return ROLE_GOALS[key] ?? ROLE_GOALS.default;
}
