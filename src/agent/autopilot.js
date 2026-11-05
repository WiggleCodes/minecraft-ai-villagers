// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// The autopilot: built-in know-how for every role, so villagers work on their own without the AI.
// Each turn it picks the most useful next step from what the villager carries and can see. A shared
// skills memory (data/skills.json) records how every step works out for each role, and steps that keep
// failing are rested for a while: the village trains itself, and the AI is only needed for new things.

import { wanted } from './society.js';
import { planNext, goalsFor, chestLookup } from './planner.js';

const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
const RAW_FOOD = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'];

/** A skill's identity: the action and what it acts on, e.g. "collect_block:oak_log". */
export function skillKey(step) {
  const i = step.input ?? {};
  return `${step.name}:${i.block ?? i.item ?? i.target ?? i.operation ?? ''}`;
}

/** Everything the playbooks need to know about the villager right now. */
function senses(brain) {
  const agent = brain.agent;
  const bot = agent.bot;
  const mc = agent.mcData;
  const inv = agent.inventorySnapshot();
  const me = bot.entity.position;
  const count = (re) => Object.entries(inv).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
  const ids = (pred) => mc.blocksArray.filter((b) => pred(b.name)).map((b) => b.id);
  const t = bot.time?.timeOfDay ?? 0;
  const pick = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].findIndex((m) => inv[`${m}_pickaxe`]);
  return {
    agent, bot, mc, inv, me, count,
    near: (pred, r = 32) => bot.findBlock({ matching: ids(pred), maxDistance: r }),
    entity: (pred, r = 24) => bot.nearestEntity((e) => pred(e) && e.position.distanceTo(me) < r),
    night: t >= 12542 && t <= 23459,
    pickLevel: pick < 0 ? 0 : [5, 4, 3, 2, 1, 1][pick], // 1 wood/gold, 2 stone, 3 iron, 4+ diamond
    logs: count(/_(log|stem)$/),
    planks: count(/_planks$/),
    cobble: count(/^cobblestone$|^cobbled_deepslate$/),
    iron: inv.iron_ingot ?? 0,
    blocks: count(/^cobblestone$|^stone_bricks$|^bricks$|^stone$|^cobbled_deepslate$|_planks$/),
    centre: agent.store.village.center,
    full: bot.inventory.emptySlotCount() <= 3,
    wanted: wanted(agent.store),
    // Someone looked in the shared chests in the last 5 minutes (what's in them is known to everyone).
    storesChecked: Object.values(agent.store.village.chests ?? {}).some((c) => Date.now() - Date.parse(c.t) < 5 * 60_000),
  };
}

const step = (name, input, why) => ({ name, input, why });

