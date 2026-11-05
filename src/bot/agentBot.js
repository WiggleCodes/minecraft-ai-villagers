// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import mineflayer from 'mineflayer';
import { HANDLERS } from './actions.js';
import { ACTION_NAMES } from './actionDefs.js';
import { ActionError, Vec3, goals, tallyInventory, fmtPos, posObj, truncate, findInventoryItem, findFreeSpotNear, installFastFindBlocks, installSafeToolEquip } from './util.js';
import './pathBudget.js';
import { log } from '../log.js';
import { publish, recordAction, recordSocial, statsOf } from '../feed.js';

const require = createRequire(import.meta.url);
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const pvp = require('mineflayer-pvp').plugin;
const minecraftData = require('minecraft-data');

const WEAPON_RANK = ['netherite_sword', 'diamond_sword', 'netherite_axe', 'diamond_axe', 'iron_sword', 'iron_axe',
  'stone_sword', 'stone_axe', 'golden_sword', 'wooden_sword', 'golden_axe', 'wooden_axe'];
// Armour, best first, and where each piece goes: [equip destination, inventory slot it ends up in].
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'turtle', 'chainmail', 'golden', 'leather'];
const ARMOR_SLOTS = { helmet: ['head', 5], chestplate: ['torso', 6], leggings: ['legs', 7], boots: ['feet', 8] };
const OFF_HAND_SLOT = 45;
const MOVE_HERE = /this is (where you live|our (village|town|home)|your (new )?home)|(village|town) (centre|center) is here|move the (village|town) here|we live here now/i;
// Owner messages containing these become to-do requests rather than drop-everything directives.
const REQUEST_WORDS = /^\s*(todo|to do|later)\b|\b(when you can|when you get a chance|when you're free|whenever|sometime|no rush|no hurry|at some point)\b/i;
const armorTier = (name) => {
  const i = ARMOR_TIERS.findIndex((t) => name.startsWith(`${t}_`));
  return i < 0 ? ARMOR_TIERS.length : i;
};

class Cancelled extends Error {}

function findPlayerName(agent, target) {
  if (!target || !agent.bot?.players) return null;
  const k = Object.keys(agent.bot.players).find((u) => u.toLowerCase() === String(target).toLowerCase());
  return k ?? null;
}

const INSTANT = new Set(['stop', 'chat', 'whisper', 'observe', 'follow', 'set_home', 'find_block', 'equip']);

/**
 * One AI player: owns the mineflayer connection, executes actions, runs survival reflexes
 * and records events for its brain. The brain (or MCP) decides *what* to do; this class does it.
 */
export class AgentBot extends EventEmitter {
  constructor({ profile, config, store, allAgentNames }) {
    super();
    this.profile = profile;
    this.name = profile.name;
    this.config = config;
    this.store = store;
    this.allAgentNames = allAgentNames;
    this.memory = store.botMemory(this.name);
    this.bot = null;
    this.mcData = null;
    this.activity = 'idle';
    this.events = []; // things that happened since the brain last looked
    this.actionLog = []; // recent actions with results (for status + brain context)
    this.current = null; // { name, source, cancel }
    this.reconnectDelay = 10_000;
    this.chatQueue = [];
    this.lastChatAt = 0;
    this.lastHurtAt = 0;
    this.lastHurtBy = null;
    this.lastInventory = {}; // refreshed every second while alive, so we know what was lost on death
    this.lastSelfMessage = null; // latest server message about us, e.g. "Gimli was slain by Zombie"
    this.stopped = false;
    this.connected = false;
  }

  // ---------- connection ----------

  connect() {
    const { host, port, version, auth } = this.config.server;
    log(this.name, `connecting to ${host}:${port}…`);
    const bot = mineflayer.createBot({
      host,
      port,
      username: this.name,
      auth: auth ?? 'offline',
      version: version || false,
      hideErrors: true,
      checkTimeoutInterval: 60_000,
      // Chunks the server sends us (radius). 4 covers everything a villager does and keeps memory per
      // villager small, which matters with dozens of them. VIEW_DISTANCE in .env to change.
      viewDistance: Number(process.env.VIEW_DISTANCE || 4),
    });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(pvp);

    bot.once('spawn', () => this.onSpawn());
    bot.on('chat', (username, message) => this.onChat(username, message, false));
    bot.on('whisper', (username, message) => this.onChat(username, message, true));
    bot.on('messagestr', (msg) => {
      if (msg.startsWith(`${this.name} `) && !/joined the game|left the game|has made the advancement|has completed the challenge|has reached the goal/.test(msg)) {
        this.lastSelfMessage = { t: Date.now(), text: msg };
      }
    });
    bot.on('death', () => this.onDeath());
    bot.on('entityHurt', (entity) => {
      if (entity !== bot.entity) return;
      this.lastHurtAt = Date.now();
      const attacker = bot.nearestEntity((e) => (e.type === 'hostile' || e.type === 'player') && e.position.distanceTo(bot.entity.position) < 6);
      this.lastHurtBy = attacker;
      this.pushEvent('hurt', `You took damage${attacker ? ` from ${attacker.username ?? attacker.name}` : ''}. Health ${Math.round(bot.health)}/20.`, {
        wake: Date.now() - (this._lastHurtWake ?? 0) > 15_000,
      });
      this._lastHurtWake = Date.now();
      if (Date.now() - (this._lastHurtPub ?? 0) > 3_000) {
        this._lastHurtPub = Date.now();
        publish('hurt', this.name, { health: Math.round(bot.health), by: attacker?.username ?? attacker?.name ?? null });
      }
    });
    bot.on('wake', () => {
      if (this.activity === 'sleeping') this.activity = 'idle';
    });
    bot.on('kicked', (reason) => log(this.name, `kicked: ${truncate(typeof reason === 'string' ? reason : JSON.stringify(reason), 300)}`));
    bot.on('error', (err) => log(this.name, `error: ${err.message}`));
    bot.on('end', (reason) => this.onEnd(reason));
  }

  /** Remember where we died and what we dropped, so the brain can go back for it and learn from it. */
  onDeath() {
    const bot = this.bot;
    const pos = bot.entity ? posObj(bot.entity.position) : null;
    const where = pos ? fmtPos(pos) : 'unknown';
    const items = this.lastInventory;
    this.lastInventory = {};
    const carried = Object.entries(items).map(([k, v]) => `${k} x${v}`).join(', ');
    this.pushEvent('death', carried
      ? `You died near ${where} carrying ${carried}. Your items dropped there and vanish about 5 minutes after death: use recover_items soon if it is safe.`
      : `You died near ${where}. You had nothing on you.`, { wake: true });
    statsOf(this.memory).deaths++;
    publish('death', this.name, { where });
    this.halt('died');
    if (!pos) return;
    const death = { t: Date.now(), pos, items, cause: null, recovered: !carried };
    this.memory.deathSites = [...(this.memory.deathSites ?? []), death].slice(-5);
    this.store.save();
    // The death message can arrive just before or after the death event.
    setTimeout(() => {
      if (this.lastSelfMessage && Math.abs(this.lastSelfMessage.t - death.t) < 6_000) death.cause = this.lastSelfMessage.text;
      this.store.save();
      this.emit('died', death);
      this.autoRecover(death);
    }, 3_000);
  }

  /**
   * Reflex: go straight back for dropped items (they vanish 5 minutes after death) instead of trusting the
   * brain to remember. Skipped when the death spot itself is the danger (lava, a fall) or too far to reach in time.
   */
  async autoRecover(death) {
    if (death.recovered || !this.connected || !this.bot?.entity || this.bot.health <= 0) return;
    if (/lava|burn|flames|fire|fell|hit the ground|out of the world|drowned|suffocated/i.test(death.cause ?? '')) return;
    const p = this.bot.entity.position;
    if (Math.hypot(p.x - death.pos.x, p.z - death.pos.z) > 150) return;
    log(this.name, `reflex: going back for my items at ${fmtPos(death.pos)}`);
    publish('reflex', this.name, { kind: 'recover', text: `going back for dropped items at ${fmtPos(death.pos)}` });
    await this.runAction('recover_items', {}, 'reflex');
  }

  onSpawn() {
    const bot = this.bot;
    this.connected = true;
    this.reconnectDelay = 10_000;
    this.mcData = minecraftData(bot.version);
    const moves = new Movements(bot);
    moves.allowSprinting = true;
    moves.canDig = true;
    moves.allow1by1towers = true;
    bot.pathfinder.setMovements(moves);
    installFastFindBlocks(bot);
    installSafeToolEquip(bot);
    this.trackScaffolding(bot);
    // Route planning was ~45% of the village's CPU with dozens of villagers, mostly on routes that can't
    // succeed. Short, small searches in small per-tick slices keep every villager walking smoothly; all the
    // villagers in a process share one thinking budget (see pathBudget.js), so thinkTimeout is thinking time.
    bot.pathfinder.thinkTimeout = 1_000;
    bot.pathfinder.tickTimeout = 8;
    bot.pathfinder.searchRadius = 64;
    // Checking every route step for other players is costly with dozens of villagers; they can share paths.
    moves.allowEntityDetection = false;
    if (bot.collectBlock?.movements) bot.collectBlock.movements.allowEntityDetection = false;
    // pvp switches the pathfinder to its own (untuned) movements on every attack and never switches back.
    if (bot.pvp) bot.pvp.movements = moves;
    log(this.name, `spawned at ${fmtPos(bot.entity.position)} (MC ${bot.version})`);
    if (!this.store.village.center) this.store.setVillageCenter(posObj(bot.entity.position));
    this.pushEvent('spawn', `You are in the world at ${fmtPos(bot.entity.position)}.`, { wake: true });
    clearInterval(this.reflexTimer);
    this.reflexTimer = setInterval(() => this.reflexes().catch(() => {}), 1000);
    clearInterval(this.chatTimer);
    this.chatTimer = setInterval(() => this.flushChat(), 400);
    publish('online', this.name, { position: fmtPos(bot.entity.position) });
    this.emit('ready');
  }

  /**
   * The pathfinder towers up and bridges gaps with dirt/cobblestone and leaves them behind, which litters
   * the world. Remember every block placed that wasn't meant to be (placeItemAt marks the deliberate ones),
   * so clean_up can dig them back up.
   */
  trackScaffolding(bot) {
    this.scaffold ??= new Map(); // "x,y,z" -> { x, y, z, name, t, fails }
    const place = bot.placeBlock.bind(bot);
    bot.placeBlock = async (ref, face, ...rest) => {
      const deliberate = bot._deliberatePlace;
      const name = bot.heldItem?.name;
      try {
        return await place(ref, face, ...rest);
      } finally {
        if (!deliberate && name) {
          const p = ref.position.plus(face);
          this.scaffold.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z, name, t: Date.now(), fails: 0 });
          if (this.scaffold.size > 300) this.scaffold.delete(this.scaffold.keys().next().value);
        }
      }
    };
  }

  /** Leftover scaffolding still standing within `range` blocks, highest first (so towers come down from the top). */
  leftoverScaffold(range = 48) {
    const bot = this.bot;
    if (!bot?.entity || !this.scaffold?.size) return [];
    const me = bot.entity.position;
    const out = [];
    for (const [key, s] of this.scaffold) {
      if (Date.now() - s.t > 60 * 60_000) { this.scaffold.delete(key); continue; }
      const p = new Vec3(s.x, s.y, s.z);
      const block = bot.blockAt(p);
      if (!block) continue; // chunk not loaded: keep it for later
      if (block.name !== s.name) { this.scaffold.delete(key); continue; } // already gone (or replaced)
      if (p.distanceTo(me) <= range) out.push(p);
    }
    return out.sort((a, b) => b.y - a.y);
  }

  onEnd(reason) {
    this.connected = false;
    clearInterval(this.reflexTimer);
    clearInterval(this.chatTimer);
    this.current?.cancel?.('disconnected');
    publish('offline', this.name, { reason: String(reason ?? '') });
    if (this.stopped) return;
    log(this.name, `disconnected (${reason ?? 'unknown'}); reconnecting in ${Math.round(this.reconnectDelay / 1000)}s`);
    setTimeout(() => !this.stopped && this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 120_000);
  }

  disconnect() {
    this.stopped = true;
    clearInterval(this.reflexTimer);
    clearInterval(this.chatTimer);
    try {
      this.bot?.quit('shutting down');
    } catch {
      /* ignore */
    }
  }

  // ---------- chat & events ----------

  onChat(username, message, isWhisper) {
    if (!username || username === this.name) return;
    const fromAgent = this.allAgentNames.has(username);
    const lower = message.toLowerCase();
    const me = this.name.toLowerCase();
    const addressed = isWhisper || lower.includes(me) || /@all\b|@everyone\b/.test(lower);
    publish('heard', null, { from: username, text: message, ai: fromAgent, whisper: isWhisper });
    if (addressed) recordSocial(this.memory, username);
    const isOwner = !fromAgent && (this.config.owners.length === 0 || this.config.owners.map((o) => o.toLowerCase()).includes(username.toLowerCase()));

    // "@Name do X" or a whisper from an owner becomes a directive the brain must prioritise.
    const directiveMatch = message.match(new RegExp(`^@(${this.name}|all|everyone)\\b[:,]?\\s*(.+)$`, 'i'));
    // "This is where you live now" / "the village centre is here": move the village to where the owner stands.
    if (isOwner && MOVE_HERE.test(message)) this.moveVillageTo(username);
    if (isOwner && (directiveMatch || isWhisper)) {
      const text = directiveMatch ? directiveMatch[2] : message;
      if (/^(stop|halt|freeze)\b/i.test(text.trim())) {
        this.halt('told to stop');
        this.say(`Stopping, ${username}.`);
      }
      // "when you can", "later", "no rush", "todo:" => a request for the to-do list: the villager stays
      // autonomous and fits it in. Anything else is a directive: do it now, top priority.
      if (REQUEST_WORDS.test(text)) {
        const toAll = /^@(all|everyone)\b/i.test(message);
        this.emit('request', { from: username, text: text.replace(/^\s*(todo|to do|later)\s*[:,-]?\s*/i, '').trim(), toAll });
        return;
      }
      this.emit('directive', { from: username, text, toAll: /^@(all|everyone)\b/i.test(message) });
      return;
    }
    // Humans talking to us always wake the brain. A teammate addressing us does too, but at most every
    // 30s so two villagers can't keep waking each other in a chat loop.
    const wakeForTeammate = fromAgent && addressed && Date.now() - (this._lastTeammateWake ?? 0) > 30_000;
    if (wakeForTeammate) this._lastTeammateWake = Date.now();
    this.pushEvent(isWhisper ? 'whisper' : 'chat', `<${username}${fromAgent ? ' (AI)' : ''}> ${message}`, {
      wake: (addressed && !fromAgent) || wakeForTeammate,
      owner: isOwner && addressed, // the owner talking to us goes to the front of the AI queue
    });
  }

  /** Make where `username` stands the village centre, and forget homes far from it. */
  moveVillageTo(username) {
    const player = findPlayerName(this, username) && this.bot.players[findPlayerName(this, username)]?.entity;
    if (!player) return; // too far away to see them; a villager who can see them will handle it
    const pos = posObj(player.position);
    const old = this.store.village.center;
    const already = old && Math.hypot(old.x - pos.x, old.z - pos.z) < 8;
    if (!already) {
      this.store.setVillageCenter(pos);
      for (const mem of Object.values(this.store.bots)) {
        if (mem.home && Math.hypot(mem.home.x - pos.x, mem.home.z - pos.z) > 200) mem.home = null;
      }
      this.store.save();
      log(this.name, `🏠 village centre moved to ${fmtPos(pos)} (was ${old ? fmtPos(old) : 'unset'})`);
      this.say(`Got it, ${username}! This is our village now: the centre is ${fmtPos(pos)}.`);
    }
    this.pushEvent('village', `${username} moved the village: the village centre is now ${fmtPos(pos)}. Build and settle here; old homes far away were forgotten.`, { wake: true });
  }

  pushEvent(type, text, { wake = false, owner = false } = {}) {
    this.events.push({ t: Date.now(), type, text, owner });
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
    if (wake) this.emit('wake', type);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  say(message, { raw = false } = {}) {
    let text = String(message).replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!raw && text.startsWith('/')) text = text.slice(1); // brains don't run commands
    this.chatQueue.push(text.slice(0, 240));
    if (this.chatQueue.length > 5) this.chatQueue.shift();
  }

  flushChat() {
    if (!this.connected || !this.chatQueue.length) return;
    if (Date.now() - this.lastChatAt < this.config.chatCooldownMs) return;
    this.lastChatAt = Date.now();
    const text = this.chatQueue.shift();
    this.bot.chat(text);
    statsOf(this.memory).chats++;
    const w = text.match(/^\/msg (\S+) (.*)$/);
    if (w) publish('whisper', this.name, { to: w[1], text: w[2] });
    else publish('chat', this.name, { text });
  }

  // ---------- actions ----------

  /**
   * Run a named action. source = 'brain' | 'manual'. A manual action pre-empts whatever is running.
   * Returns { ok, result } or { ok:false, error } — never throws.
   */
  async runAction(name, args = {}, source = 'brain') {
    if (!ACTION_NAMES.has(name)) return { ok: false, error: `Unknown action "${name}".` };
    if (!this.connected || !this.bot?.entity) return { ok: false, error: 'Bot is not connected to the server right now.' };

    // Instant actions don't occupy the action slot and never pre-empt a running one.
    const instant = INSTANT.has(name);
    // 'manual' (you) and 'reflex' (automatic survival behaviour) pre-empt; the brain waits its turn,
    // and can't stop them either, only its own actions.
    const running = this.current;
    const notBrains = running && running.source !== 'brain' && source === 'brain';
    const why = running?.source === 'reflex' ? 'an automatic reflex (e.g. getting your dropped items back)' : 'your owner controlling you directly';
    if (running && !instant) {
      if (source !== 'brain') {
        running.cancel(`pre-empted by ${source} ${name}`);
        // The pathfinder applies a stop on its next tick; let it, or it would also stop our new walk.
        await new Promise((r) => setTimeout(r, 200));
      } else return { ok: false, error: `Busy with ${running.name}${notBrains ? `, ${why}` : ''}. Wait for it to finish (use wait), or use instant actions like chat.` };
    }
    if (name === 'stop') {
      if (notBrains) return { ok: false, error: `You can't stop ${running.name}: it is ${why}. Wait for it to finish.` };
      running?.cancel('stop requested');
    }
    if (source === 'manual' && !['observe', 'chat', 'whisper', 'find_block'].includes(name)) this.emit('manual-action', name);

    let cancelReason = null;
    let rejectCancel;
    const cancelPromise = new Promise((_, rej) => (rejectCancel = rej));
    cancelPromise.catch(() => {});
    const ctx = {
      bot: this.bot,
      agent: this,
      mcData: this.mcData,
      get cancelled() {
        return cancelReason !== null;
      },
      throwIfCancelled() {
        if (cancelReason !== null) throw new Cancelled(cancelReason);
      },
    };
    const entry = {
      name,
      source,
      cancel: (reason = 'cancelled') => {
        if (cancelReason) return;
        cancelReason = reason;
        this.stopMotion();
        rejectCancel(new Cancelled(reason));
      },
    };
    if (!instant) this.current = entry;
    if (name !== 'observe') publish('act', this.name, { name, source, args });

    const started = Date.now();
    let outcome;
    try {
      const result = await Promise.race([HANDLERS[name](ctx, args ?? {}), cancelPromise]);
      outcome = { ok: true, result };
    } catch (err) {
      if (err instanceof Cancelled) outcome = { ok: false, error: `Interrupted (${err.message}).` };
      else if (err instanceof ActionError) outcome = { ok: false, error: err.message };
      else outcome = { ok: false, error: `Failed: ${err?.message ?? err}` };
    } finally {
      if (this.current === entry) this.current = null;
      if (!instant && !['following', 'sleeping'].some((a) => this.activity.startsWith(a))) this.activity = 'idle';
    }
    const summary = outcome.ok ? truncate(outcome.result, 300) : outcome.error;
    this.actionLog.push({ t: Date.now(), source, name, args, ok: outcome.ok, summary, ms: Date.now() - started });
    if (this.actionLog.length > 30) this.actionLog.shift();
    if (name !== 'observe') {
      recordAction(this.memory, name, outcome.ok, this._prevAction);
      this._prevAction = name;
      const who = args?.player ?? (findPlayerName(this, args?.target));
      if (who) recordSocial(this.memory, who);
      this.store.save();
      publish('action', this.name, { name, source, ok: outcome.ok, summary: truncate(summary, 160), ms: Date.now() - started });
    }
    if (name !== 'observe') log(this.name, `${source}:${name} ${JSON.stringify(args)} → ${outcome.ok ? 'ok' : 'FAIL'} ${truncate(summary, 160)}`);
    return outcome;
  }

  stopMotion() {
    const bot = this.bot;
    if (!bot) return;
    // Order matters: cancelling a collect calls pathfinder.stop(), and a stop with no path in progress
    // lingers and kills the *next* walk. setGoal(null) afterwards clears it.
    try { bot.collectBlock?.cancelTask?.(); } catch { /* */ }
    try { bot.pvp?.stop(); } catch { /* */ }
    try { bot.pathfinder?.stop(); } catch { /* */ }
    try { bot.pathfinder?.setGoal(null); } catch { /* */ }
    try { bot.stopDigging(); } catch { /* */ }
    try { bot.clearControlStates(); } catch { /* */ }
  }

  halt(reason = 'stopped') {
    this.current?.cancel(reason);
    this.stopMotion();
    this.activity = 'idle';
  }

  inventorySnapshot() {
    return this.bot?.inventory ? tallyInventory(this.bot) : {};
  }

  async eat(itemName) {
    const bot = this.bot;
    const foods = this.mcData.foodsByName;
    let food = itemName ? findInventoryItem(bot, itemName) : null;
    if (!food) {
      food = bot.inventory.items()
        .filter((i) => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name))
        .sort((a, b) => (foods[b.name]?.foodPoints ?? 0) - (foods[a.name]?.foodPoints ?? 0))[0];
    }
    if (!food) throw new ActionError('No food in inventory.');
    if (bot.food >= 20) return 'Not hungry.';
    await bot.equip(food, 'hand');
    await bot.consume();
    return `Ate ${food.name}. Food ${Math.round(bot.food)}/20.`;
  }

  /** Wear the best armour we carry, and a shield in the off hand. Returns what was put on. */
  async equipBestArmor() {
    const bot = this.bot;
    const worn = [];
    for (const [piece, [dest, slot]] of Object.entries(ARMOR_SLOTS)) {
      const current = bot.inventory.slots[slot];
      const best = bot.inventory.items().filter((i) => i.name.endsWith(`_${piece}`)).sort((a, b) => armorTier(a.name) - armorTier(b.name))[0];
      if (best && (!current || armorTier(best.name) < armorTier(current.name))) {
        await bot.equip(best, dest);
        worn.push(best.name);
      }
    }
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (shield && !bot.inventory.slots[OFF_HAND_SLOT]) {
      await bot.equip(shield, 'off-hand');
      worn.push('shield');
    }
    return worn;
  }

  async equipBestWeapon() {
    const items = this.bot.inventory.items();
    for (const w of WEAPON_RANK) {
      const it = items.find((i) => i.name === w);
      if (it) return this.bot.equip(it, 'hand');
    }
  }

  saveMemory() {
    this.store.save();
  }

  // ---------- reflexes (run every second, no LLM involved) ----------

  async reflexes() {
    const bot = this.bot;
    if (!this.connected || !bot?.entity || this._reflexBusy) return;
    this._reflexBusy = true;
    try {
      if (bot.health > 0) this.lastInventory = tallyInventory(bot);
      // Put on better armour as soon as we have it.
      // (Not while a crafting/furnace/chest window is open: equipping clicks inventory slots.)
      if (Date.now() - (this._armorCheckAt ?? 0) > 5_000 && !['craft', 'smelt', 'use_chest', 'build_farm', 'harvest_crops'].includes(this.current?.name)) {
        this._armorCheckAt = Date.now();
        const worn = await this.equipBestArmor().catch(() => []);
        if (worn.length) {
          this.pushEvent('reflex', `Put on ${worn.join(', ')}.`);
          publish('reflex', this.name, { kind: 'equip', text: `put on ${worn.join(', ')}` });
        }
      }
      // Eat when hungry and not in the middle of something delicate. Health only comes back on a nearly
      // full stomach (18+), so when hurt, top up even if not really hungry.
      const hurt = bot.health <= 14 && bot.food < 20;
      if (((bot.food <= 14 || hurt) && !this.current) || bot.food <= 6 || (bot.health <= 8 && bot.food < 18)) {
        if (bot.inventory.items().some((i) => this.mcData.foodsByName[i.name])) {
          const ate = await this.eat().catch(() => null);
          if (ate && ate.startsWith('Ate')) publish('reflex', this.name, { kind: 'eat', text: ate.toLowerCase().replace(/\.$/, '') });
        }
      }
      // Self-defence: a hostile close by and we were hit recently.
      const threat = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 5);
      const recentlyHurt = Date.now() - this.lastHurtAt < 5_000;
      if (threat && recentlyHurt && !bot.pvp.target && this.current?.name !== 'attack') {
        if (bot.health <= 6) {
          // Too weak: run away instead.
          this.current?.cancel('fleeing');
          bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 16)), true);
          this.activity = `fleeing from ${threat.name}`;
          this.pushEvent('reflex', `Low health — fled from ${threat.name}.`, { wake: true });
          publish('reflex', this.name, { kind: 'flee', text: `fled from ${threat.name}` });
        } else {
          this.current?.cancel(`self-defence against ${threat.name}`);
          await this.equipBestWeapon().catch(() => {});
          bot.pvp.attack(threat);
          this.activity = `defending against ${threat.name}`;
          this.pushEvent('reflex', `Fighting off a ${threat.name}.`);
          publish('reflex', this.name, { kind: 'fight', text: `fighting off a ${threat.name}` });
        }
      } else if (this.activity.startsWith('defending') && !bot.pvp.target) {
        this.activity = 'idle';
      } else if (this.activity.startsWith('fleeing') && (!threat || bot.health > 10)) {
        bot.pathfinder.setGoal(null);
        this.activity = 'idle';
      }
      this.lifeReflexes();
    } finally {
      this._reflexBusy = false;
    }
  }

  /**
   * Everyday routines that need no thinking: sleep at night, put a carried bed down at the village, pick up
   * drops lying close by. They never interrupt you (manual control) or another reflex, and never run mid-fight.
   */
  lifeReflexes() {
    const bot = this.bot;
    const now = Date.now();
    if ((this.current && this.current.source !== 'brain') || this.activity === 'sleeping' || bot.pvp.target || now - this.lastHurtAt < 10_000) return;
    const hostileNear = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 10);
    const t = bot.time?.timeOfDay ?? 0;
    const sleepTime = (t >= 12542 && t <= 23459) || bot.thunderState > 0;
    this.bedIds ??= this.mcData.blocksArray.filter((b) => b.name.endsWith('_bed')).map((b) => b.id);

    // Sleep: sets our respawn point at home, and a sleeping villager costs no AI calls.
    if (sleepTime && !hostileNear && now - (this._sleepTryAt ?? 0) > 60_000) {
      const bed = bot.findBlock({ matching: this.bedIds, maxDistance: 32 });
      if (bed) {
        this._sleepTryAt = now;
        this.reflexAction('sleep', {}, `going to bed at ${fmtPos(bed.position)}`);
        return;
      }
    }
    // A carried bed is more use on the floor at the village than in a pocket.
    if (now - (this._bedPlaceAt ?? 0) > 120_000) {
      const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
      const centre = this.store.village.center;
      const nearHome = centre && Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z) < 40;
      if (bedItem && nearHome && !bot.findBlock({ matching: this.bedIds, maxDistance: 32 })) {
        this._bedPlaceAt = now;
        const spot = findFreeSpotNear(bot);
        if (spot) {
          this.reflexAction('place_block', { block: bedItem.name, x: spot.x, y: spot.y, z: spot.z }, `putting my ${bedItem.name} down`);
          return;
        }
      }
    }
    // Pick up drops lying close by when idle (unless a teammate is closer: it may have been tossed to them).
    if (!this.current && now - (this._pickupAt ?? 0) > 15_000) {
      const me = bot.entity.position;
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(me) < 8 && e.position.distanceTo(me) > 1.5);
      const someoneCloser = drop && Object.values(bot.players).some((p) => p.entity && p.entity !== bot.entity && p.entity.position.distanceTo(drop.position) < drop.position.distanceTo(me));
      if (drop && !someoneCloser) {
        this._pickupAt = now;
        const p = drop.position;
        this.reflexAction('recover_items', { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, 'picking up dropped items');
        return;
      }
    }
    // Tidy up pillars and bridges left behind while walking, once we're idle and nearby.
    if (!this.current && now - (this._cleanupAt ?? 0) > 45_000 && this.leftoverScaffold(24).length) {
      this._cleanupAt = now;
      this.reflexAction('clean_up', { range: 24 }, 'cleaning up the blocks I left lying around');
    }
  }

  /** Start an action as a reflex without blocking the reflex loop; tell the brain how it went. */
  reflexAction(name, args, why) {
    publish('reflex', this.name, { kind: name, text: why });
    this.runAction(name, args, 'reflex')
      .then((r) => { if (r.ok) this.pushEvent('reflex', `${why}: ${truncate(String(r.result), 120)}`); })
      .catch(() => {});
  }

  // ---------- status ----------

  status() {
    const bot = this.bot;
    const online = this.connected && !!bot?.entity;
    return {
      name: this.name,
      role: this.profile.role,
      online,
      position: online ? fmtPos(bot.entity.position) : null,
      health: online ? Math.round(bot.health) : null,
      food: online ? Math.round(bot.food) : null,
      activity: this.activity,
      current_action: this.current?.name ?? null,
      goal: this.memory.goal ?? null,
      home: this.memory.home ?? null,
      last_actions: this.actionLog.slice(-5).map((a) => `${a.source}:${a.name} ${a.ok ? 'ok' : 'fail'} — ${a.summary}`),
    };
  }
}
