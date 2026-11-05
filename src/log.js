// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96];
const assigned = new Map();

function color(name) {
  if (!assigned.has(name)) assigned.set(name, COLORS[assigned.size % COLORS.length]);
  return assigned.get(name);
}

export function log(who, msg) {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const tag = process.stdout.isTTY ? `\x1b[${color(who)}m${who.padEnd(10)}\x1b[0m` : who.padEnd(10);
  // stderr keeps stdout clean (matters when anything is piped).
  process.stderr.write(`${t} ${tag} ${msg}\n`);
}