/** Things every villager looks after first: tools, wood, a weapon, food, a full inventory. */
function basics(s) {
  const out = [];
  if (s.pickLevel === 0 && (s.planks >= 3 || s.logs >= 1)) out.push(step('craft', { item: 'wooden_pickaxe' }, 'I need a pickaxe'));
  if (s.pickLevel < 2 && s.cobble >= 3) out.push(step('craft', { item: 'stone_pickaxe' }, 'upgrading to a stone pickaxe'));
  if (s.pickLevel < 3 && s.iron >= 3) out.push(step('craft', { item: 'iron_pickaxe' }, 'upgrading to an iron pickaxe'));
  if (!Object.keys(s.inv).some((n) => n.endsWith('_sword')) && (s.cobble >= 2 || s.planks >= 2)) {
    out.push(step('craft', { item: s.cobble >= 2 ? 'stone_sword' : 'wooden_sword' }, 'I should carry a weapon'));
  }
  if (s.iron >= 8 && !s.inv.iron_chestplate && !s.bot.inventory.slots.some((x) => x?.name === 'iron_chestplate')) out.push(step('craft', { item: 'iron_chestplate' }, 'iron armour'));
  const raw = RAW_FOOD.find((n) => s.inv[n]);
  // Health only regenerates on a well-fed stomach: when hurt, make sure there's good (cooked) food to eat.
  const hurt = s.bot.health <= 14;
  const cooked = Object.keys(s.inv).some((n) => s.mc.foodsByName[n] && !RAW_FOOD.includes(n) && n !== 'rotten_flesh');
  const canCook = s.near((n) => n === 'furnace' || n === 'smoker', 64) || s.cobble >= 8;
  if ((s.bot.food < 15 || (hurt && !cooked)) && raw && canCook) out.push(step('smelt', { item: raw, count: Math.min(8, s.inv[raw]) }, hurt ? `cooking ${raw} so I can eat and heal` : `cooking ${raw}`));
  if (hurt && !cooked && !raw) {
    // No food at all: the village stores first (they were filled for this), then bread, then hunting.
    const stored = Object.entries(s.agent.store.village.chests ?? {})
      .flatMap(([key, c]) => Object.entries(c.contents ?? {}).filter(([n, k]) => k > 0 && s.mc.foodsByName[n] && n !== 'rotten_flesh' && n !== 'spider_eye').map(([n]) => ({ key, n })))
      .sort((a, b) => (s.mc.foodsByName[b.n].foodPoints ?? 0) - (s.mc.foodsByName[a.n].foodPoints ?? 0))[0];
    const prey = s.entity((e) => ['cow', 'pig', 'chicken', 'sheep', 'rabbit'].includes(e.name), 24);
    if (stored) {
      const [x, y, z] = stored.key.split(',').map(Number);
      out.push(step('use_chest', { operation: 'withdraw', item: stored.n, count: 8, x, y, z }, `I'm hurt and hungry: fetching ${stored.n} from the village stores`));
    } else if ((s.inv.wheat ?? 0) >= 3) out.push(step('craft', { item: 'bread', count: Math.floor(s.inv.wheat / 3) }, 'baking bread so I can eat and heal'));
    else if (prey) out.push(step('attack', { target: prey.name }, `I'm hurt and have no food: hunting a ${prey.name} to cook and heal`));
  }
  if (s.full && s.near((n) => n === 'chest' || n === 'barrel')) {
    const spare = Object.entries(s.inv).filter(([n]) => !/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^shield$|_bed$/.test(n)).sort((a, b) => b[1] - a[1])[0];
    if (spare) out.push(step('use_chest', { operation: 'deposit', item: spare[0] }, 'my inventory is full'));
  }
  if (s.logs + s.planks < 4) out.push(step('collect_block', { block: 'log', count: 8 }, 'I need some wood'));
  // Pillars and bridges left behind while walking: tidy them up rather than litter the land.
  if (s.agent.leftoverScaffold(32).length >= 3) out.push(step('clean_up', { range: 32 }, 'tidying up the blocks I left lying around'));
  // A real Minecraft villager nearby: sell surplus they commonly buy, for emeralds.
  const trader = s.entity((e) => e.name === 'villager' || e.name === 'wandering_trader', 24);
  if (trader) {
    const surplus = ['wheat', 'coal', 'stick', 'potato', 'carrot', 'beetroot', 'rotten_flesh', 'string', 'paper', 'pumpkin'].find((n) => (s.inv[n] ?? 0) >= 20);
    if (surplus) out.push(step('trade_villager', { give: surplus, times: 4 }, `selling ${surplus} to a villager for emeralds`));
  }
  return out;
}

/** Food providers keep a few meals and put the rest in the village stores, so a hurt villager can fetch some. */
function stockFood(s) {
  const spare = Object.entries(s.inv)
    .filter(([n]) => s.mc.foodsByName[n] && !RAW_FOOD.includes(n) && n !== 'rotten_flesh' && n !== 'spider_eye')
    .sort((a, b) => b[1] - a[1])[0];
  if (!spare || spare[1] < 12 || !s.near((n) => n === 'chest' || n === 'barrel')) return null;
  return step('use_chest', { operation: 'deposit', item: spare[0], count: spare[1] - 6 }, `stocking the village stores with ${spare[0]}`);
}

/** House plot for a villager: a spiral of plots around the village centre, 10 blocks apart. */
export function housePlot(centre, index) {
  let x = 0;
  let z = 0;
  let dx = 0;
  let dz = -1;
  for (let i = 0; i <= index + 1; i++) { // +1 skips the centre itself (the square)
    if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) [dx, dz] = [-dz, dx];
    x += dx;
    z += dz;
  }
  return { x: centre.x + x * 10 - 2, z: centre.z + z * 10 - 2 };
}

