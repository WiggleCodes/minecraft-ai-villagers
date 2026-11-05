// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Crafting that thinks ahead: makes in-between ingredients (planks from logs, sticks from planks, a crafting
// table) itself, and picks the recipe variant the villager can actually make (oak planks, not cherry).
import { ActionError, goNear, normName, resolveItem, findInventoryItem, countItem, placeItemAt, findFreeSpotNear } from './util.js';

const MAX_DEPTH = 2; // e.g. wooden_pickaxe <- stick <- planks (logs have to be gathered)

/** Find a station (crafting table, furnace) within maxDistance blocks, or place one from the inventory, and walk to it. */
export async function ensureStation(ctx, blockName, label, maxDistance = 32) {
  const { bot, mcData } = ctx;
  const id = mcData.blocksByName[blockName].id;
  let block = bot.findBlock({ matching: id, maxDistance });
  if (!block) {
    const item = findInventoryItem(bot, blockName);
    if (!item || item.name !== blockName) {
      throw new ActionError(`No ${label} nearby and none in inventory. Craft one first.`);
    }
    const spot = findFreeSpotNear(bot);
    if (!spot) throw new ActionError(`No free spot next to me to put down a ${label}.`);
    await placeItemAt(ctx, item, spot, { move: false });
    block = bot.blockAt(spot);
  }
  if (bot.entity.position.distanceTo(block.position) > 3.5) await goNear(ctx, block.position, 2);
  return block;
}

function countById(bot, id) {
  return bot.inventory.items().filter((i) => i.type === id).reduce((n, i) => n + i.count, 0);
}

/** Ingredients a recipe still lacks for `times` crafts: [{ id, count }]. */
function missingFor(bot, recipe, times) {
  const out = [];
  for (const d of recipe.delta) {
    if (d.count >= 0) continue;
    const short = -d.count * times - countById(bot, d.id);
    if (short > 0) out.push({ id: d.id, count: short });
  }
  return out;
}

/**
 * Every recipe variant for an item, the ones we are closest to completing first: fewest missing ingredients
 * we can't make right now from what we carry (so oak planks beat cherry planks when we have oak logs), then
 * fewest missing overall.
 */
function variantsByReadiness(bot, item, count) {
  const total = (m) => m.reduce((n, x) => n + x.count, 0);
  const craftableNow = new Map();
  const canMake = (id) => {
    if (!craftableNow.has(id)) craftableNow.set(id, bot.recipesFor(id, null, 1, true).length > 0);
    return craftableNow.get(id);
  };
  return bot.recipesAll(item.id, null, true)
    .map((r) => {
      const missing = missingFor(bot, r, Math.ceil(count / (r.result.count || 1)));
      return { r, missing, blocked: missing.filter((m) => !canMake(m.id)).length };
    })
    .sort((a, b) => a.blocked - b.blocked || total(a.missing) - total(b.missing));
}

/** What the closest recipe for `item` still lacks, as [{ name, count }]. */
export function missingItems(bot, mcData, item, count = 1) {
  const best = variantsByReadiness(bot, item, count)[0];
  return best ? best.missing.map((m) => ({ name: mcData.items[m.id]?.name, count: m.count })).filter((m) => m.name) : [];
}

export function describeMissing(bot, mcData, item, count = 1) {
  const best = variantsByReadiness(bot, item, count)[0];
  if (!best) return `${item.name} cannot be crafted (it may need smelting or be found in the world).`;
  const name = (id) => mcData.items[id]?.name ?? id;
  const needs = best.r.delta.filter((d) => d.count < 0).map((d) => `${name(d.id)} x${-d.count}`);
  const still = best.missing.map((m) => `${name(m.id)} x${m.count}`);
  const tableNote = best.r.requiresTable ? ' (needs a crafting table)' : '';
  return `Missing ingredients for ${item.name}${tableNote}. One recipe needs: ${needs.join(', ')}. You still need: ${still.join(', ')}.`;
}

/** "planks" / "wood" style names: the plank type we can make from the logs we carry. */
export function resolveCraftItem(bot, mcData, raw) {
  const n = normName(raw);
  if (/^(wood(en)?_)?planks?$|^wood$/.test(n)) {
    const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name));
    const planks = log ? log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks') : 'oak_planks';
    return mcData.itemsByName[planks] ?? mcData.itemsByName.oak_planks;
  }
  if (n === 'sticks') return mcData.itemsByName.stick;
  return resolveItem(mcData, raw);
}

async function craftingTable(ctx, made) {
  const { bot, mcData } = ctx;
  const near = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 });
  if (near) return near;
  if (countItem(bot, 'crafting_table') === 0) await autoCraft(ctx, mcData.itemsByName.crafting_table, 1, 1, made);
  return ensureStation(ctx, 'crafting_table', 'crafting table');
}

/**
 * Craft `count` of `item`. Missing ingredients that can themselves be crafted from what we carry are made
 * first (up to MAX_DEPTH levels), and a crafting table is made and placed if the recipe needs one.
 * `made` collects the in-between items crafted on the way, for the result message.
 */
export async function autoCraft(ctx, item, count, depth = 0, made = []) {
  const { bot, mcData } = ctx;
  ctx.throwIfCancelled();
  const variants = variantsByReadiness(bot, item, count);
  if (!variants.length) throw new ActionError(`${item.name} cannot be crafted (it may need smelting or be found in the world).`);
  let lastError = null;
  for (const { r } of variants.slice(0, 8)) {
    const times = Math.ceil(count / (r.result.count || 1));
    try {
      for (const m of missingFor(bot, r, times)) {
        if (depth >= MAX_DEPTH) throw new ActionError('too many steps');
        await autoCraft(ctx, mcData.items[m.id], m.count, depth + 1, made);
      }
      if (missingFor(bot, r, times).length) continue;
      const table = r.requiresTable ? await craftingTable(ctx, made) : null;
      if (table && bot.entity.position.distanceTo(table.position) > 3.5) await goNear(ctx, table.position, 2);
      // Re-resolve against the real table: mineflayer only accepts recipes it can see are possible.
      const recipe = bot.recipesFor(item.id, null, 1, table)[0];
      if (!recipe) continue;
      const n = Math.ceil(count / (recipe.result.count || 1));
      try {
        await bot.craft(recipe, n, table);
      } catch (err) {
        // The crafting window sometimes doesn't open in time (a busy server): step closer and try once more.
        if (!/did not fire within timeout/.test(err.message)) throw err;
        try { bot.currentWindow && bot.closeWindow(bot.currentWindow); } catch { /* */ }
        await new Promise((r) => setTimeout(r, 1_000));
        if (table) await goNear(ctx, table.position, 1);
        await bot.craft(recipe, n, table);
      }
      if (depth > 0) made.push(`${item.name} x${n * (recipe.result.count || 1)}`);
      return;
    } catch (err) {
      if (ctx.cancelled) throw err;
      lastError ??= err; // keep the best variant's reason; then try the next variant (e.g. other wood types)
    }
  }
  const best = variantsByReadiness(bot, item, count)[0];
  if (best && !best.missing.length && lastError) throw new ActionError(`Crafting ${item.name} failed: ${lastError.message}`);
  throw new ActionError(describeMissing(bot, mcData, item, count));
}
