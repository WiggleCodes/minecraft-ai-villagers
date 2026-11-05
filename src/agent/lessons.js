// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Turns action results into shared village learning, so villagers don't depend on the model
// remembering: failures with a clear cause become lessons, search results become discoveries.

// Recipes list one wood variant (often cherry_planks); any wood type works.
const anyWood = (s) => s.replace(/\b\w+_planks\b/g, 'planks (any wood)').replace(/\b\w+_log\b/g, 'logs (any wood)');

// [error pattern, lesson]. Lessons are generic so they apply to every villager and dedupe cleanly.
const LESSON_RULES = [
  [/no tool that can harvest (\w+)/i, (m) => `Mining ${m[1]} needs a suitable tool (a pickaxe for stone and ores). Craft one before trying.`],
  [/Missing ingredients for (\w+)( \(needs a crafting table\))?\. One recipe needs: ([^.]+)\./, (m) => anyWood(`Recipe: ${m[1]} needs ${m[3]}${m[2] ? ', made at a crafting table' : ''}.`)],
  [/^(\w+) needs a crafting table/, (m) => `${m[1]} must be crafted at a crafting table (craft one from 4 planks first).`],
  [/(\w+) cannot be crafted/, (m) => `${m[1]} can't be crafted; it has to be smelted or found in the world.`],
  [/No bed within/, () => 'Sleeping needs a bed nearby: craft one from 3 wool + 3 planks and place it first.'],
  [/Unknown block "([^"]+)"/, (m) => `"${m[1]}" is not a block id. Use real Minecraft ids like oak_log, stone, iron_ore (animals are not blocks).`],
  [/Unknown item "([^"]+)"/, (m) => `"${m[1]}" is not an item id. Use real Minecraft ids like oak_planks, stick, wooden_pickaxe.`],
  [/No fuel/, () => 'Smelting needs fuel in your inventory: coal, charcoal, planks or logs.'],
  [/Inventory is full/, () => 'When your inventory is full, deposit items in a chest before collecting more.'],
  [/Nothing solid next to/, () => 'A block can only be placed against a solid neighbouring block; build up from the ground.'],
  [/Cannot place a block where I am standing/, () => 'Step aside before placing a block in the space you are standing in.'],
  [/No water within/, () => 'Farms must be built right next to water (a pond or river): go there first, then build_farm.'],
  [/No building blocks/, () => 'Building needs lots of blocks: gather cobblestone or planks (or take them from the shared chest) before build_house or build_wall.'],
  [/No ripe crops/, () => 'Crops take about 20 minutes to ripen: do other work in between and come back to harvest_crops later.'],
  [/No chest within/, () => 'There is no chest nearby; craft one (8 planks) and place it at the village centre for shared storage.'],
  [/Took to long to decide path|No path to the goal/, () => 'Very far or deep underground targets often cannot be reached; pick a closer target on the surface.'],
];

/** A shareable lesson for a failed action, or null if the error doesn't teach anything general. */
export function lessonFrom(error) {
  for (const [re, make] of LESSON_RULES) {
    const m = String(error).match(re);
    if (m) return make(m);
  }
  return null;
}

// [death message pattern, lesson] for the server's death messages ("Gimli was slain by Zombie").
const DEATH_RULES = [
  [/slain by|was shot|blown up|blew up|killed by|fireballed|stung|impaled/i, 'Hostile mobs are deadly, especially at night: shelter or sleep before dark, carry a sword, and flee when health is low.'],
  [/drowned/i, "Drowning kills: don't stay underwater; surface for air and avoid swimming in deep water."],
  [/lava|burn|flames|fire/i, 'Lava and fire kill quickly: stay away from lava and never dig straight down.'],
  [/fell|hit the ground|doomed to fall/i, "Falls kill: don't jump or dig down from high places; take the long way down."],
  [/starved/i, 'Starving kills: eat before your food gets low and always carry food.'],
  [/suffocated/i, "Falling sand or gravel can suffocate you: don't dig into them from below."],
];

/** A shareable lesson from how a villager died, or null if the cause is unknown or not instructive. */
export function deathLesson(cause) {
  if (!cause) return null;
  const rule = DEATH_RULES.find(([re]) => re.test(cause));
  return rule ? rule[1] : null;
}

const NOTABLE = /(_log$|_ore$|^water$|^lava$|^chest$|^crafting_table$|^furnace$|_bed$|^sand$|^clay$|^sugar_cane$|^pumpkin$|^melon$|^wheat$|^hay_block$|^obsidian$|^sweet_berry_bush$)/;
// "spruce_log at -73,79,66 (107m)" from find_block, "coal_ore x46 (nearest -2,65,-3; 9m)" from explore
const FOUND = /^(\w+) (?:at|x\d+ \(nearest) (-?\d+),(-?\d+),(-?\d+)/;

/** Resources worth sharing from a successful find_block / explore result: [{ name, pos }], nearest per type. */
export function discoveriesFrom(action, result) {
  let lines = [];
  if (action === 'find_block' && Array.isArray(result)) lines = result;
  else if (action === 'explore' && Array.isArray(result?.surroundings)) lines = result.surroundings;
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = String(line).match(FOUND);
    if (!m || !NOTABLE.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], pos: { x: Number(m[2]), y: Number(m[3]), z: Number(m[4]) } });
  }
  return out;
}