const ROLE_PLAYBOOKS = {
  lumberjack: (s) => [
    s.logs >= 8 && s.planks < 32 && step('craft', { item: 'planks', count: 16 }, 'turning logs into planks'),
    s.planks > 64 && s.near((n) => n === 'chest') && step('use_chest', { operation: 'deposit', item: Object.keys(s.inv).find((n) => n.endsWith('_planks')) }, 'storing planks for the builders'),
    step('collect_block', { block: 'log', count: 16 }, 'chopping wood for the village'),
  ],
  miner: (s) => [
    s.pickLevel >= 1 && s.near((n) => n === 'coal_ore' || n === 'deepslate_coal_ore', 16) && step('collect_block', { block: 'coal_ore', count: 8 }, 'mining coal I can see'),
    s.pickLevel >= 2 && s.near((n) => n === 'iron_ore' || n === 'deepslate_iron_ore', 16) && step('collect_block', { block: 'iron_ore', count: 6 }, 'mining iron I can see'),
    s.cobble > 96 && s.near((n) => n === 'chest') && step('use_chest', { operation: 'deposit', item: 'cobblestone' }, 'storing cobblestone for the masons'),
    s.pickLevel >= 1 && step('collect_block', { block: 'stone', count: 24 }, 'mining stone for building'),
  ],
  farmer: (s) => [
    (s.inv.wheat ?? 0) >= 3 && step('craft', { item: 'bread', count: Math.floor(s.inv.wheat / 3) }, 'baking bread'),
    step('harvest_crops', {}, 'checking for ripe crops'),
    s.near((n) => n === 'water', 24) && step('build_farm', { size: 4 }, 'expanding the farm by the water'),
  ],
  builder: (s) => {
    const plot = s.centre && nextUnbuiltPlot(s);
    return [
      plot && s.blocks >= 70 && step('build_house', { x: plot.x, z: plot.z, material: 'any' }, `building a house at ${plot.x}, ${plot.z}`),
      s.blocks < 70 && s.near((n) => n === 'chest') && step('use_chest', { operation: 'withdraw', item: 'planks', count: 64 }, 'fetching building blocks'),
      s.logs >= 8 && step('craft', { item: 'planks', count: 32 }, 'making planks to build with'),
      step('collect_block', { block: 'log', count: 16 }, 'gathering wood to build with'),
    ];
  },
  mason: (s) => [
    s.centre && s.cobble >= 40 && step('build_wall', { center_x: s.centre.x, center_z: s.centre.z, radius: 32, height: 3, material: 'cobblestone', gate: 'south' }, 'building the town wall'),
    s.pickLevel >= 1 && step('collect_block', { block: 'stone', count: 32 }, 'quarrying stone for the wall'),
  ],
  explorer: () => [step('explore', { distance: 60 }, 'scouting the land')],
  hunter: (s) => {
    const prey = s.entity((e) => ANIMALS.includes(e.name));
    const raw = RAW_FOOD.find((n) => (s.inv[n] ?? 0) >= 6);
    return [
      stockFood(s),
      raw && (s.near((n) => n === 'furnace' || n === 'smoker', 64) || s.cobble >= 8) && step('smelt', { item: raw, count: Math.min(16, s.inv[raw]) }, `cooking the ${raw} I hunted`),
      prey && step('attack', { target: prey.name }, `hunting a ${prey.name}`),
      step('explore', { distance: 40 }, 'looking for animals'),
    ];
  },
  blacksmith: (s) => [
    (s.inv.raw_iron ?? 0) >= 3 && step('smelt', { item: 'raw_iron', count: Math.min(16, s.inv.raw_iron) }, 'smelting iron'),
    s.iron >= 5 && !s.inv.iron_helmet && step('craft', { item: 'iron_helmet' }, 'forging armour'),
    s.cobble >= 8 && !s.near((n) => n === 'furnace', 24) && step('craft', { item: 'furnace' }, 'making a furnace for the village'),
    s.pickLevel >= 1 && step('collect_block', { block: 'stone', count: 16 }, 'getting stone for the forge'),
  ],
  guard: (s) => {
    // Wanted villagers first: arrest them (attack until they're in jail).
    const outlaw = s.entity((e) => e.type === 'player' && s.wanted.includes(e.username), 32);
    if (outlaw) return [step('attack', { target: outlaw.username }, `arresting ${outlaw.username}, who is wanted`)];
    const foe = s.entity((e) => e.type === 'hostile', 16);
    const far = s.centre && Math.hypot(s.me.x - s.centre.x, s.me.z - s.centre.z) > 28;
    return [
      foe && step('attack', { target: foe.name }, `defending the village from a ${foe.name}`),
      far && step('go_to', { x: s.centre.x, y: s.centre.y, z: s.centre.z, range: 6 }, 'heading back to guard the village'),
      step('explore', { distance: 16 }, 'patrolling'),
    ];
  },
  cook: (s) => [
    stockFood(s),
    (s.inv.wheat ?? 0) >= 3 && step('craft', { item: 'bread', count: Math.floor(s.inv.wheat / 3) }, 'baking bread'),
    RAW_FOOD.find((n) => s.inv[n]) && step('smelt', { item: RAW_FOOD.find((n) => s.inv[n]), count: 8 }, 'cooking food for the village'),
    step('harvest_crops', {}, 'gathering food'),
    step('collect_block', { block: 'sweet_berry_bush', count: 6 }, 'picking berries'),
  ],
  quartermaster: (s) => [
    s.planks >= 8 && !s.inv.chest && !s.near((n) => n === 'chest', 24) && step('craft', { item: 'chest' }, 'making a storage chest'),
    s.inv.chest && s.centre && step('place_block', { block: 'chest', x: s.centre.x + 1, y: s.centre.y, z: s.centre.z }, 'setting up storage at the village centre'),
    !s.storesChecked && s.near((n) => n === 'chest') && step('use_chest', { operation: 'view' }, 'checking the stores'),
    step('collect_block', { block: 'log', count: 8 }, 'gathering wood for the stores'),
  ],
  fisher: (s) => [
    s.near((n) => n === 'sand', 24) && step('collect_block', { block: 'sand', count: 16 }, 'gathering sand by the water'),
    step('explore', { distance: 30 }, 'looking for good water'),
  ],
  shepherd: (s) => {
    const sheep = s.entity((e) => e.name === 'sheep');
    const wool = s.count(/_wool$/);
    return [
      wool >= 3 && s.planks >= 3 && !s.near((n) => n.endsWith('_bed'), 32) && step('craft', { item: 'white_bed' }, 'making a bed for the village'),
      wool < 3 && sheep && step('attack', { target: 'sheep' }, 'getting wool for beds'),
      step('explore', { distance: 30 }, 'looking for sheep'),
    ];
  },
  landscaper: (s) => [
    s.inv.oak_sapling && s.centre && step('place_block', { block: 'oak_sapling', x: s.me.x + 2, y: s.me.y, z: s.me.z + 2 }, 'planting a tree'),
    step('collect_block', { block: 'dirt', count: 16 }, 'clearing and levelling ground'),
  ],
  courier: (s) => [
    Object.keys(s.inv).length > 12 && s.near((n) => n === 'chest') && step('use_chest', { operation: 'deposit', item: Object.entries(s.inv).sort((a, b) => b[1] - a[1])[0][0] }, 'delivering goods to the stores'),
    step('collect_block', { block: 'log', count: 12 }, 'collecting wood to deliver'),
  ],
};

