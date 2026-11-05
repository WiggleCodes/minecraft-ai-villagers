// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Village society: coins (a ledger kept on this machine), wages, trading, laws the villagers vote on,
// crimes, fines, jail and arrest warrants. Everything lives in store.society and is saved with the village.

const START_COINS = 20;
const VOTE_WINDOW_MS = 30 * 60_000;
const QUORUM = 3;
const JAIL_MS = 5 * 60_000;
const WARRANT_MS = 15 * 60_000;
export const RULES = ['max_withdraw', 'no_attack_villagers', 'no_breaking_buildings', 'curfew', 'custom'];

// What things are worth, in coins (anything unlisted: 1). Used for fair trades.
const PRICES = {
  log: 1, planks: 0.25, stick: 0.1, cobblestone: 0.5, stone: 0.5, dirt: 0.1, sand: 0.3, gravel: 0.3,
  coal: 2, raw_iron: 4, iron_ingot: 5, raw_gold: 6, gold_ingot: 8, diamond: 50, emerald: 20, copper_ingot: 2,
  wheat: 1, wheat_seeds: 0.2, bread: 3, beef: 2, cooked_beef: 4, porkchop: 2, cooked_porkchop: 4, chicken: 1, cooked_chicken: 3,
  mutton: 2, cooked_mutton: 3, apple: 2, carrot: 1, potato: 1, baked_potato: 2, wool: 2, leather: 3, bed: 10, torch: 0.5,
  wooden_pickaxe: 2, stone_pickaxe: 4, iron_pickaxe: 18, stone_sword: 3, iron_sword: 12, shield: 8, chest: 3, furnace: 5,
};
export function priceOf(item) {
  if (PRICES[item] != null) return PRICES[item];
  const fam = Object.keys(PRICES).find((k) => item.endsWith(`_${k}`)); // oak_log, white_wool, oak_planks...
  return fam ? PRICES[fam] : 1;
}

function soc(store) {
  store.society ??= {};
  const s = store.society;
  s.coins ??= {};
  s.treasury ??= 0;
  s.ledger ??= [];
  s.laws ??= [];
  s.crimes ??= [];
  s.jail ??= {};
  s.warrants ??= {};
  s.withdrawals ??= {};
  s.reports ??= [];
  return s;
}

function note(s, entry) {
  s.ledger.push({ t: new Date().toISOString(), ...entry });
  if (s.ledger.length > 300) s.ledger.splice(0, s.ledger.length - 300);
}

// ---------- coins ----------

export function coins(store, name) {
  const s = soc(store);
  s.coins[name] ??= START_COINS;
  return s.coins[name];
}

/** Pay wages (new coins from the village) for useful work. */
export function wage(store, name, amount, why) {
  if (!(amount > 0)) return;
  const s = soc(store);
  s.coins[name] = coins(store, name) + amount;
  note(s, { type: 'wage', to: name, amount, why });
  store.save();
}

/** Move coins between villagers. Returns an error message, or null when it worked. */
export function pay(store, from, to, amount, why) {
  amount = Math.round(Number(amount) * 100) / 100;
  if (!(amount > 0)) return 'Pay a positive amount.';
  if (coins(store, from) < amount) return `You only have ${coins(store, from)} coins.`;
  const s = soc(store);
  s.coins[from] -= amount;
  s.coins[to] = coins(store, to) + amount;
  note(s, { type: 'pay', from, to, amount, why });
  store.save();
  return null;
}

// ---------- laws ----------

export function proposeLaw(store, by, { text, rule = 'custom', limit, fine = 10 }) {
  const s = soc(store);
  if (!RULES.includes(rule)) rule = 'custom';
  const id = s.laws.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  const law = { id, text: String(text).slice(0, 200), rule, limit: Number(limit) || 32, fine: Math.min(Math.max(Number(fine) || 10, 1), 100), by, votes: { [by]: 'yes' }, status: 'proposed', t: new Date().toISOString() };
  s.laws.push(law);
  store.save();
  return law;
}

