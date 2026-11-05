// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Single source of truth for what an AI player can do.
// These definitions are shared by the autonomous brain (as Claude tools)
// and the MCP server (as tools you can call from Claude Desktop / Claude Code).
// Keep this file free of mineflayer imports so the MCP server can load it cheaply.

const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

export const ACTION_DEFS = [
  {
    name: 'observe',
    description:
      'Look around: position, health, hunger, time of day, inventory, notable blocks nearby (with nearest coordinates), nearby players/mobs/items, and what you are currently doing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'chat',
    description: 'Say something in public chat. Keep it short and natural (under 200 characters).',
    input_schema: { type: 'object', properties: { message: str('What to say') }, required: ['message'] },
  },
  {
    name: 'whisper',
    description: 'Send a private message to one player.',
    input_schema: {
      type: 'object',
      properties: { player: str('Username'), message: str('Message') },
      required: ['player', 'message'],
    },
  },
  {
    name: 'go_to',
    description: 'Walk/climb/dig a path to coordinates. Returns when arrived or if it gives up.',
    input_schema: {
      type: 'object',
      properties: {
        x: int('X'),
        y: int('Y'),
        z: int('Z'),
        range: int('How close is close enough (default 1)', { minimum: 0, maximum: 32 }),
      },
      required: ['x', 'y', 'z'],
    },
  },
  {
    name: 'go_to_player',
    description: 'Walk to a player (human or AI).',
    input_schema: {
      type: 'object',
      properties: { player: str('Username'), range: int('Stop this many blocks away (default 2)', { minimum: 1, maximum: 16 }) },
      required: ['player'],
    },
  },
  {
    name: 'follow',
    description:
      'Keep following a player or mob until told to stop (returns immediately; the bot keeps following in the background).',
    input_schema: {
      type: 'object',
      properties: { target: str('Username or mob name'), distance: int('Follow distance (default 3)', { minimum: 1, maximum: 16 }) },
      required: ['target'],
    },
  },
  {
    name: 'stop',
    description: 'Stop moving, following, digging or fighting.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'explore',
    description: 'Wander in a random new direction to discover terrain and resources.',
    input_schema: {
      type: 'object',
      properties: { distance: int('Roughly how far to travel (default 40)', { minimum: 10, maximum: 200 }) },
    },
  },
  {
    name: 'find_block',
    description: 'Find the nearest block of a type (e.g. "oak_log", "log", "iron_ore", "crafting_table", "bed").',
    input_schema: {
      type: 'object',
      properties: { block: str('Block name or family'), max_distance: int('Search radius (default 64)', { minimum: 8, maximum: 128 }) },
      required: ['block'],
    },
  },
  {
    name: 'collect_block',
    description:
      'Find, walk to, mine and pick up blocks of a type. Picks the right tool automatically. Families like "log", "stone", "sand", "coal_ore" work.',
    input_schema: {
      type: 'object',
      properties: { block: str('Block name or family'), count: int('How many (default 1)', { minimum: 1, maximum: 64 }) },
      required: ['block'],
    },
  },
  {
    name: 'dig_block',
    description: 'Break the block at exact coordinates.',
    input_schema: { type: 'object', properties: { x: int('X'), y: int('Y'), z: int('Z') }, required: ['x', 'y', 'z'] },
  },
  {
    name: 'place_block',
    description: 'Place a block from your inventory at exact coordinates (needs an adjacent solid block to attach to).',
    input_schema: {
      type: 'object',
      properties: { block: str('Item name, e.g. "oak_planks", "torch"'), x: int('X'), y: int('Y'), z: int('Z') },
      required: ['block', 'x', 'y', 'z'],
    },
  },
  {
    name: 'clean_up',
    description:
      'Dig up the stray blocks you left behind (pillars you climbed, bridges you made while walking). Leaves your real builds, chests and beds alone.',
    input_schema: { type: 'object', properties: { range: int('How far around you to tidy (default 48)', { minimum: 8, maximum: 96 }) } },
  },
  {
    name: 'build_shelter',
    description:
      'Build a simple 5x5 hut (walls, roof, doorway) around where you stand. Needs about 70 building blocks (planks, cobblestone, dirt...).',
    input_schema: {
      type: 'object',
      properties: { block: str('Building block to use (default: whatever you have most of)') },
    },
  },
  {
    name: 'craft',
    description:
      'Craft an item, asking for the thing you actually want (e.g. iron_pickaxe, chest, oak_door). In-between ingredients are made for you from what you carry: planks from logs, sticks from planks, and a crafting table (crafted and placed) if the recipe needs one. Tells you what is still missing if you cannot.',
    input_schema: {
      type: 'object',
      properties: { item: str('Item name, e.g. "oak_planks", "stick", "wooden_pickaxe"'), count: int('How many items (default 1)', { minimum: 1, maximum: 64 }) },
      required: ['item'],
    },
  },
  {
    name: 'smelt',
    description: 'Smelt/cook items in a nearby furnace (places one from inventory if needed).',
    input_schema: {
      type: 'object',
      properties: {
        item: str('Input item, e.g. "raw_iron", "beef"'),
        count: int('How many (default 1)', { minimum: 1, maximum: 32 }),
        fuel: str('Fuel item (default: best available: coal, charcoal, planks, logs)'),
      },
      required: ['item'],
    },
  },
  {
    name: 'use_chest',
    description: 'Use a chest: view its contents, deposit items into it, or withdraw items from it. The nearest chest, or a specific one by its x,y,z (see "Shared chests" in your briefing).',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['view', 'deposit', 'withdraw'] },
        item: str('Item name (for deposit/withdraw)'),
        count: int('How many (default: all for deposit, 1 stack for withdraw)', { minimum: 1, maximum: 2304 }),
        x: int('X of a specific chest (optional)'),
        y: int('Y of a specific chest (optional)'),
        z: int('Z of a specific chest (optional)'),
      },
      required: ['operation'],
    },
  },
  {
    name: 'trade_villager',
    description: 'Trade with a real Minecraft villager or wandering trader nearby. No arguments: see their trades. want=item to buy it (usually for emeralds); give=item to sell it (usually for emeralds, e.g. wheat, coal, paper). Sell your surplus to get emeralds, then buy what you need.',
    input_schema: {
      type: 'object',
      properties: { want: str('Item to buy (optional)'), give: str('Item to sell (optional)'), times: int('How many times to repeat the trade (default 1)', { minimum: 1, maximum: 16 }) },
    },
  },
  {
    name: 'search_chests',
    description: 'Open the chests and barrels within 32 blocks and see what is in each (the village remembers). Give an item to take it from whichever chest has it, e.g. search_chests item=iron_ingot count=3.',
    input_schema: { type: 'object', properties: { item: str('Item to find and take (optional)'), count: int('How many to take (default: a stack)') } },
  },
  {
    name: 'equip',
    description: 'Hold or wear an item.',
    input_schema: {
      type: 'object',
      properties: {
        item: str('Item name'),
        slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'], description: 'Default hand' },
      },
      required: ['item'],
    },
  },
  {
    name: 'eat',
    description: 'Eat food from your inventory (best available if no item given).',
    input_schema: { type: 'object', properties: { item: str('Food item (optional)') } },
  },
  {
    name: 'attack',
    description: 'Fight the nearest mob of a type (e.g. "zombie", "cow"). Uses your best weapon.',
    input_schema: { type: 'object', properties: { target: str('Mob name or username') }, required: ['target'] },
  },
  {
    name: 'sleep',
    description: 'Sleep in the nearest bed (only works at night or in a thunderstorm).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'give_item',
    description: 'Walk to a player and toss them items.',
    input_schema: {
      type: 'object',
      properties: { player: str('Username'), item: str('Item name'), count: int('How many (default 1)', { minimum: 1, maximum: 2304 }) },
      required: ['player', 'item'],
    },
  },
  {
    name: 'build_house',
    description:
      'Build a house (walls with a doorway, flat roof) from your building blocks. A 5x5 house needs about 70 blocks. Pick flat, open ground. x,z is the north-west corner (default: next to you). If it runs out of blocks, gather more and run it again with the same settings to carry on. Hangs a door if you carry one.',
    input_schema: {
      type: 'object',
      properties: {
        x: int('X of the north-west corner'),
        z: int('Z of the north-west corner'),
        y: int('Floor level (default: the ground there)'),
        width: int('Size east-west (default 5)', { minimum: 3, maximum: 11 }),
        depth: int('Size north-south (default 5)', { minimum: 3, maximum: 11 }),
        height: int('Wall height (default 3)', { minimum: 2, maximum: 5 }),
        material: str('"any" (default), or a block like cobblestone, planks, stone_bricks'),
        door: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'Side the doorway faces (default south)' },
      },
    },
  },
  {
    name: 'build_wall',
    description:
      'Build a protective wall (a square ring) with a 3-wide gate. Give a centre and radius (default: around the village centre), or two opposite corners. Follows the ground. Each block of wall length needs `height` blocks; a radius-15 wall 3 high needs about 360. Places up to 160 blocks per run: run it again with the same settings to carry on.',
    input_schema: {
      type: 'object',
      properties: {
        center_x: int('Centre X (default: village centre)'),
        center_z: int('Centre Z (default: village centre)'),
        radius: int('Half the side length (default 12)', { minimum: 4, maximum: 48 }),
        x1: int('Corner 1 X (instead of centre/radius)'),
        z1: int('Corner 1 Z'),
        x2: int('Corner 2 X'),
        z2: int('Corner 2 Z'),
        height: int('Wall height (default 3)', { minimum: 1, maximum: 6 }),
        material: str('"any" (default), or a block like cobblestone, stone_bricks, planks'),
        gate: { type: 'string', enum: ['north', 'south', 'east', 'west', 'none'], description: 'Side for the gate (default south)' },
      },
    },
  },
  {
    name: 'list_schematics',
    description: 'List the building designs (schematics) available to build with build_schematic: name, size, how many blocks, and who designed them.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'build_schematic',
    description:
      'Build a design from the schematics folder (see list_schematics). In "shape" mode (default) the structure is built from whatever building blocks you carry (planks, cobblestone, logs...) and decorations like windows, furniture and lights are left out; "exact" uses the real block where you have it. Run with dry_run=true first to see how many blocks it needs. Places up to 160 blocks per run: run it again with the same settings to carry on. Big designs are long village projects: post tasks so others bring materials.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('Design name from list_schematics'),
        x: int('X of the north-west corner (default: next to you)'),
        y: int('Ground floor level (default: the ground there)'),
        z: int('Z of the north-west corner'),
        materials: { type: 'string', enum: ['shape', 'exact'], description: 'shape (default) or exact' },
        dry_run: { type: 'boolean', description: 'Only report what it needs; place nothing' },
      },
      required: ['name'],
    },
  },
  {
    name: 'build_farm',
    description:
      'Make a farm next to still water: till the dirt/grass around it with a hoe (crafts a wooden_hoe if you have none) and plant seeds (wheat_seeds from breaking grass, carrot, potato or beetroot_seeds). Up to 24 plots per run. Give x,z near the water, or it uses the nearest water.',
    input_schema: {
      type: 'object',
      properties: {
        x: int('X near the water'),
        z: int('Z near the water'),
        size: int('How far from the water to farm (1-4, default 4)', { minimum: 1, maximum: 4 }),
        seeds: str('Seed item to plant (default: whatever seeds you have)'),
      },
    },
  },
  {
    name: 'harvest_crops',
    description: 'Harvest ripe wheat, carrots, potatoes and beetroots nearby, replant them, and pick up the drops.',
    input_schema: { type: 'object', properties: { radius: int('Search radius (default 16)', { minimum: 4, maximum: 32 }) } },
  },
  {
    name: 'recover_items',
    description:
      'Go back to where you last died and pick up the items you dropped (they vanish about 5 minutes after death). Give coordinates to collect dropped items somewhere else instead.',
    input_schema: {
      type: 'object',
      properties: { x: int('X (optional)'), y: int('Y (optional)'), z: int('Z (optional)') },
    },
  },
  {
    name: 'set_home',
    description: 'Remember your current position as your home.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'go_home',
    description: 'Walk back to your home (or the village centre if you have no home yet).',
    input_schema: { type: 'object', properties: {} },
  },
];

export const ACTION_NAMES = new Set(ACTION_DEFS.map((a) => a.name));
