// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { observe } from './observe.js';
import {
  ActionError, Vec3, goals, goNear, sleepMs, normName, resolveBlockIds, findInventoryItem,
  countItem, fmtPos, posObj, findPlayerEntity, placeItemAt, REPLACEABLE, pickUpDrops,
} from './util.js';
import { ensureStation, autoCraft, resolveCraftItem, missingItems } from './crafting.js';
import { BUILD_HANDLERS, carefulMovement } from './building.js';
import { hasWarrant } from '../agent/society.js';

const { GoalFollow, GoalXZ } = goals;

const BUILD_BLOCK_PREFERENCE = /(_planks$|^cobblestone$|^stone$|^dirt$|_log$|^cobbled_deepslate$|^stone_bricks$|^bricks$|^sandstone$)/;
const FUEL_VALUE = { coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100, blaze_rod: 12 };

// Logs well below us are mineshaft/cave supports, not trees; pathing down to them can lock up the pathfinder.
const MAX_LOG_DEPTH = 10;

function skipBuriedLogs(bot, positions) {
  const minY = bot.entity.position.y - MAX_LOG_DEPTH;
  return positions.filter((p) => p.y >= minY || !bot.blockAt(p)?.name.endsWith('_log'));
}

/**
 * Withdraw missing crafting ingredients from known shared chests within 64 blocks. Wood is flexible: any
 * planks or logs do for planks (planks come from logs), and for sticks. Returns what was fetched.
 */
async function fetchFromChests(ctx, missing) {
  const { bot, agent } = ctx;
  const me = bot.entity.position;
  const chests = Object.entries(agent.store.village.chests ?? {})
    .map(([key, c]) => { const [x, y, z] = key.split(',').map(Number); return { x, y, z, contents: { ...(c.contents ?? {}) } }; })
    .filter((c) => Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z) <= 64);
  const fetched = [];
  for (const m of missing) {
    const accepts = /_planks$/.test(m.name) ? /_planks$|_log$|_stem$/ : m.name === 'stick' ? /^stick$|_planks$|_log$|_stem$/ : null;
    for (const c of chests) {
      const have = Object.entries(c.contents).find(([n, k]) => k > 0 && (accepts ? accepts.test(n) : n === m.name));
      if (!have) continue;
      const [name] = have;
      // a log makes 4 planks (8 sticks); planks make 4 sticks
      const per = /_log$|_stem$/.test(name) ? (m.name === 'stick' ? 8 : 4) : name.endsWith('_planks') && m.name === 'stick' ? 2 : 1;
      const want = Math.min(have[1], Math.ceil(m.count / per) + 1);
      const r = await HANDLERS.use_chest(ctx, { operation: 'withdraw', item: name, count: want, x: c.x, y: c.y, z: c.z }).catch(() => null);
      if (r) {
        fetched.push(`${want} ${name}`);
        c.contents[name] -= want;
        break;
      }
    }
  }
  return fetched;
}

// Blocks a villager in this process is heading for, so the others pick different ones. "x,y,z" -> { name, t }
const claims = new Map();
const CLAIM_MS = 60_000;
function claim(pos, name) {
  if (claims.size > 500) for (const [k, c] of claims) if (Date.now() - c.t > CLAIM_MS) claims.delete(k);
  claims.set(pos.toString(), { name, t: Date.now() });
}
function claimedByOther(pos, name) {
  const c = claims.get(pos.toString());
  return !!c && c.name !== name && Date.now() - c.t < CLAIM_MS;
}
const nameSpread = (name) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function fuelValue(name) {
  if (FUEL_VALUE[name]) return FUEL_VALUE[name];
  if (name.endsWith('_planks') || name.endsWith('_log') || name.endsWith('_wood')) return 1.5;
  if (name === 'stick') return 0.5;
  return 0;
}