function playbookFor(role) {
  const key = Object.keys(ROLE_PLAYBOOKS).find((k) => role.toLowerCase().includes(k));
  return ROLE_PLAYBOOKS[key] ?? ((s) => [step('collect_block', { block: 'log', count: 8 }, 'gathering wood'), step('explore', { distance: 30 }, 'looking around')]);
}

function nextUnbuiltPlot(s) {
  const village = s.agent.store.village;
  village.houses ??= [];
  const n = (s.agent.allAgentNames?.size ?? 60) + 4;
  for (let i = 0; i < n; i++) {
    const p = housePlot(s.centre, i);
    if (!village.houses.some((h) => h.x === p.x && h.z === p.z)) return p;
  }
  return null;
}

/**
 * collect_block only reaches 48 blocks. Once the village has used up what's close (trees first), walk to
 * the nearest one in sight, or head out exploring when there's none in sight, instead of failing on the spot.
 */
function goGetIt(s, c) {
  const want = String(c.input.block);
  const b = s.near((n) => n === want || n.endsWith(`_${want}`) || (want === 'log' && n.endsWith('_stem')), 64);
  if (!b) return step('explore', { distance: 48 }, `${c.why}: there's no ${want} nearby, so I'm heading further out to find some`);
  if (b.position.distanceTo(s.me) > 40) return step('go_to', { x: b.position.x, y: b.position.y, z: b.position.z, range: 4 }, `${c.why}: walking to the ${want} at ${b.position.x}, ${b.position.z}`);
  return c;
}

/**
 * The next 1-2 steps the autopilot would take, skipping skills that are resting after repeated failures.
 * Returns [] when it has nothing sensible to do: that's when the AI is asked.
 */
export function nextSteps(brain) {
  const agent = brain.agent;
  if (!agent.bot?.entity || !agent.mcData) return [];
  const s = senses(brain);
  const role = agent.profile.role;
  // Every other turn, work towards the role's long-term goals; the planner figures out the next step.
  const goalSteps = [];
  if (brain.ticks % 2 === 0) {
    const fromChest = chestLookup(agent);
    for (const goal of goalsFor(role)) {
      const st = planNext(s.bot, s.mc, goal, 1, { goal, fromChest });
      if (st) {
        goalSteps.push(st);
        break;
      }
    }
  }
  const candidates = [...basics(s), ...goalSteps, ...playbookFor(role)(s)].filter(Boolean).map((c) => (c.name === 'collect_block' ? goGetIt(s, c) : c));
  const usable = candidates.filter((c) => !brain.skillResting(skillKey(c)));
  return usable.slice(0, 2);
}