/** Cast a vote; returns the law (its status shows if this vote decided it). */
export function voteLaw(store, name, id, yes) {
  const s = soc(store);
  const law = s.laws.find((l) => l.id === Number(id) && l.status === 'proposed');
  if (!law) return { error: `There is no open proposal #${id}.` };
  law.votes[name] = yes ? 'yes' : 'no';
  tallyLaws(store);
  store.save();
  return { law };
}

/** Decide proposals: enacted with a quorum and more yes than no; closed when the window ends. */
export function tallyLaws(store) {
  const s = soc(store);
  const decided = [];
  for (const law of s.laws.filter((l) => l.status === 'proposed')) {
    const v = Object.values(law.votes);
    const yes = v.filter((x) => x === 'yes').length;
    const no = v.length - yes;
    const expired = Date.now() - Date.parse(law.t) > VOTE_WINDOW_MS;
    if (yes >= QUORUM && yes > no) law.status = 'active';
    else if (expired) law.status = 'rejected';
    else continue;
    law.decided = new Date().toISOString();
    decided.push(law);
  }
  if (decided.length) store.save();
  return decided;
}

export const activeLaws = (store) => soc(store).laws.filter((l) => l.status === 'active');
export const openProposals = (store) => soc(store).laws.filter((l) => l.status === 'proposed');

// ---------- crime and punishment ----------

export const isJailed = (store, name) => (soc(store).jail[name] ?? 0) > Date.now();
export const jailUntil = (store, name) => soc(store).jail[name] ?? 0;
export const hasWarrant = (store, name) => (soc(store).warrants[name] ?? 0) > Date.now();
export const wanted = (store) => Object.entries(soc(store).warrants).filter(([, t]) => t > Date.now()).map(([n]) => n);

/**
 * A law was broken: fine the offender; if they can't pay or it's a repeat offence, jail them; three crimes
 * within an hour also brings an arrest warrant (anyone may attack them until they're in jail).
 * Returns a short sentence describing the punishment.
 */
export function recordCrime(store, who, law, what) {
  const s = soc(store);
  s.crimes.push({ t: new Date().toISOString(), who, law: law.id, what });
  if (s.crimes.length > 300) s.crimes.splice(0, s.crimes.length - 300);
  const recent = s.crimes.filter((c) => c.who === who && Date.now() - Date.parse(c.t) < 3_600_000).length;
  const paid = Math.min(coins(store, who), law.fine);
  s.coins[who] -= paid;
  s.treasury += paid;
  note(s, { type: 'fine', from: who, amount: paid, why: `law #${law.id}: ${what}` });
  let sentence = `fined ${paid} coins`;
  if (paid < law.fine || recent >= 2) {
    s.jail[who] = Date.now() + JAIL_MS * Math.min(recent, 3);
    sentence += ` and jailed for ${Math.round((s.jail[who] - Date.now()) / 60_000)} minutes`;
  }
  if (recent >= 3) {
    s.warrants[who] = Date.now() + WARRANT_MS;
    sentence += '; a warrant is out for their arrest';
  }
  store.save();
  return sentence;
}

/** Called when a jailed villager reaches the jail: no need to chase them any more. */
export function arrived(store, name) {
  if (soc(store).warrants[name]) delete soc(store).warrants[name];
}

/** Two different villagers reporting the same crime against a custom law makes it count. */
export function report(store, by, who, lawId, what) {
  const s = soc(store);
  const law = activeLaws(store).find((l) => l.id === Number(lawId));
  if (!law) return { error: `Law #${lawId} isn't in force.` };
  if (by === who) return { error: "You can't report yourself." };
  const recent = s.reports.filter((r) => r.who === who && r.law === law.id && Date.now() - Date.parse(r.t) < 30 * 60_000);
  if (recent.some((r) => r.by === by)) return { error: 'You already reported that.' };
  s.reports.push({ t: new Date().toISOString(), by, who, law: law.id, what });
  if (s.reports.length > 200) s.reports.splice(0, s.reports.length - 200);
  if (recent.length + 1 >= 2) {
    s.reports = s.reports.filter((r) => !(r.who === who && r.law === law.id));
    return { convicted: true, law, sentence: recordCrime(store, who, law, String(what).slice(0, 120)) };
  }
  store.save();
  return { convicted: false };
}

