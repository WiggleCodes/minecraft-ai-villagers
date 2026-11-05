// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { fmtPos, posObj, tallyInventory } from './util.js';

const NOTABLE = /(_log$|_ore$|^crafting_table$|^furnace$|^chest$|^barrel$|_bed$|^water$|^lava$|^wheat$|^carrots$|^potatoes$|^sugar_cane$|^pumpkin$|^melon$|^sand$|^gravel$|^clay$|^cobblestone$|^farmland$|^hay_block$|_door$|^torch$|^obsidian$|^sweet_berry_bush$|^bee_nest$|^ancient_debris$)/;

const idCache = new WeakMap();
function notableIds(mcData) {
  if (!idCache.has(mcData)) {
    idCache.set(mcData, mcData.blocksArray.filter((b) => NOTABLE.test(b.name)).map((b) => b.id));
  }
  return idCache.get(mcData);
}

export function timeOfDayLabel(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  if (t < 1000) return 'dawn';
  if (t < 6000) return 'morning';
  if (t < 11000) return 'afternoon';
  if (t < 12500) return 'evening';
  if (t < 23000) return 'night';
  return 'dawn';
}

function scanBlocks(bot, mcData, radius = 24) {
  const positions = bot.findBlocks({ matching: notableIds(mcData), maxDistance: radius, count: 300 });
  const me = bot.entity.position;
  const tally = {};
  for (const p of positions) {
    const b = bot.blockAt(p);
    if (!b) continue;
    const d = p.distanceTo(me);
    const t = (tally[b.name] ??= { count: 0, nearest: null, dist: Infinity });
    t.count++;
    if (d < t.dist) {
      t.dist = d;
      t.nearest = posObj(p);
    }
  }
  return Object.entries(tally)
    .sort((a, b) => a[1].dist - b[1].dist)
    .slice(0, 20)
    .map(([name, t]) => `${name} x${t.count} (nearest ${t.nearest.x},${t.nearest.y},${t.nearest.z}; ${Math.round(t.dist)}m)`);
}

function scanEntities(bot, agentNames) {
  const me = bot.entity.position;
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const d = e.position.distanceTo(me);
    if (d > 32) continue;
    let label;
    if (e.type === 'player') label = `${agentNames.has(e.username) ? 'AI villager' : 'player'} ${e.username}`;
    else if (e.name === 'item') {
      let it = null;
      try {
        it = e.getDroppedItem?.();
      } catch {
        /* metadata not received yet */
      }
      label = `dropped ${it ? `${it.name} x${it.count}` : 'item'}`;
    } else if (e.type === 'hostile') label = `HOSTILE ${e.name}`;
    else if (e.type === 'orb' || e.name === 'experience_orb') continue;
    else label = e.name ?? e.type;
    out.push({ label, d });
  }
  return out
    .sort((a, b) => a.d - b.d)
    .slice(0, 15)
    .map((x) => `${x.label} (${Math.round(x.d)}m)`);
}

/** A compact, model-friendly description of the bot's situation. */
export function observe(agent) {
  const bot = agent.bot;
  if (!bot?.entity) return { online: false, note: 'Not connected / not spawned yet.' };
  const pos = bot.entity.position;
  const below = bot.blockAt(pos.offset(0, -1, 0));
  const biome = bot.blockAt(pos)?.biome?.name;
  return {
    online: true,
    name: bot.username,
    position: fmtPos(pos),
    dimension: bot.game?.dimension,
    biome,
    standing_on: below?.name,
    health: `${Math.round(bot.health)}/20`,
    food: `${Math.round(bot.food)}/20`,
    time: `${timeOfDayLabel(bot)} (tick ${bot.time?.timeOfDay ?? '?'})${bot.isRaining ? ', raining' : ''}`,
    holding: bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'nothing',
    inventory: tallyInventory(bot),
    free_slots: bot.inventory.emptySlotCount(),
    home: agent.memory.home ? fmtPos(agent.memory.home) : 'not set',
    village_centre: agent.store.village.center ? fmtPos(agent.store.village.center) : 'not set',
    nearby_blocks: scanBlocks(bot, agent.mcData),
    nearby_entities: scanEntities(bot, agent.allAgentNames),
    current_activity: agent.activity ?? 'idle',
  };
}
