// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Blueprint builders: the villager decides what and where, these place every block. Each build follows the
// ground, clears plants in the way, steps aside instead of building on itself, and can be run again with the
// same settings to carry on where it stopped (blocks already in place are skipped).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ActionError, Vec3, goals, goNear, sleepMs, fmtPos, placeItemAt, REPLACEABLE, countItem } from './util.js';
import { autoCraft } from './crafting.js';
import { ROOT } from '../config.js';
import { log } from '../log.js';

const require = createRequire(import.meta.url);
const { Schematic } = require('prismarine-schematic');
const SCHEMATIC_DIR = path.join(ROOT, 'schematics');

const MAX_BLOCKS_PER_CALL = 160;
// Building blocks, best first. "any" picks whichever of these the villager has most of.
const BUILD_MATERIALS = ['cobblestone', 'stone_bricks', 'bricks', 'stone', 'cobbled_deepslate', 'sandstone', '_planks', '_log', 'dirt'];
const isBuildMaterial = (name) => BUILD_MATERIALS.some((m) => (m.startsWith('_') ? name.endsWith(m) : name === m));
// Soft things that may stand where a block should go: cleared rather than counted as "already built".
const SOFT = /leaves|flower|sapling|bush|vine|fern|grass$|tulip|daisy|orchid|allium|bluet|poppy|dandelion|lily|snow$|dead_bush|sweet_berry/;
// Never dug out when hollowing a house: things villagers (or you) put there on purpose.
const KEEP = /chest|barrel|furnace|smoker|crafting_table|_bed$|_door$|torch|lantern|anvil|enchanting|brewing|shulker/;
const SIDES = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** Names of inventory items that count as the requested material ("any", "planks", "cobblestone"...). */
function allowedMaterials(bot, material = 'any') {
  const want = String(material).toLowerCase().replace(/^minecraft:/, '').trim();
  const names = [...new Set(bot.inventory.items().map((i) => i.name))];
  if (!want || want === 'any') return names.filter(isBuildMaterial);
  const fam = want.replace(/s$/, '');
  return names.filter((n) => n === want || n === fam || n.endsWith(`_${fam}`) || n.endsWith(`_${want}`));
}
/** The allowed material we have most of, so a build stays one material for as long as possible. */
function nextMaterial(bot, names) {
  const best = names.map((n) => [n, countItem(bot, n)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
  return best ? bot.inventory.items().find((i) => i.name === best[0]) : null;
}

const isSolidGround = (b) => b && b.boundingBox === 'block' && !REPLACEABLE.has(b.name) && !/leaves|_log$/.test(b.name);

/** The y of the top solid ground block in column x,z, searching around `nearY`. */
function groundAt(bot, x, z, nearY) {
  for (let y = nearY + 8; y >= nearY - 16; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return null; // not loaded
    const above = bot.blockAt(new Vec3(x, y + 1, z));
    if (isSolidGround(b) && above && (REPLACEABLE.has(above.name) || SOFT.test(above.name))) return y;
  }
  return null;
}

async function withTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => { onTimeout?.(); rej(new Error('timeout')); }, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Walk a couple of blocks away from p (best effort), so we're not standing where a block must go. */
async function stepAway(ctx, p) {
  const { bot } = ctx;
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 2))), 6_000, () => bot.pathfinder.stop());
  } catch {
    /* best effort */
  }
}

/** While building, the pathfinder must not dig through or tower on what we're making. */
export async function carefulMovement(bot, fn) {
  const m = bot.pathfinder.movements;
  const saved = m ? { canDig: m.canDig, towers: m.allow1by1towers, scaffold: m.scafoldingBlocks } : null;
  if (m) {
    m.canDig = false;
    m.allow1by1towers = false;
    m.scafoldingBlocks = [];
  }
  try {
    return await fn();
  } finally {
    if (m) {
      m.canDig = saved.canDig;
      m.allow1by1towers = saved.towers;
      m.scafoldingBlocks = saved.scaffold;
    }
  }
}

/**
 * Place a block at every target (in order) with the allowed materials.
 * targets: [{ pos: Vec3, stand: y to stand at when reaching it }]
 */
