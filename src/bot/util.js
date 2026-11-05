// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

export { goals, Vec3 };

export class ActionError extends Error {}

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise "Oak Log" / "minecraft:oak_log" -> "oak_log" */
export function normName(name = '') {
  return String(name).trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}

export const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'snow', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen',
]);

const FAMILY_ALIASES = {
  wood: 'log',
  logs: 'log',
  tree: 'log',
  plank: 'planks',
  ore: 'ore',
  bed: 'bed',
  beds: 'bed',
  rock: 'stone',
  coal: 'coal_ore',
  iron: 'iron_ore',
  gold: 'gold_ore',
  diamond: 'diamond_ore',
  diamonds: 'diamond_ore',
};

/**
 * Resolve a block name or family ("log", "ore", "bed") into block ids.
 * Exact names win; otherwise match by suffix (e.g. *_log) and then substring.
 */
export function resolveBlockIds(mcData, rawName) {
  let name = normName(rawName);
  name = FAMILY_ALIASES[name] ?? name;
  const exact = mcData.blocksByName[name];
  const ids = [];
  if (exact) {
    ids.push(exact.id);
    // Ores also exist as deepslate variants; logs as wood/stems, etc.
    const deep = mcData.blocksByName[`deepslate_${name}`];
    if (deep) ids.push(deep.id);
    return ids;
  }
  for (const b of mcData.blocksArray) {
    if (b.name.endsWith(`_${name}`) || b.name.startsWith(`${name}_`)) ids.push(b.id);
  }
  if (!ids.length) {
    for (const b of mcData.blocksArray) if (b.name.includes(name)) ids.push(b.id);
  }
  if (!ids.length) throw new ActionError(`Unknown block "${rawName}". Try a Minecraft id like "oak_log" or "iron_ore".`);
  return ids.slice(0, 64);
}

export function resolveItem(mcData, rawName) {
  const name = normName(rawName);
  const item = mcData.itemsByName[name];
  if (!item) {
    const close = mcData.itemsArray.filter((i) => i.name.includes(name)).slice(0, 6).map((i) => i.name);
    throw new ActionError(`Unknown item "${rawName}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`);
  }
  return item;
}

/** Find an inventory item by exact name or family (e.g. "planks" matches oak_planks). */
export function findInventoryItem(bot, rawName) {
  const name = normName(rawName);
  const items = bot.inventory.items();
  return (
    items.find((i) => i.name === name) ??
    items.find((i) => i.name.endsWith(`_${name}`)) ??
    items.find((i) => i.name.includes(name)) ??
    null
  );
}

export function countItem(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
}

export function tallyInventory(bot) {
  const out = {};
  for (const i of bot.inventory.items()) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
}

export function fmtPos(p) {
  return p ? `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}` : '?';
}