export const HANDLERS = {
  ...BUILD_HANDLERS,

  async observe(ctx) {
    return observe(ctx.agent);
  },

  async chat(ctx, { message }) {
    ctx.agent.say(message);
    return 'said';
  },

  async whisper(ctx, { player, message }) {
    ctx.agent.say(`/msg ${player} ${message}`, { raw: true });
    return `whispered to ${player}`;
  },

  async go_to(ctx, { x, y, z, range = 1 }) {
    ctx.agent.activity = `walking to ${x},${y},${z}`;
    await goNear(ctx, { x, y, z }, range, 180_000);
    return `Arrived near ${x},${y},${z}. Now at ${fmtPos(ctx.bot.entity.position)}.`;
  },

  async go_to_player(ctx, { player, range = 2 }) {
    const e = findPlayerEntity(ctx.bot, player);
    if (!e) throw new ActionError(`I can't see ${player} (too far away or offline).`);
    ctx.agent.activity = `walking to ${player}`;
    await goNear(ctx, e.position, range, 120_000);
    return `Reached ${player}.`;
  },

  async follow(ctx, { target, distance = 3 }) {
    const { bot } = ctx;
    let e = findPlayerEntity(bot, target);
    if (!e) e = bot.nearestEntity((x) => x.name === normName(target));
    if (!e) throw new ActionError(`I can't see "${target}".`);
    bot.pathfinder.setGoal(new GoalFollow(e, distance), true);
    ctx.agent.activity = `following ${e.username ?? e.name}`;
    return `Now following ${e.username ?? e.name}. Use "stop" to stop.`;
  },

  async stop(ctx) {
    ctx.agent.halt();
    return 'Stopped.';
  },

  async explore(ctx, { distance = 40 }) {
    const { bot } = ctx;
    const angle = Math.random() * Math.PI * 2;
    const p = bot.entity.position;
    const tx = Math.floor(p.x + Math.cos(angle) * distance);
    const tz = Math.floor(p.z + Math.sin(angle) * distance);
    ctx.agent.activity = `exploring towards ${tx}, ${tz}`;
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalXZ(tx, tz)),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            bot.pathfinder.stop();
            resolve();
          }, Math.max(30_000, distance * 1500));
        }),
      ]);
    } catch {
      /* partial progress is fine */
    } finally {
      clearTimeout(timer);
    }
    return { now_at: fmtPos(bot.entity.position), surroundings: observe(ctx.agent).nearby_blocks };
  },

  async find_block(ctx, { block, max_distance = 64 }) {
    max_distance = Math.min(Math.max(Number(max_distance) || 64, 8), 128); // the model sometimes asks for 200+
    const ids = resolveBlockIds(ctx.mcData, block);
    const found = skipBuriedLogs(ctx.bot, ctx.bot.findBlocks({ matching: ids, maxDistance: max_distance, count: 40 })).slice(0, 5);
    if (!found.length) return `No ${block} within ${max_distance} blocks. Try exploring.`;
    const me = ctx.bot.entity.position;
    return found.map((p) => `${ctx.bot.blockAt(p)?.name} at ${p.x},${p.y},${p.z} (${Math.round(p.distanceTo(me))}m)`);
  },

  async collect_block(ctx, { block, count = 1 }) {
    const { bot, mcData } = ctx;
    const ids = resolveBlockIds(mcData, block);
    const failed = new Set();
    let collected = 0;
    ctx.agent.activity = `collecting ${count} ${block}`;
    const before = { ...ctx.agent.inventorySnapshot() };
    // Only blocks we finished digging ourselves count: the plugin also "succeeds" when it skips a block, or
    // when another villager broke it first (and got the drops).
    let lastDug = null;
    const onDug = (b) => { lastDug = b.position.toString(); };
    bot.on('diggingCompleted', onDug);
    try {
      for (let attempts = 0; collected < count && attempts < count + 6; attempts++) {
        ctx.throwIfCancelled();
        const candidates = skipBuriedLogs(bot, bot.findBlocks({ matching: ids, maxDistance: 48, count: 40 }))
          .filter((p) => !failed.has(p.toString()) && !claimedByOther(p, ctx.agent.name));
        if (!candidates.length) break;
        // Spread out: villagers prefer different blocks among the nearest few rather than all racing for one.
        const pick = candidates[Math.min(candidates.length - 1, nameSpread(ctx.agent.name) % 3)];
        const target = bot.blockAt(pick);
        claim(pick, ctx.agent.name);
        lastDug = null;
        try {
          await bot.collectBlock.collect(target, { ignoreNoPath: false });
          if (lastDug !== pick.toString()) {
            failed.add(pick.toString());
            continue;
          }
          collected++;
          await pickUpDrops(ctx, target.position.offset(0.5, 0.5, 0.5));
        } catch (err) {
          failed.add(pick.toString());
          if (/full/i.test(err.message)) throw new ActionError('Inventory is full. Store or drop items first.');
          if (err.name === 'NoItem') throw new ActionError(`I have no tool that can harvest ${target.name}. Craft the right one first (e.g. a wooden_pickaxe for stone).`);
        }
      }
    } finally {
      bot.removeListener('diggingCompleted', onDug);
    }
    const after = ctx.agent.inventorySnapshot();
    const gained = Object.entries(after)
      .map(([k, v]) => [k, v - (before[k] ?? 0)])
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} +${v}`);
    if (!collected) throw new ActionError(`Couldn't collect any ${block} (none free within 48 blocks: others may be harvesting here). Use find_block to locate some further away, go_to it, then collect_block again.`);
    return `Mined ${collected}/${count}. Inventory gained: ${gained.join(', ') || 'nothing (drops may be on the ground)'}.`;
  },

  async dig_block(ctx, { x, y, z }) {
    const { bot } = ctx;
    const pos = new Vec3(x, y, z);
    const block = bot.blockAt(pos);
    if (!block || REPLACEABLE.has(block.name)) return `Nothing to dig at ${x},${y},${z}.`;
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) await goNear(ctx, pos, 3);
    const tool = bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, 'hand');
    if (!bot.canDigBlock(block)) throw new ActionError(`Can't dig ${block.name} from here.`);
    ctx.agent.activity = `digging ${block.name}`;
    await bot.dig(block);
    await pickUpDrops(ctx, pos.offset(0.5, 0.5, 0.5), { radius: 4, maxMs: 5_000 });
    return `Dug ${block.name} at ${x},${y},${z}.`;
  },

  /** Dig up the pillars and bridges the pathfinder left behind (see AgentBot.trackScaffolding). */
  async clean_up(ctx, { range = 48 } = {}) {
    const { bot, agent } = ctx;
    const todo = agent.leftoverScaffold(range);
    if (!todo.length) return 'No leftover blocks of mine to clean up nearby.';
    agent.activity = 'cleaning up';
    let removed = 0;
    const deadline = Date.now() + 120_000;
    // A block we can't get at after a few tries (e.g. the top of a tall tower) is given up on.
    const failed = (pos) => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const s = agent.scaffold.get(key);
      if (s && ++s.fails >= 3) agent.scaffold.delete(key);
    };
    // No towering or bridging while tidying, or we'd just leave new mess behind.
    await carefulMovement(bot, async () => {
      for (const pos of todo) {
        if (Date.now() > deadline) break;
        ctx.throwIfCancelled();
        const block = bot.blockAt(pos);
        if (!block || REPLACEABLE.has(block.name)) continue;
        if (pos.equals(bot.entity.position.floored().offset(0, -1, 0))) continue; // standing on it
        try {
          if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) await goNear(ctx, pos, 3);
          const tool = bot.pathfinder.bestHarvestTool(block);
          if (tool) await bot.equip(tool, 'hand');
          if (!bot.canDigBlock(block)) { failed(pos); continue; }
          await bot.dig(block);
          removed++;
        } catch {
          ctx.throwIfCancelled();
          failed(pos);
        }
      }
    });
    const left = agent.leftoverScaffold(range).length;
    return `Cleaned up ${removed} leftover block${removed === 1 ? '' : 's'}${left ? ` (${left} still out of reach)` : ''}.`;
  },

  async place_block(ctx, { block, x, y, z }) {
    const item = findInventoryItem(ctx.bot, block);
    if (!item) throw new ActionError(`I don't have any ${block}.`);
    const r = await placeItemAt(ctx, item, new Vec3(x, y, z));
    return `${item.name} ${r} at ${x},${y},${z}.`;
  },

  async build_shelter(ctx, { block } = {}) {
    const { bot } = ctx;
    let item;
    if (block) {
      item = findInventoryItem(bot, block);
      if (!item) throw new ActionError(`I don't have any ${block}.`);
    } else {
      const counts = Object.entries(ctx.agent.inventorySnapshot()).filter(([n]) => BUILD_BLOCK_PREFERENCE.test(n));
      counts.sort((a, b) => b[1] - a[1]);
      if (!counts.length) throw new ActionError('No building blocks in inventory (planks, cobblestone, dirt, logs...).');
      item = findInventoryItem(bot, counts[0][0]);
    }
    const material = item.name;
    const total = countItem(bot, material);
    if (total < 40) throw new ActionError(`Need ~70 ${material} for a hut, I only have ${total}.`);

    bot.pathfinder.stop();
    const base = bot.entity.position.floored();
    const targets = [];
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          const doorway = dx === 0 && dz === 2 && dy < 2;
          if (edge && !doorway) targets.push(base.offset(dx, dy, dz));
        }
      }
    }
    const roof = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) roof.push(base.offset(dx, 3, dz));
    roof.sort((a, b) => b.distanceTo(base) - a.distanceTo(base)); // edges first so each block has support
    targets.push(...roof);

    ctx.agent.activity = `building a ${material} hut at ${fmtPos(base)}`;
    let placed = 0;
    let skipped = 0;
    for (const p of targets) {
      ctx.throwIfCancelled();
      const it = bot.inventory.items().find((i) => i.name === material);
      if (!it) break;
      try {
        const r = await placeItemAt(ctx, it, p, { move: false });
        if (r === 'placed') placed++;
      } catch {
        skipped++;
      }
    }
    ctx.agent.memory.home ??= posObj(base);
    ctx.agent.saveMemory();
    return `Hut built at ${fmtPos(base)}: placed ${placed} ${material}, skipped ${skipped}. Doorway faces south (+Z).`;
  },

  async craft(ctx, { item: rawItem, count = 1 }) {
    const { bot, mcData } = ctx;
    const item = resolveCraftItem(bot, mcData, rawItem);
    ctx.agent.activity = `crafting ${item.name}`;
    const before = countItem(bot, item.name);
    const made = [];
    count = Math.max(1, Number(count) || 1);
    let fetched = [];
    try {
      await autoCraft(ctx, item, count, 0, made);
    } catch (err) {
      // Missing ingredients the village already has in a chest nearby: fetch them and try again.
      if (!(err instanceof ActionError) || !/^Missing ingredients/.test(err.message)) throw err;
      fetched = await fetchFromChests(ctx, missingItems(bot, mcData, item, count));
      if (!fetched.length) throw err;
      await autoCraft(ctx, item, count, 0, made);
    }
    const now = countItem(bot, item.name);
    const extras = [...(fetched.length ? [`fetched ${fetched.join(', ')} from the village chests`] : []), ...(made.length ? [`made ${made.join(', ')} on the way`] : [])];
    return `Crafted ${now - before} ${item.name}${extras.length ? ` (${extras.join('; ')})` : ''}. Now have ${now}.`;
  },

  async smelt(ctx, { item: rawItem, count = 1, fuel }) {
    const { bot, mcData } = ctx;
    const input = findInventoryItem(bot, rawItem);
    if (!input) throw new ActionError(`I don't have any ${rawItem}.`);
    count = Math.min(count, countItem(bot, input.name));
    let fuelItem = fuel ? findInventoryItem(bot, fuel) : null;
    if (!fuelItem) {
      fuelItem = bot.inventory.items()
        .filter((i) => fuelValue(i.name) > 0 && i.name !== input.name)
        .sort((a, b) => fuelValue(b.name) - fuelValue(a.name))[0];
    }
    if (!fuelItem) throw new ActionError('No fuel (coal, charcoal, planks or logs).');
    // Smokers cook food and blast furnaces smelt ores twice as fast as a furnace: use one when it's there.
    // Worth a short walk to the village's smokers/furnaces (64 blocks) rather than failing.
    const fast = mcData.foodsByName[input.name] ? 'smoker' : /^raw_|_ore$|ancient_debris/.test(input.name) ? 'blast_furnace' : null;
    const near = (name) => bot.findBlock({ matching: mcData.blocksByName[name].id, maxDistance: 64 });
    const carried = (name) => findInventoryItem(bot, name)?.name === name;
    let station = 'furnace';
    if (fast && (near(fast) || (carried(fast) && !near('furnace')))) station = fast;
    if (station === 'furnace' && !near('furnace') && !carried('furnace')) {
      throw new ActionError(`No ${fast ? `${fast.replace('_', ' ')} or ` : ''}furnace within 64 blocks and none in inventory. Craft a furnace (8 cobblestone) or go to the village's.`);
    }
    const furnaceBlock = await ensureStation(ctx, station, station.replace('_', ' '), 64);
    // Each item takes 10 s in a furnace, 5 s in a smoker or blast furnace.
    const perItemMs = station === 'furnace' ? 10_500 : 5_300;
    ctx.agent.activity = `smelting ${count} ${input.name} in a ${station.replace('_', ' ')}`;
    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      // Fuel burns twice as fast in a smoker or blast furnace too.
      const perFuel = fuelValue(fuelItem.name) / (station === 'furnace' ? 1 : 2);
      const fuelNeeded = Math.min(countItem(bot, fuelItem.name), Math.ceil(count / perFuel));
      if (fuelNeeded > 0) await furnace.putFuel(fuelItem.type, null, fuelNeeded);
      await furnace.putInput(input.type, null, count);
      const deadline = Date.now() + count * perItemMs + 5_000;
      while (Date.now() < deadline) {
        ctx.throwIfCancelled();
        await sleepMs(2000);
        const out = furnace.outputItem();
        if (out && out.count >= count) break;
        if (!furnace.inputItem()) break;
      }
      const out = furnace.outputItem();
      if (out) await furnace.takeOutput();
      return out ? `Smelted ${out.count} ${out.name} in a ${station.replace('_', ' ')}.` : `Nothing came out yet — the ${station.replace('_', ' ')} may need more fuel.`;
    } finally {
      furnace.close();
    }
  },

  async use_chest(ctx, { operation, item, count, x, y, z }) {
    const { bot, mcData } = ctx;
    const ids = ['chest', 'barrel', 'trapped_chest'].map((n) => mcData.blocksByName[n]?.id).filter(Boolean);
    // A specific chest (by coordinates), or the nearest one.
    let chestBlock = null;
    if ([x, y, z].every((v) => Number.isFinite(Number(v)))) {
      const target = new Vec3(Number(x), Number(y), Number(z));
      if (bot.entity.position.distanceTo(target) > 24) await goNear(ctx, target, 3, 120_000);
      chestBlock = bot.blockAt(target);
      if (!chestBlock || !ids.includes(chestBlock.type)) throw new ActionError(`There's no chest at ${x}, ${y}, ${z} any more.`);
    } else {
      chestBlock = bot.findBlock({ matching: ids, maxDistance: 32 });
    }
    if (!chestBlock) throw new ActionError('No chest within 32 blocks.');
    await goNear(ctx, chestBlock.position, 2);
    const chest = await bot.openContainer(chestBlock);
    const contents = () => {
      const out = {};
      for (const i of chest.containerItems()) out[i.name] = (out[i.name] ?? 0) + i.count;
      return out;
    };
    try {
      if (operation === 'view') return { chest_at: fmtPos(chestBlock.position), contents: contents() };
      if (!item) throw new ActionError('Say which item.');
      if (operation === 'deposit') {
        const it = findInventoryItem(bot, item);
        if (!it) throw new ActionError(`I don't have any ${item}.`);
        const n = Math.min(count ?? Infinity, countItem(bot, it.name));
        await chest.deposit(it.type, null, n);
        return `Deposited ${n} ${it.name}. Chest now: ${JSON.stringify(contents())}`;
      }
      const want = normName(item);
      const it = chest.containerItems().find((i) => i.name === want) ?? chest.containerItems().find((i) => i.name.includes(want));
      if (!it) throw new ActionError(`No ${item} in the chest. It has: ${JSON.stringify(contents())}`);
      const n = Math.min(count ?? it.stackSize ?? 64, contents()[it.name]);
      await chest.withdraw(it.type, null, n);
      return `Took ${n} ${it.name}.`;
    } finally {
      ctx.agent.store.noteChest(chestBlock.position, contents());
      chest.close();
    }
  },

  /**
   * Open the chests and barrels nearby, remember what's in each (shared with the village), and optionally
   * take an item from whichever one has it.
   */
  async search_chests(ctx, { item, count } = {}) {
    const { bot, mcData, agent } = ctx;
    const ids = ['chest', 'barrel', 'trapped_chest'].map((n) => mcData.blocksByName[n]?.id).filter(Boolean);
    const spots = bot.findBlocks({ matching: ids, maxDistance: 32, count: 8 });
    if (!spots.length) throw new ActionError('No chests or barrels within 32 blocks.');
    const want = item ? normName(item) : null;
    const matches = (n) => want && (n === want || n.endsWith(`_${want}`) || (want.endsWith('s') && n.endsWith(`_${want.slice(0, -1)}`)));
    const seen = [];
    agent.activity = want ? `searching chests for ${want}` : 'checking the chests';
    for (const pos of spots) {
      ctx.throwIfCancelled();
      try {
        await goNear(ctx, pos, 2, 30_000);
        const chest = await bot.openContainer(bot.blockAt(pos));
        const contents = {};
        try {
          for (const i of chest.containerItems()) contents[i.name] = (contents[i.name] ?? 0) + i.count;
          const found = Object.keys(contents).find(matches);
          if (found) {
            const it = chest.containerItems().find((i) => i.name === found);
            const n = Math.min(Number(count) || it.stackSize || 64, contents[found]);
            await chest.withdraw(it.type, null, n);
            contents[found] -= n;
            agent.store.noteChest(pos, contents);
            return `Found ${found} in the chest at ${fmtPos(pos)} and took ${n}. It also holds: ${Object.entries(contents).filter(([, c]) => c > 0).map(([k, c]) => `${k} ${c}`).join(', ') || 'nothing else'}.`;
          }
        } finally {
          agent.store.noteChest(pos, contents);
          chest.close();
        }
        seen.push(`${fmtPos(pos)}: ${Object.entries(contents).map(([k, c]) => `${k} ${c}`).join(', ') || 'empty'}`);
      } catch (err) {
        if (ctx.cancelled) throw err;
        seen.push(`${fmtPos(pos)}: couldn't reach it`);
      }
    }
    if (want) throw new ActionError(`No ${want} in the ${spots.length} chests nearby. ${seen.join(' | ')}`);
    return `Chests nearby: ${seen.join(' | ')}`;
  },

  /**
   * Trade with a real Minecraft villager (or wandering trader). With no arguments: list its trades.
   * want=<item>: buy that item; give=<item>: sell that item (usually for emeralds). Repeats up to `times`.
   */
  async trade_villager(ctx, { want, give, times = 1 } = {}) {
    const { bot, agent } = ctx;
    const trader = bot.nearestEntity((e) => (e.name === 'villager' || e.name === 'wandering_trader') && e.position.distanceTo(bot.entity.position) < 32);
    if (!trader) throw new ActionError('No Minecraft villager or wandering trader within 32 blocks. Find a village first (explore).');
    agent.activity = 'trading with a villager';
    await goNear(ctx, trader.position, 2, 60_000);
    const window = await bot.openVillager(trader);
    try {
      const nameOf = (it) => (it ? `${it.count} ${it.name}` : null);
      const trades = window.trades ?? [];
      if (!trades.length) return 'This villager has no trades (it may be a jobless villager or a nitwit).';
      const describe = trades.map((t, i) => `#${i}: ${[nameOf(t.inputItem1), nameOf(t.inputItem2)].filter(Boolean).join(' + ')} -> ${nameOf(t.outputItem)}${t.tradeDisabled ? ' (sold out)' : ''}`).join('; ');
      const w = want ? normName(want) : null;
      const g = give ? normName(give) : null;
      if (!w && !g) return `Trades on offer: ${describe}`;
      const has = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((s, i) => s + i.count, 0);
      const ok = (t) => !t.tradeDisabled
        && (!w || t.outputItem?.name === w || t.outputItem?.name.endsWith(`_${w}`))
        && (!g || t.inputItem1?.name === g || t.inputItem1?.name.endsWith(`_${g}`))
        && has(t.inputItem1.name) >= t.inputItem1.count
        && (!t.inputItem2 || has(t.inputItem2.name) >= t.inputItem2.count);
      const index = trades.findIndex(ok);
      if (index < 0) throw new ActionError(`No trade I can afford for that here. Trades: ${describe}`);
      const t = trades[index];
      let done = 0;
      for (; done < Math.min(Number(times) || 1, 16); done++) {
        if (!ok(window.trades[index])) break;
        await bot.trade(window, index, 1);
      }
      if (!done) throw new ActionError(`Couldn't make the trade. Trades: ${describe}`);
      return `Traded ${done} time(s): ${[nameOf(t.inputItem1), nameOf(t.inputItem2)].filter(Boolean).join(' + ')} -> ${nameOf(t.outputItem)} each.`;
    } finally {
      window.close();
    }
  },

  async equip(ctx, { item, slot = 'hand' }) {
    const it = findInventoryItem(ctx.bot, item);
    if (!it) throw new ActionError(`I don't have ${item}.`);
    await ctx.bot.equip(it, slot);
    return `Equipped ${it.name} (${slot}).`;
  },

  async eat(ctx, { item } = {}) {
    return ctx.agent.eat(item);
  },

  async attack(ctx, { target }) {
    const { bot, agent } = ctx;
    let e = findPlayerEntity(bot, target);
    // Players are off limits, with one exception: a villager with an arrest warrant (see agent/society.js).
    // Human players are never attackable unless allowAttackingPlayers is set in bots.json.
    if (e && !agent.config.allowAttackingPlayers) {
      const isVillager = agent.allAgentNames.has(e.username);
      if (!isVillager) throw new ActionError('Attacking players is not allowed.');
      if (!hasWarrant(agent.store, e.username)) throw new ActionError(`${e.username} is a fellow villager and isn't wanted. Attacking them is a crime; report them instead if they broke a law.`);
    }
    if (!e) e = bot.nearestEntity((x) => x.name === normName(target) && x.position.distanceTo(bot.entity.position) < 24);
    if (!e) throw new ActionError(`No ${target} within 24 blocks.`);
    await agent.equipBestWeapon();
    agent.activity = `fighting ${e.username ?? e.name}`;
    // attack() only sets its target after a tick: wait for it, or the loop below ends at once ("gave up"
    // after 0 ms) while the fight carries on unsupervised.
    await bot.pvp.attack(e);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && e.isValid && bot.pvp.target) {
      ctx.throwIfCancelled();
      await sleepMs(500);
    }
    bot.pvp.stop();
    if (e.isValid) return `Gave up fighting ${e.name} (health ${Math.round(bot.health)}).`;
    // Pick up what it dropped (meat, leather, wool...) before moving on.
    const before = agent.inventorySnapshot();
    await pickUpDrops(ctx, e.position, { radius: 8 });
    const after = agent.inventorySnapshot();
    const got = Object.entries(after).filter(([n, c]) => c > (before[n] ?? 0)).map(([n, c]) => `${c - (before[n] ?? 0)} ${n}`);
    return `Defeated ${e.username ?? e.name}.${got.length ? ` Picked up ${got.join(', ')}.` : ''}`;
  },

  async sleep(ctx) {
    const { bot, mcData } = ctx;
    const beds = mcData.blocksArray.filter((b) => b.name.endsWith('_bed')).map((b) => b.id);
    const bed = bot.findBlock({ matching: beds, maxDistance: 48 });
    if (!bed) throw new ActionError('No bed within 48 blocks. Craft one from 3 wool + 3 planks.');
    await goNear(ctx, bed.position, 2);
    try {
      await bot.sleep(bed);
    } catch (err) {
      throw new ActionError(`Can't sleep: ${err.message}`);
    }
    ctx.agent.activity = 'sleeping';
    return 'Sleeping in bed. Will wake at morning.';
  },

  async give_item(ctx, { player, item, count = 1 }) {
    const { bot } = ctx;
    const it = findInventoryItem(bot, item);
    if (!it) throw new ActionError(`I don't have ${item}.`);
    const e = findPlayerEntity(bot, player);
    if (!e) throw new ActionError(`I can't see ${player}.`);
    await goNear(ctx, e.position, 2, 120_000);
    await bot.lookAt(e.position.offset(0, 1.6, 0));
    const n = Math.min(count, countItem(bot, it.name));
    await bot.toss(it.type, null, n);
    return `Tossed ${n} ${it.name} to ${player}.`;
  },

  async recover_items(ctx, { x, y, z } = {}) {
    const { bot, agent } = ctx;
    const coords = [x, y, z].every((v) => Number.isFinite(Number(v)));
    const site = coords
      ? { pos: { x: Number(x), y: Number(y), z: Number(z) } }
      : [...(agent.memory.deathSites ?? [])].reverse().find((d) => !d.recovered);
    if (!site) throw new ActionError('No death site with lost items to recover. Give coordinates to pick up items somewhere else.');
    agent.activity = `recovering items at ${fmtPos(site.pos)}`;
    const before = agent.inventorySnapshot();
    await goNear(ctx, site.pos, 3, 180_000);

    const center = new Vec3(site.pos.x, site.pos.y, site.pos.z);
    const tried = new Map(); // entity id -> attempts, so one unreachable item can't stall us
    const drops = () => Object.values(bot.entities)
      .filter((e) => e.name === 'item' && e.position.distanceTo(center) < 12 && (tried.get(e.id) ?? 0) < 2)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    for (let i = 0; i < 40; i++) {
      ctx.throwIfCancelled();
      const item = drops()[0];
      if (!item) break;
      tried.set(item.id, (tried.get(item.id) ?? 0) + 1);
      try {
        await goNear(ctx, item.position, 1, 10_000);
      } catch (err) {
        if (ctx.cancelled) throw err; // otherwise unreachable: try the next one
      }
      await sleepMs(400); // pickup happens a moment after we get close
    }

    const after = agent.inventorySnapshot();
    const gained = Object.entries(after)
      .map(([k, v]) => [k, v - (before[k] ?? 0)])
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} +${v}`);
    const left = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(center) < 12).length;
    const expired = site.t && Date.now() - site.t > 5 * 60_000;
    if (site.t && (left === 0 || expired)) {
      site.recovered = true;
      agent.saveMemory();
    }
    if (gained.length) return `Recovered ${gained.join(', ')}.${left ? ` ${left} item stack(s) still here but out of reach.` : ''}`;
    if (expired) return 'Nothing left: items despawn about 5 minutes after death. Gave up on that spot.';
    throw new ActionError(left ? `Found ${left} dropped item stack(s) but could not reach them.` : 'No dropped items here (already picked up or despawned).');
  },

  async set_home(ctx) {
    ctx.agent.memory.home = posObj(ctx.bot.entity.position);
    ctx.agent.saveMemory();
    return `Home set to ${fmtPos(ctx.bot.entity.position)}.`;
  },

  async go_home(ctx) {
    const target = ctx.agent.memory.home ?? ctx.agent.store.village.center;
    if (!target) throw new ActionError('No home or village centre set yet. Use set_home.');
    ctx.agent.activity = 'going home';
    await goNear(ctx, target, 2, 240_000);
    return `Home (${fmtPos(target)}).`;
  },
};