async function placeAll(ctx, targets, names) {
  const { bot } = ctx;
  let placed = 0;
  let already = 0;
  let outOfMaterial = false;
  let pending = targets;
  const reasons = new Map(); // why spots failed on the last pass, for the summary
  for (let pass = 0; pass < 2 && pending.length && !outOfMaterial; pass++) {
    const retry = [];
    reasons.clear();
    for (let i = 0; i < pending.length; i++) {
      const { pos, stand } = pending[i];
      ctx.throwIfCancelled();
      const existing = bot.blockAt(pos);
      if (!existing) { retry.push(pending[i]); continue; }
      if (!REPLACEABLE.has(existing.name)) {
        if (!SOFT.test(existing.name)) { already++; continue; }
        try {
          await goNear(ctx, { x: pos.x, y: stand, z: pos.z }, 3, 30_000);
          await bot.dig(existing);
        } catch (err) {
          if (ctx.cancelled) throw err;
          retry.push(pending[i]);
          continue;
        }
      }
      // A target may name the block it would ideally be (schematics); use that if we carry it.
      const item = (pending[i].prefer && bot.inventory.items().find((it) => it.name === pending[i].prefer)) || nextMaterial(bot, names);
      if (!item) {
        outOfMaterial = true;
        retry.push(...pending.slice(i));
        break;
      }
      try {
        const feet = bot.entity.position.floored();
        if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) await stepAway(ctx, pos);
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) {
          await goNear(ctx, { x: pos.x, y: stand, z: pos.z }, 3, 30_000);
        }
        const r = await placeItemAt(ctx, item, pos, { move: false });
        if (r === 'placed') placed++;
        else already++;
      } catch (err) {
        if (ctx.cancelled) throw err;
        const why = String(err.message).replace(/( at| next to)? \(?-?\d+, -?\d+, -?\d+\)?/g, '').replace(/\.$/, '');
        const seen = reasons.get(why) ?? { n: 0, at: fmtPos(pos) };
        seen.n++;
        reasons.set(why, seen);
        retry.push(pending[i]);
      }
    }
    pending = retry;
  }
  const why = [...reasons].map(([w, { n, at }]) => `${w}, e.g. at ${at}${n > 1 ? ` (x${n})` : ''}`).join('; ');
  return { placed, already, left: pending.length, outOfMaterial, why };
}

/** Dig out every solid block at the given positions (inside a house on a slope, the doorway). */
async function clearAll(ctx, positions, stand) {
  const { bot } = ctx;
  let cleared = 0;
  for (const pos of positions) {
    ctx.throwIfCancelled();
    const b = bot.blockAt(pos);
    if (!b || REPLACEABLE.has(b.name) || b.name === 'air' || !b.diggable || KEEP.test(b.name)) continue;
    try {
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.3) await goNear(ctx, { x: pos.x, y: stand, z: pos.z }, 3, 30_000);
      const tool = bot.pathfinder.bestHarvestTool(b);
      if (tool) await bot.equip(tool, 'hand');
      await bot.dig(b);
      cleared++;
    } catch (err) {
      if (ctx.cancelled) throw err;
    }
  }
  return cleared;
}

/** Break grass and ferns near `center` and pick up what drops, until we have seeds (or run out of grass). */
async function gatherSeeds(ctx, center, seedNames, want = 8) {
  const { bot, mcData } = ctx;
  const ids = ['short_grass', 'tall_grass', 'grass', 'fern', 'large_fern'].map((n) => mcData.blocksByName[n]?.id).filter((v) => v != null);
  const has = () => bot.inventory.items().filter((i) => seedNames.includes(i.name)).reduce((n, i) => n + i.count, 0);
  let broken = 0;
  for (let round = 0; round < 3 && has() < want; round++) {
    const grass = bot.findBlocks({ matching: ids, maxDistance: 20, count: 30, point: center })
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    if (!grass.length) break;
    for (const p of grass) {
      ctx.throwIfCancelled();
      if (has() >= want) break;
      try {
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) await goNear(ctx, p, 2, 15_000);
        const b = bot.blockAt(p);
        if (b && ids.includes(b.type)) {
          await bot.dig(b);
          broken++;
        }
      } catch (err) {
        if (ctx.cancelled) throw err;
      }
    }
    // Walk over any seeds that dropped.
    for (let i = 0; i < 12; i++) {
      const drop = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(center) < 24)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!drop) break;
      try { await goNear(ctx, drop.position, 1, 8_000); } catch (err) { if (ctx.cancelled) throw err; break; }
      await sleepMs(250);
    }
  }
  return broken;
}

// ---------- schematics ----------