export function posObj(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export function findPlayerEntity(bot, username) {
  const want = String(username).toLowerCase();
  const key = Object.keys(bot.players).find((u) => u.toLowerCase() === want);
  return key ? bot.players[key]?.entity ?? null : null;
}

/** Pathfind near a position with a timeout; resolves when arrived. */
export async function goNear(ctx, pos, range = 2, timeoutMs = 90_000) {
  const { bot } = ctx;
  ctx.throwIfCancelled();
  const goal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), range);
  let timer;
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          bot.pathfinder.stop();
          rej(new ActionError(`Could not reach ${fmtPos(pos)} in time.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk over the items lying around `around` (what we just mined or killed) so they're picked up.
 * (The collectblock plugin only notices drops through an event that doesn't fire reliably on new
 * Minecraft versions, so most of what villagers mined used to be left on the ground.)
 */
export async function pickUpDrops(ctx, around, { radius = 8, maxMs = 10_000 } = {}) {
  const { bot } = ctx;
  const deadline = Date.now() + maxMs;
  const tried = new Set();
  await sleepMs(400); // drops appear a moment after the block breaks
  while (Date.now() < deadline) {
    ctx.throwIfCancelled();
    const drop = bot.nearestEntity((e) => e.name === 'item' && !tried.has(e.id) && e.position.distanceTo(around) <= radius);
    if (!drop) break;
    tried.add(drop.id);
    if (drop.position.distanceTo(bot.entity.position) > 1.2) {
      await goNear(ctx, drop.position, 1, Math.max(1_000, Math.min(6_000, deadline - Date.now()))).catch(() => {});
    }
    await sleepMs(250);
  }
}

// Blocks that open or toggle when clicked: placing against them opens a furnace/chest instead of placing.
const INTERACTIVE = /chest|furnace|smoker|crafting_table|barrel|_door$|_trapdoor$|_gate$|_bed$|lever|button|anvil|enchanting|brewing|hopper|dispenser|dropper|shulker|note_block|jukebox|loom|cartography|grindstone|stonecutter|smithing|bell|_sign$|lectern|composter|cauldron|beacon|respawn_anchor/;

/**
 * Find a solid neighbour of `pos` to place against. Returns { block, face, sneak } or null.
 * Prefers plain blocks; only uses an interactive one (furnace, chest...) if it must, with sneak set.
 */
export function findPlaceReference(bot, pos) {
  const faces = [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  ];
  let fallback = null;
  for (const dir of faces) {
    const nb = bot.blockAt(pos.plus(dir));
    if (nb && !REPLACEABLE.has(nb.name) && nb.boundingBox === 'block') {
      if (!INTERACTIVE.test(nb.name)) return { block: nb, face: dir.scaled(-1), sneak: false };
      fallback ??= { block: nb, face: dir.scaled(-1), sneak: true };
    }
  }
  return fallback;
}

/** Place `item` (an inventory Item) at pos. Moves into reach if needed. */
export async function placeItemAt(ctx, item, pos, { move = true } = {}) {
  const { bot } = ctx;
  pos = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const existing = bot.blockAt(pos);
  if (existing && !REPLACEABLE.has(existing.name)) {
    if (existing.name === item.name) return 'already there';
    throw new ActionError(`${fmtPos(pos)} is occupied by ${existing.name}.`);
  }
  const feet = bot.entity.position.floored();
  if (pos.equals(feet) || pos.equals(feet.offset(0, 1, 0))) {
    throw new ActionError('Cannot place a block where I am standing.');
  }
  const ref = findPlaceReference(bot, pos);
  if (!ref) throw new ActionError(`Nothing solid next to ${fmtPos(pos)} to place against.`);
  if (move && bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) {
    await goNear(ctx, pos, 3);
  }
  ctx.throwIfCancelled();
  // Skip the equip when it's already in hand: one fewer inventory round trip per block during builds.
  if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');
  // Crouch when we have to place against a furnace/chest, like a player would, so it doesn't open.
  if (ref.sneak) bot.setControlState('sneak', true);
  bot._deliberatePlace = true; // not scaffolding: clean_up leaves it alone
  try {
    await bot.placeBlock(ref.block, ref.face);
  } catch (err) {
    // placeBlock sometimes times out waiting for the block update even though it worked.
    await sleepMs(250);
    const now = bot.blockAt(pos);
    if (!now || now.name !== item.name) throw new ActionError(`Placing failed: ${err.message}`);
  } finally {
    bot._deliberatePlace = false;
    if (ref.sneak) bot.setControlState('sneak', false);
  }
  return 'placed';
}

/** Find an empty spot next to the bot with solid ground (for tables, furnaces, chests). */
export function findFreeSpotNear(bot) {
  const base = bot.entity.position.floored();
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2],
  ];
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of offsets) {
      const p = base.offset(dx, dy, dz);
      const at = bot.blockAt(p);
      const below = bot.blockAt(p.offset(0, -1, 0));
      if (at && REPLACEABLE.has(at.name) && below && below.boundingBox === 'block') return p;
    }
  }
  return null;
}

/**
 * Replace bot.findBlocks (and so bot.findBlock) with a version that can't freeze the process.
 * mineflayer skips a 16³ section only when its palette rules the block out, but 26.x sections made
 * of a single block (all air, all stone) have no palette, so it calls blockAt on all 4096 blocks of
 * each. Over a wide radius that is millions of Block objects in one synchronous burst, which froze
 * the whole village until it ran out of memory. This checks single-value sections by their value,
 * reads state ids directly, and scans nearest sections first so it can stop early.
 */
export function installFastFindBlocks(bot) {
  if (bot._fastFindBlocks) return;
  bot._fastFindBlocks = true;
  const original = bot.findBlocks;
  bot.findBlocks = (options) => {
    const ids = typeof options.matching === 'number' ? [options.matching] : options.matching;
    if (!Array.isArray(ids) || options.useExtraInfo) return original(options);
    return findBlocksFast(bot, ids, options);
  };
}

/**
 * collectblock calls bot.tool.equipForBlock with getFromChest: true. When no inventory item can
 * harvest the block and no chests are registered, mineflayer-tool's retrieveTools returns at once
 * and equipForBlock recurses forever on microtasks, locking the event loop until out of memory.
 * Never fetch from chests: with no suitable tool it throws NoItem instead, which collect_block reports.
 */
export function installSafeToolEquip(bot) {
  if (!bot.tool || bot._safeToolEquip) return;
  bot._safeToolEquip = true;
  const original = bot.tool.equipForBlock.bind(bot.tool);
  bot.tool.equipForBlock = (block, options = {}, cb) => original(block, { ...options, getFromChest: false }, cb);
}

function matchingStates(bot, ids) {
  const states = new Set();
  for (const id of ids) {
    const b = bot.registry.blocks[id];
    if (b) for (let s = b.minStateId; s <= b.maxStateId; s++) states.add(s);
  }
  return states;
}

function sectionMayContain(section, states) {
  if (section.palette) return section.palette.some((s) => states.has(s));
  if (section.data && 'value' in section.data) return states.has(section.data.value); // single-value section
  return true; // global palette: have to look
}

function boxDistance(p, x0, y0, z0) {
  const dx = Math.max(x0 - p.x, 0, p.x - (x0 + 15));
  const dy = Math.max(y0 - p.y, 0, p.y - (y0 + 15));
  const dz = Math.max(z0 - p.z, 0, p.z - (z0 + 15));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function findBlocksFast(bot, ids, options) {
  const states = matchingStates(bot, ids);
  const point = (options.point ?? bot.entity.position).floored();
  const maxDistance = options.maxDistance ?? 16;
  const count = options.count ?? 1;
  const minY = bot.game.minY;
  const r = Math.ceil(maxDistance / 16);
  const pcx = point.x >> 4;
  const pcz = point.z >> 4;

  const sections = [];
  for (let cx = pcx - r; cx <= pcx + r; cx++) {
    for (let cz = pcz - r; cz <= pcz + r; cz++) {
      const column = bot.world.getColumn(cx, cz);
      if (!column?.sections) continue;
      column.sections.forEach((section, i) => {
        if (!section) return;
        const y0 = minY + i * 16;
        const near = boxDistance(point, cx * 16, y0, cz * 16);
        if (near <= maxDistance && sectionMayContain(section, states)) {
          sections.push({ section, x0: cx * 16, y0, z0: cz * 16, near });
        }
      });
    }
  }
  sections.sort((a, b) => a.near - b.near);

  let found = [];
  const local = { x: 0, y: 0, z: 0 };
  for (const s of sections) {
    // Every block in this section is further than the count-th best so far: done.
    if (found.length >= count && s.near > found[count - 1].d) break;
    for (local.y = 0; local.y < 16; local.y++) {
      for (local.z = 0; local.z < 16; local.z++) {
        for (local.x = 0; local.x < 16; local.x++) {
          if (!states.has(s.section.get(local))) continue;
          const p = new Vec3(s.x0 + local.x, s.y0 + local.y, s.z0 + local.z);
          const d = p.distanceTo(point);
          if (d <= maxDistance) found.push({ p, d });
        }
      }
    }
    found.sort((a, b) => a.d - b.d);
    if (found.length > count) found = found.slice(0, count);
  }
  return found.map((f) => f.p);
}

export function truncate(s, n = 2000) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? `${s.slice(0, n)}…(truncated)` : s;
}