/**
 * Check an action against the laws the code can see broken. Returns [{ law, what }] for each crime.
 * ctx: { names (all villager names), centre, houses, night, pos }
 */
export function crimesIn(store, name, action, input, ok, ctx) {
  const out = [];
  const names = ctx.names instanceof Set ? ctx.names : new Set(ctx.names ?? []);
  for (const law of activeLaws(store)) {
    if (law.rule === 'max_withdraw' && action === 'use_chest' && input?.operation === 'withdraw' && ok) {
      const s = soc(store);
      const list = (s.withdrawals[name] ??= []).filter((w) => Date.now() - w.t < 3_600_000);
      list.push({ t: Date.now(), n: Number(input.count) || 64 });
      s.withdrawals[name] = list;
      const total = list.reduce((n, w) => n + w.n, 0);
      if (total > law.limit) out.push({ law, what: `took ${total} items from the shared chests this hour (limit ${law.limit})` });
    }
    if (law.rule === 'no_attack_villagers' && action === 'attack' && names.has(input?.target) && !hasWarrant(store, input.target)) {
      out.push({ law, what: `attacked ${input.target}` });
    }
    if (law.rule === 'no_breaking_buildings' && action === 'dig_block' && ok && ctx.centre) {
      const { x, z } = input;
      const inHouse = (ctx.houses ?? []).some((h) => x >= h.x && x < h.x + 5 && z >= h.z && z < h.z + 5);
      const onWall = Math.max(Math.abs(x - ctx.centre.x), Math.abs(z - ctx.centre.z)) === 32;
      if (inHouse || onWall) out.push({ law, what: `broke part of ${inHouse ? 'a house' : 'the town wall'} at ${x}, ${z}` });
    }
  }
  return out;
}

/** Curfew: at night, villagers must be inside the town wall. */
export function curfewCrime(store, name, ctx) {
  const law = activeLaws(store).find((l) => l.rule === 'curfew');
  if (!law || !ctx.night || !ctx.centre || !ctx.pos) return null;
  const outside = Math.max(Math.abs(ctx.pos.x - ctx.centre.x), Math.abs(ctx.pos.z - ctx.centre.z)) > 34;
  return outside ? { law, what: 'was outside the town wall at night' } : null;
}

/** The society part of a villager's briefing. */
export function briefing(store, name, role) {
  const s = soc(store);
  const lines = [`- Your coins: ${coins(store, name)}. Village treasury: ${s.treasury}.`];
  const laws = activeLaws(store);
  lines.push(laws.length ? `- Laws in force: ${laws.map((l) => `#${l.id} ${l.text} (fine ${l.fine})`).join('; ')}` : '- No laws yet. Anyone can propose one with propose_law.');
  const toVote = openProposals(store).filter((l) => !l.votes[name]);
  if (toVote.length) lines.push(`- Proposals awaiting YOUR vote (vote_law): ${toVote.map((l) => `#${l.id} "${l.text}" by ${l.by}`).join('; ')}`);
  if (isJailed(store, name)) lines.push(`- YOU ARE IN JAIL until ${new Date(jailUntil(store, name)).toLocaleTimeString('en-GB')}. Stay at the village square.`);
  const myCrimes = s.crimes.filter((c) => c.who === name).slice(-2);
  if (myCrimes.length) lines.push(`- Your record: ${myCrimes.map((c) => `broke law #${c.law} (${c.what})`).join('; ')}`);
  const w = wanted(store).filter((n) => n !== name);
  if (w.length) lines.push(`- WANTED for arrest: ${w.join(', ')}.${/guard/i.test(role) ? ' As a guard, attack them on sight until they are in jail.' : ' Guards may attack them.'}`);
  return lines.join('\n');
}