// In "shape" mode these are left out: windows stay open, furniture/lights/plants/railings are skipped,
// so a survival villager can build the structure from the blocks it can actually get.
const DECORATION = /glass|pane|torch|lantern|candle|flower|dandelion|poppy|tulip|orchid|lilac|rose|peony|sapling|leaves|vine|carpet|_bed$|banner|_sign$|chest|barrel|anvil|furnace|smoker|crafting_table|enchanting|brewing|grindstone|loom|cauldron|hopper|cartography|lectern|stonecutter|smithing|bell|jukebox|note_block|flower_pot|ladder|trapdoor|_door$|_fence|fence_gate|iron_bars|chain|button|lever|pressure_plate|rail|redstone|skull|head$|_dirt$|grass|snow|water|lava|scaffolding/;

function listSchematicFiles() {
  if (!fs.existsSync(SCHEMATIC_DIR)) return [];
  return fs.readdirSync(SCHEMATIC_DIR).filter((f) => /\.(schem|schematic)$/i.test(f));
}

function credits() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SCHEMATIC_DIR, 'credits.json'), 'utf8'));
  } catch {
    return {};
  }
}

const schematicCache = new Map();
/** Read a design and split it into structural blocks (to build) and decoration (skipped in shape mode). */
async function loadDesign(name, version) {
  const file = listSchematicFiles().find((f) => f.replace(/\.(schem|schematic)$/i, '').toLowerCase() === String(name).toLowerCase().replace(/\.(schem|schematic)$/i, ''));
  if (!file) throw new ActionError(`No design called "${name}". Use list_schematics to see what's available.`);
  const key = `${file}@${version}`;
  if (!schematicCache.has(key)) {
    const s = await Schematic.read(fs.readFileSync(path.join(SCHEMATIC_DIR, file)), version);
    const start = s.start();
    const end = s.end();
    const blocks = [];
    await s.forEach((block, pos) => {
      if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return;
      blocks.push({ rel: pos.minus(start), name: block.name, structural: block.boundingBox === 'block' && !DECORATION.test(block.name) });
    });
    // Layer by layer, snaking back and forth along each row so the builder walks as little as possible.
    blocks.sort((a, b) => a.rel.y - b.rel.y || a.rel.x - b.rel.x || (a.rel.x % 2 ? b.rel.z - a.rel.z : a.rel.z - b.rel.z));
    const size = end.minus(start).offset(1, 1, 1);
    schematicCache.set(key, { name: file.replace(/\.(schem|schematic)$/i, ''), size, blocks, credit: credits()[file.replace(/\.(schem|schematic)$/i, '')] ?? 'your own download (credit its creator in schematics/credits.json)' });
  }
  return schematicCache.get(key);
}

function summarise(label, total, r, names, again) {
  const done = total - r.left;
  let s = `${label}: ${done}/${total} blocks in place (${r.placed} placed now).`;
  if (r.left === 0) return `${s} Finished!`;
  if (r.outOfMaterial) s += ` Ran out of building blocks: need about ${r.left} more (${names.length ? names.join('/') : 'cobblestone, planks...'}). Gather or fetch them, then run ${again} again with the same settings to carry on.`;
  else s += ` ${r.left} spots couldn't be built yet${r.why ? ` (${r.why})` : ''}. Run ${again} again to carry on.`;
  return s;
}

