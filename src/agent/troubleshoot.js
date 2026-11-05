// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Figuring problems out: when an action fails, villagers recognise the problem, try a fix (a solution someone
// found before, or a built-in one), and retry. What fixed it is saved to data/solutions.json for everyone.
// Problems without a known fix that keep coming back get an AI turn to work out the cause.

/** Errors that aren't problems to solve: being interrupted, busy, or offline. */
export const NOT_A_PROBLEM = /^Interrupted|^Busy with|not connected|You can't stop|There is no active directive/i;

/** The same problem has the same key, whatever the numbers, coordinates or amounts. */
export function problemKey(action, error) {
  const gist = String(error)
    .toLowerCase()
    .replace(/-?\d+\s*,\s*-?\d+(\s*,\s*-?\d+)?/g, '<pos>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 90);
  return `${action}: ${gist}`;
}

const sum = (inv, re) => Object.entries(inv).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
const step = (name, input, why) => ({ name, input, why });

/**
 * Built-in fixes: [error pattern, (situation) => steps | null]. Steps are ordinary actions; the failed
 * action is retried after them. situation: { action, args, error, inv, chestNear, match }.
 */
const REMEDIES = [
  [/no tool that can harvest|Craft the right one first/i, (s) => step('craft', { item: sum(s.inv, /^cobblestone$|^cobbled_deepslate$/) >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe' }, 'I need the right tool, so I am crafting a pickaxe')],
  [/Inventory is full/i, (s) => {
    const spare = Object.entries(s.inv).filter(([n]) => !/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^shield$|_bed$/.test(n)).sort((a, b) => b[1] - a[1])[0];
    return spare && s.chestNear ? step('use_chest', { operation: 'deposit', item: spare[0] }, 'my inventory is full, so I am storing things') : null;
  }],
  [/none (free|reachable) within|No \w+ within \d+ blocks/i, (s) => (s.action === 'collect_block' || s.action === 'find_block' ? step('explore', { distance: 60 }, `there is none nearby, so I am looking further away for ${s.args.block ?? 'it'}`) : null)],
  [/No (smoker or |blast furnace or )?furnace (within|nearby)|No furnace nearby/i, (s) => (sum(s.inv, /^cobblestone$|^cobbled_deepslate$/) >= 8
    ? step('craft', { item: 'furnace' }, 'there is no furnace, so I am making one')
    : step('collect_block', { block: 'stone', count: 8 }, 'I need 8 cobblestone for a furnace'))],
  [/No fuel/i, () => step('collect_block', { block: 'log', count: 4 }, 'I need fuel, so I am getting some logs')],
  [/No chest within|no chest nearby/i, () => step('craft', { item: 'chest' }, 'there is no chest, so I am making one')],
  [/Missing ingredients for .*?One recipe needs: [^.]*\. You still need: ([^.]+)\./i, (s) => {
    const need = s.match[1];
    if (/planks|_log|stick/.test(need)) return step('collect_block', { block: 'log', count: 6 }, 'I am short of wood for the recipe, so I am chopping some');
    if (/cobblestone/.test(need)) return step('collect_block', { block: 'stone', count: 8 }, 'I am short of cobblestone, so I am mining some');
    if (/coal/.test(need)) return step('collect_block', { block: 'coal_ore', count: 4 }, 'I need coal, so I am mining some');
    if (/wool/.test(need)) return step('attack', { target: 'sheep' }, 'I need wool, so I am getting some from a sheep');
    return null; // something rarer: worth thinking about
  }],
  [/Could not reach|No path to the goal|Took to long to decide path/i, () => step('explore', { distance: 16 }, 'I could not get there from here, so I am moving to try another way')],
  [/did not fire within timeout/i, () => step('observe', {}, 'the game did not answer in time, so I am looking around and trying again')],
];

/** The built-in fix for an error, if there is one: [{ name, input, why }]. */
export function builtInFix(situation) {
  for (const [re, make] of REMEDIES) {
    const match = String(situation.error).match(re);
    if (!match) continue;
    const s = make({ ...situation, match });
    if (s) return [s];
  }
  return null;
}

/** Turn a learned solution's steps into something that can run now (none tied to old coordinates). */
export function usableSteps(steps) {
  return (steps ?? []).filter((s) => !['x', 'y', 'z', 'center_x', 'center_z'].some((k) => k in (s.input ?? {})));
}