export const BUILD_HANDLERS = {
  async list_schematics(ctx) {
    const out = [];
    for (const f of listSchematicFiles()) {
      try {
        const d = await loadDesign(f, ctx.bot.version);
        const solid = d.blocks.filter((b) => b.structural).length;
        out.push(`${d.name}: ${d.size.x} wide x ${d.size.z} deep x ${d.size.y} tall, about ${solid} building blocks (${d.credit})`);
      } catch (err) {
        out.push(`${f}: could not be read (${err.message})`);
      }
    }
    return out.length ? out : 'No designs yet. Put .schem files in the schematics folder.';
  },

  async build_schematic(ctx, { name, x, y, z, materials = 'shape', dry_run = false } = {}) {
    const { bot, agent } = ctx;
    const design = await loadDesign(name, bot.version);
    const me = bot.entity.position.floored();
    const x0 = Number.isFinite(Number(x)) ? Number(x) : me.x + 2;
    const z0 = Number.isFinite(Number(z)) ? Number(z) : me.z + 2;
    const cx = x0 + Math.floor(design.size.x / 2);
    const cz = z0 + Math.floor(design.size.z / 2);
    let y0 = Number(y);
    if (!Number.isFinite(y0)) {
      const g = groundAt(bot, cx, cz, me.y);
      if (g == null) throw new ActionError(`Can't see the ground at ${cx}, ${cz}. Go closer first.`);
      y0 = g + 1;
    }
    const at = (rel) => new Vec3(x0 + rel.x, y0 + rel.y, z0 + rel.z);
    const structural = design.blocks.filter((b) => b.structural);
    const todo = structural.filter((b) => { const w = bot.blockAt(at(b.rel)); return !w || REPLACEABLE.has(w.name) || SOFT.test(w.name); });
    const again = `build_schematic with name=${design.name}, x=${x0}, y=${y0}, z=${z0}, materials=${materials}`;
    const label = `"${design.name}" (${design.size.x}x${design.size.z}, ${design.size.y} tall; ${design.credit}) at ${x0}, ${y0}, ${z0}`;

    if (dry_run) {
      const byType = {};
      for (const b of todo) byType[b.name] = (byType[b.name] ?? 0) + 1;
      const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
      const have = allowedMaterials(bot, 'any').reduce((n, m) => n + countItem(bot, m), 0);
      return `Plan for ${label}: ${structural.length - todo.length}/${structural.length} building blocks already in place, ${todo.length} still to place `
        + `(${design.blocks.length - structural.length} decorations are skipped in shape mode). In the design: ${top || 'nothing left'}. `
        + `You carry ${have} building blocks. Gather about ${Math.max(0, todo.length - have)} more (any planks/cobblestone/stone/logs work in shape mode), then run ${again}.`;
    }

    const names = allowedMaterials(bot, 'any');
    if (!names.length) throw new ActionError(`No building blocks in inventory. ${label} still needs ${todo.length}. Use dry_run to plan materials.`);
    log(agent.name, `🏗️ building ${label}`);
    agent.activity = `building ${design.name} at ${x0}, ${y0}, ${z0}`;
    if (bot.entity.position.distanceTo(new Vec3(cx, y0, cz)) > 10) await goNear(ctx, { x: cx, y: y0, z: cz }, 5, 120_000);

    // Dig out terrain where the design has open space, lowest part first (houses on slopes), a bit per run.
    const occupied = new Set(design.blocks.map((b) => `${b.rel.x},${b.rel.y},${b.rel.z}`));
    const hollow = [];
    for (let ry = Math.min(design.size.y - 1, 6); ry >= 0 && hollow.length < 120; ry--) {
      for (let rx = 0; rx < design.size.x && hollow.length < 120; rx++) {
        for (let rz = 0; rz < design.size.z && hollow.length < 120; rz++) {
          if (occupied.has(`${rx},${ry},${rz}`)) continue;
          const p = new Vec3(x0 + rx, y0 + ry, z0 + rz);
          const w = bot.blockAt(p);
          if (w && !REPLACEABLE.has(w.name) && w.name !== 'air') hollow.push(p);
        }
      }
    }
    const cleared = await clearAll(ctx, hollow, y0);

    // Blocks low enough to reach from the ground are placed from there; higher ones from the floor below them.
    const targets = todo.slice(0, MAX_BLOCKS_PER_CALL).map((b) => ({
      pos: at(b.rel),
      stand: b.rel.y <= 3 ? y0 : y0 + b.rel.y - 2,
      prefer: materials === 'exact' ? b.name : null,
    }));
    const r = await carefulMovement(bot, () => placeAll(ctx, targets, names));
    r.left += Math.max(0, todo.length - MAX_BLOCKS_PER_CALL);
    return summarise(`Design ${label}`, structural.length, r, names, again)
      + (cleared ? ` Dug out ${cleared} blocks of terrain first.` : '')
      + ' Decorations (windows, furniture, lights, railings) are left out in shape mode.';
  },

  async build_house(ctx, { x, y, z, width = 5, depth = 5, height = 3, material = 'any', door = 'south' } = {}) {
    const { bot, agent } = ctx;
    width = Math.min(Math.max(Number(width) || 5, 3), 11);
    depth = Math.min(Math.max(Number(depth) || 5, 3), 11);
    height = Math.min(Math.max(Number(height) || 3, 2), 5);
    const me = bot.entity.position.floored();
    const x0 = Number.isFinite(Number(x)) ? Number(x) : me.x + 2;
    const z0 = Number.isFinite(Number(z)) ? Number(z) : me.z + 2;
    const cx = x0 + Math.floor(width / 2);
    const cz = z0 + Math.floor(depth / 2);
    const g = groundAt(bot, cx, cz, Number.isFinite(Number(y)) ? Number(y) : me.y);
    if (g == null) throw new ActionError(`Can't see the ground at ${cx}, ${cz}. Go closer first.`);
    const floor = Number.isFinite(Number(y)) ? Number(y) : g + 1;
    const names = allowedMaterials(bot, material);
    const need = (2 * (width + depth) - 4) * height - 2 + width * depth;
    if (!names.length) throw new ActionError(`No building blocks (${material}) in inventory. A ${width}x${depth} house needs about ${need} blocks.`);

    const [dx, dz] = SIDES[door] ?? SIDES.south;
    const doorX = dx === 0 ? x0 + Math.floor(width / 2) : dx > 0 ? x0 + width - 1 : x0;
    const doorZ = dz === 0 ? z0 + Math.floor(depth / 2) : dz > 0 ? z0 + depth - 1 : z0;
    const targets = [];
    // Walls, column by column (filling small dips down to the ground), with a 2-high doorway.
    for (let i = 0; i < width; i++) {
      for (let k = 0; k < depth; k++) {
        if (i > 0 && i < width - 1 && k > 0 && k < depth - 1) continue;
        const px = x0 + i;
        const pz = z0 + k;
        // Fill any dip under the wall down to the ground (at most 3 blocks); never look above the floor,
        // or a re-run would mistake the walls we already built for the ground.
        let start = floor;
        while (start > floor - 3 && !isSolidGround(bot.blockAt(new Vec3(px, start - 1, pz)))) start--;
        for (let py = start; py < floor + height; py++) {
          if (px === doorX && pz === doorZ && (py === floor || py === floor + 1)) continue;
          targets.push({ pos: new Vec3(px, py, pz), stand: floor });
        }
      }
    }
    // A door needs solid ground under the doorway: fill the doorstep if it's a dip.
    if (!isSolidGround(bot.blockAt(new Vec3(doorX, floor - 1, doorZ)))) targets.push({ pos: new Vec3(doorX, floor - 1, doorZ), stand: floor });
    // Flat roof, edges first so every block has something to rest against.
    const roof = [];
    for (let i = 0; i < width; i++) for (let k = 0; k < depth; k++) roof.push(new Vec3(x0 + i, floor + height, z0 + k));
    const ring = (p) => Math.min(p.x - x0, x0 + width - 1 - p.x, p.z - z0, z0 + depth - 1 - p.z);
    roof.sort((a, b) => ring(a) - ring(b));
    targets.push(...roof.map((pos) => ({ pos, stand: floor })));
    targets.sort((a, b) => a.pos.y - b.pos.y || 0);

    // Hollow out the inside and the doorway first, in case the house is cut into a slope.
    const hollow = [];
    for (let py = floor + height - 1; py >= floor; py--) {
      for (let i = 1; i < width - 1; i++) for (let k = 1; k < depth - 1; k++) hollow.push(new Vec3(x0 + i, py, z0 + k));
    }
    hollow.push(new Vec3(doorX, floor + 1, doorZ), new Vec3(doorX, floor, doorZ));

    agent.activity = `building a ${width}x${depth} house at ${x0}, ${floor}, ${z0}`;
    // Walk there normally first; careful (no digging/towering) movement only once we're on site.
    if (bot.entity.position.distanceTo(new Vec3(cx, floor, cz)) > 8) await goNear(ctx, { x: cx, y: floor, z: cz }, 4, 120_000);
    const cleared = await clearAll(ctx, hollow, floor);
    const r = await carefulMovement(bot, () => placeAll(ctx, targets.slice(0, MAX_BLOCKS_PER_CALL), names));
    r.left += Math.max(0, targets.length - MAX_BLOCKS_PER_CALL);

    // Hang a door if we have one and the house is up.
    let doorNote = '';
    const doorItem = bot.inventory.items().find((i) => i.name.endsWith('_door'));
    if (doorItem && r.left === 0) {
      try {
        // A door needs a solid block under it: lay a doorstep first if the ground dips there.
        // (Doors won't sit on part-height blocks like dirt paths, farmland or slabs: swap those for a full block.)
        const step = new Vec3(doorX, floor - 1, doorZ);
        const stepItem = nextMaterial(bot, names);
        const under = bot.blockAt(step);
        if (under && /dirt_path|farmland|_slab$|^snow$/.test(under.name)) await bot.dig(under).catch(() => {});
        if (!isSolidGround(bot.blockAt(step)) && stepItem) {
          if (bot.entity.position.floored().distanceTo(step) < 2) await stepAway(ctx, step);
          await goNear(ctx, { x: doorX + dx * 2, y: floor, z: doorZ + dz * 2 }, 1, 20_000);
          await placeItemAt(ctx, stepItem, step, { move: false });
        }
        // Stand well clear: the server refuses a door whose panel would overlap the player.
        await goNear(ctx, { x: doorX + dx * 3, y: floor, z: doorZ + dz * 3 }, 0, 20_000);
        await placeItemAt(ctx, doorItem, new Vec3(doorX, floor, doorZ), { move: false });
        doorNote = ` Hung the ${doorItem.name}.`;
      } catch (err) {
        if (ctx.cancelled) throw err;
        doorNote = ` (Could not hang the door: ${err.message})`;
      }
    } else if (r.left === 0) doorNote = ' Craft a door (6 planks) and place it in the doorway to keep mobs out.';
    agent.memory.home ??= { x: doorX, y: floor, z: doorZ };
    agent.saveMemory();
    return summarise(`House (${width}x${depth}, door facing ${door}) at ${x0}, ${floor}, ${z0}`, targets.length, r, names,
      `build_house with x=${x0}, y=${floor}, z=${z0}, width=${width}, depth=${depth}, door=${door}`)
      + (cleared ? ` Dug out ${cleared} blocks of earth inside first.` : '') + doorNote;
  },

  async build_wall(ctx, { x1, z1, x2, z2, center_x, center_z, radius, height = 3, material = 'any', gate = 'south' } = {}) {
    const { bot, agent } = ctx;
    height = Math.min(Math.max(Number(height) || 3, 1), 6);
    let ax, az, bx, bz;
    if ([x1, z1, x2, z2].every((v) => Number.isFinite(Number(v)))) {
      [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)].map(Number);
      [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)].map(Number);
    } else {
      const c = agent.store.village.center ?? bot.entity.position.floored();
      const cx = Number.isFinite(Number(center_x)) ? Number(center_x) : c.x;
      const cz = Number.isFinite(Number(center_z)) ? Number(center_z) : c.z;
      const r = Math.min(Math.max(Number(radius) || 12, 4), 48);
      [ax, bx, az, bz] = [cx - r, cx + r, cz - r, cz + r];
    }
    const names = allowedMaterials(bot, material);
    const perimeter = 2 * (bx - ax + bz - az);
    if (!names.length) throw new ActionError(`No building blocks (${material}) in inventory. This wall needs about ${perimeter * height} blocks.`);

    // Walk the perimeter as one continuous loop, starting at the corner nearest to us.
    const loop = [];
    for (let x = ax; x < bx; x++) loop.push([x, az]);
    for (let z = az; z < bz; z++) loop.push([bx, z]);
    for (let x = bx; x > ax; x--) loop.push([x, bz]);
    for (let z = bz; z > az; z--) loop.push([ax, z]);
    const me = bot.entity.position;
    const start = loop.reduce((best, p, i) => (Math.hypot(p[0] - me.x, p[1] - me.z) < Math.hypot(loop[best][0] - me.x, loop[best][1] - me.z) ? i : best), 0);
    const ordered = [...loop.slice(start), ...loop.slice(0, start)];

    // A 3-wide gate in the middle of one side.
    const gx = Math.round((ax + bx) / 2);
    const gz = Math.round((az + bz) / 2);
    const inGate = ([x, z]) => {
      if (gate === 'none') return false;
      if (gate === 'north') return z === az && Math.abs(x - gx) <= 1;
      if (gate === 'south') return z === bz && Math.abs(x - gx) <= 1;
      if (gate === 'east') return x === bx && Math.abs(z - gz) <= 1;
      if (gate === 'west') return x === ax && Math.abs(z - gz) <= 1;
      return false;
    };

    const targets = [];
    for (const col of ordered) {
      if (inGate(col)) continue;
      const g = groundAt(bot, col[0], col[1], Math.floor(me.y));
      if (g == null) continue; // not loaded yet; a later run will get it
      for (let h = 1; h <= height; h++) targets.push({ pos: new Vec3(col[0], g + h, col[1]), stand: g + 1 });
    }
    // Skip what's already standing so a re-run carries on from the gaps.
    const todo = targets.filter((t) => { const b = bot.blockAt(t.pos); return !b || REPLACEABLE.has(b.name) || SOFT.test(b.name); });
    agent.activity = `building a wall from ${ax}, ${az} to ${bx}, ${bz}`;
    if (todo.length && bot.entity.position.distanceTo(todo[0].pos) > 8) await goNear(ctx, todo[0].pos, 4, 120_000);
    const r = await carefulMovement(bot, () => placeAll(ctx, todo.slice(0, MAX_BLOCKS_PER_CALL), names));
    r.left += Math.max(0, todo.length - MAX_BLOCKS_PER_CALL);
    const unseen = ordered.length - ordered.filter(inGate).length - targets.length / height;
    return summarise(`Wall around ${ax}, ${az} to ${bx}, ${bz} (${height} high, gate ${gate})`, targets.length, r, names,
      `build_wall with x1=${ax}, z1=${az}, x2=${bx}, z2=${bz}, height=${height}, gate=${gate}`)
      + (unseen > 0 ? ` ${Math.round(unseen)} wall columns are too far away to see; walk round the wall and run it again.` : '');
  },

  async build_farm(ctx, { x, z, size = 4, seeds } = {}) {
    const { bot, mcData, agent } = ctx;
    size = Math.min(Math.max(Number(size) || 4, 1), 4); // farmland stays wet up to 4 blocks from water
    const here = Number.isFinite(Number(x)) && Number.isFinite(Number(z)) ? new Vec3(Number(x), bot.entity.position.y, Number(z)) : bot.entity.position;
    const pools = bot.findBlocks({ matching: mcData.blocksByName.water.id, maxDistance: 24, count: 120, point: here.floored() })
      .map((p) => bot.blockAt(p))
      // Any surface water hydrates farmland, still or flowing.
      .filter((b) => b && bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air');
    if (!pools.length) throw new ActionError('No water within 24 blocks. Farms must be next to water: find a pond or river, or dig a hole and pour in a water bucket.');

    // Farmland stays wet within `size` blocks of water, at the water's level or one above (most banks).
    const plotsAround = (water) => {
      const out = [];
      for (let dx = -size; dx <= size; dx++) {
        for (let dz = -size; dz <= size; dz++) {
          for (const dy of [0, 1]) {
            const p = water.position.offset(dx, dy, dz);
            const b = bot.blockAt(p);
            const above = bot.blockAt(p.offset(0, 1, 0));
            if (b && ['dirt', 'grass_block', 'dirt_path', 'farmland'].includes(b.name) && above && (above.name === 'air' || SOFT.test(above.name) || REPLACEABLE.has(above.name))) out.push(p);
          }
        }
      }
      return out.sort((a, b) => a.distanceTo(water.position) - b.distanceTo(water.position));
    };
    // The nearest bit of water with plenty of farmable bank around it (not the middle of a lake).
    let water = null;
    let plots = [];
    for (const w of pools.slice(0, 40)) {
      const p = plotsAround(w);
      if (p.length > plots.length) [water, plots] = [w, p];
      if (plots.length >= 8) break;
    }
    if (!plots.length) throw new ActionError(`No dirt or grass on the banks of the water near ${fmtPos(pools[0].position)} to farm. Try another pond or river.`);

    let hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
    if (!hoe) {
      await autoCraft(ctx, mcData.itemsByName.wooden_hoe, 1);
      hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
    }
    const SEEDS = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'];
    const seedNames = seeds ? [String(seeds)] : SEEDS;

    const wy = water.position.y;
    // Not enough seeds? Break the grass around the farm (it breaks instantly; ~1 in 8 drops wheat seeds).
    let gathered = 0;
    const seedCount = bot.inventory.items().filter((i) => seedNames.includes(i.name)).reduce((n, i) => n + i.count, 0);
    const emptyPlots = plots.slice(0, 24).filter((p) => bot.blockAt(p.offset(0, 1, 0))?.name === 'air').length;
    if (seedCount < Math.min(emptyPlots, 8)) gathered = await gatherSeeds(ctx, water.position, seedNames, Math.min(emptyPlots, 8));
    agent.activity = `building a farm by the water at ${fmtPos(water.position)}`;
    let tilled = 0;
    let planted = 0;
    let noSeeds = false;
    let firstError = null;
    let unreachable = 0;
    // Get to the water first with normal movement (digging, climbing allowed) and plenty of time.
    if (bot.entity.position.distanceTo(plots[0]) > 6) await goNear(ctx, { x: plots[0].x, y: plots[0].y + 1, z: plots[0].z }, 3, 120_000);
    {
      for (const p of plots.slice(0, 24)) {
        ctx.throwIfCancelled();
        if (unreachable >= 4) break; // this bank isn't working out; say so rather than grinding on
        try {
          if (bot.entity.position.distanceTo(p.offset(0.5, 1, 0.5)) > 4) await goNear(ctx, { x: p.x, y: p.y + 1, z: p.z }, 2, 30_000);
          const above = bot.blockAt(p.offset(0, 1, 0));
          if (above && above.name !== 'air') await bot.dig(above);
          if (bot.blockAt(p).name !== 'farmland') {
            await bot.equip(hoe, 'hand');
            await bot.activateBlock(bot.blockAt(p));
            await sleepMs(150);
            if (bot.blockAt(p).name === 'farmland') tilled++;
          }
          const seed = bot.inventory.items().find((i) => seedNames.includes(i.name));
          if (!seed) { noSeeds = true; continue; }
          if (bot.blockAt(p).name === 'farmland' && bot.blockAt(p.offset(0, 1, 0))?.name === 'air') {
            await bot.equip(seed, 'hand');
            await bot.activateBlock(bot.blockAt(p));
            await sleepMs(150);
            if (bot.blockAt(p.offset(0, 1, 0))?.name !== 'air') planted++;
          }
        } catch (err) {
          if (ctx.cancelled) throw err;
          firstError ??= err.message;
          if (/reach|path/i.test(err.message)) unreachable++;
        }
      }
    }
    if (!tilled && !planted) throw new ActionError(`Couldn't till or plant by the water at ${fmtPos(water.position)}${firstError ? `: ${firstError}` : ''}.`);
    agent.store.addKnowledge?.(agent.name, 'farm', { x: water.position.x, y: wy, z: water.position.z });
    return `Farm by the water at ${fmtPos(water.position)}: tilled ${tilled}, planted ${planted}.`
      + (gathered ? ` Broke ${gathered} grass for seeds first.` : '')
      + (noSeeds ? ' Ran out of seeds: break grass for wheat_seeds, or plant carrots/potatoes.' : '')
      + ' Crops take about 20 minutes to grow; then use harvest_crops.';
  },

  async harvest_crops(ctx, { radius = 16 } = {}) {
    const { bot, mcData, agent } = ctx;
    const CROPS = { wheat: [7, 'wheat_seeds'], carrots: [7, 'carrot'], potatoes: [7, 'potato'], beetroots: [3, 'beetroot_seeds'] };
    const ids = Object.keys(CROPS).map((n) => mcData.blocksByName[n]?.id).filter((v) => v != null);
    const ripe = bot.findBlocks({ matching: ids, maxDistance: Math.min(Math.max(Number(radius) || 16, 4), 32), count: 64 })
      .map((p) => bot.blockAt(p))
      .filter((b) => b && b.getProperties().age === CROPS[b.name][0]);
    if (!ripe.length) throw new ActionError('No ripe crops nearby yet. Crops take about 20 minutes to grow; wheat is ripe when it turns golden.');

    agent.activity = `harvesting ${ripe.length} crops`;
    const before = agent.inventorySnapshot();
    let harvested = 0;
    let replanted = 0;
    for (const crop of ripe.slice(0, 40)) {
      ctx.throwIfCancelled();
      try {
        if (bot.entity.position.distanceTo(crop.position.offset(0.5, 0.5, 0.5)) > 4) await goNear(ctx, crop.position, 2, 30_000);
        const name = crop.name;
        await bot.dig(bot.blockAt(crop.position));
        harvested++;
        await sleepMs(250);
        const seed = bot.inventory.items().find((i) => i.name === CROPS[name][1]);
        const soil = bot.blockAt(crop.position.offset(0, -1, 0));
        if (seed && soil?.name === 'farmland') {
          await bot.equip(seed, 'hand');
          await bot.activateBlock(soil);
          replanted++;
        }
      } catch (err) {
        if (ctx.cancelled) throw err;
      }
    }
    // Walk over the drops that didn't land at our feet.
    const area = ripe[0].position;
    for (let i = 0; i < 20; i++) {
      const drop = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(area) < radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!drop || drop.position.distanceTo(bot.entity.position) > 24) break;
      try { await goNear(ctx, drop.position, 1, 8_000); } catch (err) { if (ctx.cancelled) throw err; break; }
      await sleepMs(300);
    }
    const after = agent.inventorySnapshot();
    const gained = Object.entries(after).map(([k, v]) => [k, v - (before[k] ?? 0)]).filter(([, v]) => v > 0).map(([k, v]) => `${k} +${v}`);
    return `Harvested ${harvested} crops and replanted ${replanted}. Gained: ${gained.join(', ') || 'nothing yet (drops may still be on the ground)'}.`;
  },
};
