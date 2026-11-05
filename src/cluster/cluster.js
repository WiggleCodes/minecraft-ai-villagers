// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Spread the villagers over several processes (SHARDS in .env) so they use several CPU cores and walk smoothly.
//
// The main process owns everything shared: the files (memory, coins, laws, habits, skills), the AI client and
// its rate limit, vote counting, and the control API. Each villager process runs its share of villagers with
// a copy of the shared state (refreshed every 2s); changes go to the main process, which is the source of truth.
// Villagers in other processes appear as "ghosts": where they are, what they carry and do, and they can be
// asked to act (e.g. hand over items in a trade).
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLink } from './link.js';
import { Store } from '../store.js';
import { createMembers, localVillage } from '../village.js';
import { publishEvent, forwardEventsTo } from '../feed.js';
import * as society from '../agent/society.js';
import { Vec3 } from '../bot/util.js';
import { configuredServices } from '../agent/providers.js';
import { log } from '../log.js';

const RUNNER = fileURLToPath(new URL('../runner.js', import.meta.url));
const SYNC_MS = 2_000;

/** Measures how late timers run (high = overloaded, villagers walk jerkily). Calls back with {avg, max}. */
export function lagMeter(onUpdate) {
  let last = Date.now();
  let sum = 0;
  let n = 0;
  let max = 0;
  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - 500);
    last = now;
    sum += lag;
    n++;
    max = Math.max(max, lag);
    onUpdate({ avg: Math.round(sum / n), max });
    if (n >= 120) [sum, n, max] = [0, 0, 0];
  }, 500).unref();
}

// ---------------------------------------------------------------------------------------------
// Main process

export function runMaster({ config, store, client, limiter }) {
  const n = Math.max(1, config.shards);
  const shards = [];
  const statuses = new Map(); // villager name -> latest snapshot from its process
  const owner = new Map(); // lower-case name -> shard index
  const lag = new Map(); // shard index -> { avg, max }

  const shardFor = (name) => {
    const i = owner.get(String(name).toLowerCase());
    if (i == null || !shards[i]) {
      const err = new Error(`No villager called "${name}".`);
      err.status = 404;
      throw err;
    }
    return shards[i].link;
  };

  function startShard(i) {
    const names = config.bots.filter((_, k) => k % n === i).map((p) => p.name);
    for (const name of names) owner.set(name.toLowerCase(), i);
    const child = fork(RUNNER, [], { env: { ...process.env, VILLAGE_SHARD: String(i) }, stdio: 'inherit', execArgv: process.execArgv });
    const link = createLink(child);
    shards[i] = { child, link, names };

    link.on('ready', () => link.send('init', {
      names,
      snapshot: store.snapshot(),
      memories: Object.fromEntries(names.map((name) => [name, store.botMemory(name)])),
      // Interleaved so the village as a whole still joins one villager per JOIN_DELAY_MS.
      joinOffsetMs: i * config.joinDelayMs,
      joinEveryMs: n * config.joinDelayMs,
    }));
    // Shared-state changes made in the villager process.
    link.on('op', ({ op, args }) => {
      try {
        store[op](...args);
        if (op === 'setVillageCenter') for (const s of shards) if (s && s !== shards[i]) s.link.send('villageMoved', args[0]);
      } catch (err) {
        log('village', `op ${op} failed: ${err.message}`);
      }
    });
    // Things that need one answer for everyone (task ids, fines, votes...).
    link.handle('storeCall', ({ method, args }) => store.call(method, ...args));
    // AI calls go through here so the rate limit is village-wide.
    link.handle('ai', async ({ params, urgent }) => {
      if (!client) throw new Error('No AI key set');
      await limiter.acquire(urgent);
      try {
        const r = await client.messages.create(params);
        limiter.record(r.usage);
        return r;
      } finally {
        limiter.release();
      }
    });
    link.handle('runActionFor', ({ name, action, args, source }) => shardFor(name).request('runAction', { name, action, args, source }, 600_000));
    link.on('status', ({ bots, memories, usage, loopLag }) => {
      for (const b of bots) statuses.set(b.name, b);
      for (const [name, mem] of Object.entries(memories ?? {})) store.bots[name] = mem;
      store.save();
      for (const [k, v] of Object.entries(usage ?? {})) limiter.usage[k] = (limiter.usage[k] ?? 0) + v;
      if (loopLag) {
        lag.set(i, loopLag);
        // The worst villager process is what you'd notice.
        limiter.usage.loop_lag_ms = Math.max(...[...lag.values()].map((l) => l.avg));
        limiter.usage.loop_lag_max_ms = Math.max(...[...lag.values()].map((l) => l.max));
      }
    });
    link.on('feed', (ev) => publishEvent(ev));
    child.on('exit', (code) => {
      log('village', `villager process ${i + 1} stopped (code ${code}); restarting it in 5s`);
      for (const name of names) {
        const s = statuses.get(name);
        if (s) s.online = false;
      }
      shards[i] = null;
      if (!stopping) setTimeout(() => startShard(i), 5_000);
    });
  }

  let stopping = false;
  for (let i = 0; i < n; i++) startShard(i);
  log('village', `${config.bots.length} villagers spread over ${n} processes`);

  // Keep every villager process's copy of the shared state fresh.
  setInterval(() => {
    limiter.usage.ai_queue_s = Math.round(limiter.waitMs() / 1000); // shown on /usage
    const ghosts = [...statuses.values()].map(({ stats, notes, personality, ...s }) => s);
    const payload = { snapshot: store.snapshot(), statuses: ghosts, limiter: { waitMs: limiter.waitMs(), urgentWaitMs: limiter.waitMs(true), overBudget: limiter.overBudget(), gapMs: limiter.gapMs || 5_000 } };
    for (const s of shards) s?.link.send('sync', payload);
  }, SYNC_MS).unref();

  // Votes are settled here, once, and announced by whoever proposed the law.
  setInterval(() => {
    for (const law of society.tallyLaws(store)) {
      const msg = law.status === 'active' ? `Law #${law.id} has passed: ${law.text}` : `Proposal #${law.id} was rejected: ${law.text}`;
      log('village', `⚖️ ${msg}`);
      publishEvent({ t: Date.now(), type: 'law', bot: law.by, id: law.id, text: law.text, status: law.status });
      try {
        shardFor(law.by).send('say', { name: law.by, text: msg });
      } catch {
        /* proposer not running */
      }
    }
  }, 10_000).unref();

  const strip = ({ inventory, pos, personality, notes, stats, ...s }) => s;
  const everyShard = async (type, payload) => (await Promise.all(shards.filter(Boolean).map((s) => s.link.request(type, payload).catch(() => [])))).flat();
  const village = {
    store,
    limiter,
    snapshots: () => [...statuses.values()],
    statuses: () => [...statuses.values()].map(strip),
    detail: (name) => shardFor(name).request('detail', name),
    log: (name) => shardFor(name).request('log', name),
    action: (name, action, args) => shardFor(name).request('action', { name, action, args }, 600_000),
    directive: (name, text, from) => shardFor(name).request('directive', { name, text, from }),
    request: (name, text, from) => (name === 'all' ? everyShard('request', { name, text, from }) : shardFor(name).request('request', { name, text, from })),
    setMode: (name, mode) => (name === 'all' ? everyShard('setMode', { name, mode }) : shardFor(name).request('setMode', { name, mode })),
    broadcast: (text, from) => everyShard('broadcast', { text, from }),
    stop() {
      stopping = true;
      for (const s of shards) s?.child.kill();
    },
  };
  return village;
}

// ---------------------------------------------------------------------------------------------
// Villager process

/** Another process's villager, as seen from here. */
function ghostOf(s, link) {
  return {
    name: s.name,
    profile: { role: s.role },
    connected: s.online,
    activity: s.activity,
    current: s.current_action ? { name: s.current_action, source: 'brain' } : null,
    status: () => s,
    inventorySnapshot: () => s.inventory ?? {},
    bot: s.pos ? {
      entity: { position: new Vec3(s.pos.x, s.pos.y, s.pos.z) },
      inventory: { items: () => Object.entries(s.inventory ?? {}).map(([name, count]) => ({ name, count })) },
    } : null,
    runAction: (action, args, source) => link.request('runActionFor', { name: s.name, action, args, source }, 600_000),
  };
}

export async function runShard({ config, index }) {
  const link = createLink(process);
  const store = new Store(config.dataFile, { replica: true });
  store.link = link;
  forwardEventsTo((ev) => link.send('feed', ev));
  // AI calls and the rate limit live in the main process.
  const hasAi = configuredServices(config).length > 0;
  const client = config.brain.enabled && hasAi ? {
    messages: {
      create(params, { urgent = false } = {}) {
        if (urgent) limiter.urgentSinceSync++;
        else limiter.sentSinceSync++;
        return link.request('ai', { params, urgent }, 600_000);
      },
    },
  } : null;
  const limiter = {
    usage: { habit_turns: 0, autopilot_turns: 0 },
    shared: { waitMs: 0, urgentWaitMs: 0, overBudget: false, gapMs: 15_000 },
    sentSinceSync: 0, // queued in the main process but not yet counted in shared.waitMs
    urgentSinceSync: 0, // ...of which jump the queue (the owner's instructions)
    acquire: async () => {},
    release() {},
    record() {},
    waitMs(urgent = false) {
      const { waitMs, urgentWaitMs = waitMs, gapMs } = this.shared;
      return urgent ? urgentWaitMs + this.urgentSinceSync * gapMs : waitMs + (this.sentSinceSync + this.urgentSinceSync) * gapMs;
    },
    overBudget() { return this.shared.overBudget; },
    callsLastHour: () => 0,
    maxCallsPerHour: 0,
  };

  const init = await new Promise((resolve) => {
    link.on('init', resolve);
    link.send('ready');
  });
  store.applySnapshot(init.snapshot);
  for (const [name, mem] of Object.entries(init.memories)) store.bots[name] = mem;

  const profiles = config.bots.filter((p) => init.names.includes(p.name));
  const members = createMembers({ config, store, client, limiter, profiles });
  const local = localVillage({ members, store, limiter });
  let ghosts = [];
  for (const m of members.values()) {
    m.brain.teammates = () => [...[...members.values()].filter((o) => o !== m).map((o) => o.agent), ...ghosts];
  }

  link.on('sync', ({ snapshot, statuses, limiter: shared }) => {
    store.applySnapshot(snapshot);
    limiter.shared = shared;
    limiter.sentSinceSync = 0;
    limiter.urgentSinceSync = 0;
    ghosts = statuses.filter((s) => !local.has(s.name)).map((s) => ghostOf(s, link));
  });
  link.on('villageMoved', (pos) => {
    for (const m of members.values()) {
      const home = m.agent.memory.home;
      if (home && Math.hypot(home.x - pos.x, home.z - pos.z) > 200) m.agent.memory.home = null;
    }
  });
  link.on('say', ({ name, text }) => local.has(name) && local.get(name).agent.say(text));
  link.handle('detail', (name) => local.detail(name));
  link.handle('log', (name) => local.log(name));
  link.handle('action', ({ name, action, args }) => local.action(name, action, args));
  link.handle('runAction', ({ name, action, args, source }) => local.get(name).agent.runAction(action, args, source));
  link.handle('directive', ({ name, text, from }) => local.directive(name, text, from));
  link.handle('request', ({ name, text, from }) => local.request(name, text, from));
  link.handle('setMode', ({ name, mode }) => local.setMode(name, mode));
  link.handle('broadcast', ({ text, from }) => local.broadcast(text, from));

  // Report in: statuses (for the API, dashboard and other processes), memories (to be saved) and counters.
  let loopLag = null;
  lagMeter((l) => { loopLag = l; });
  setInterval(() => {
    const usage = { ...limiter.usage };
    limiter.usage.habit_turns = 0;
    limiter.usage.autopilot_turns = 0;
    link.send('status', {
      bots: local.snapshots(),
      memories: Object.fromEntries([...members.values()].map((m) => [m.agent.name, m.agent.memory])),
      usage,
      loopLag,
    });
  }, SYNC_MS).unref();

  // The main process going away means we should too.
  process.on('disconnect', () => process.exit(0));

  log('village', `villager process ${index + 1}: ${profiles.map((p) => p.name).join(', ')}`);
  setTimeout(() => {
    let k = 0;
    for (const { agent } of members.values()) setTimeout(() => agent.connect(), k++ * init.joinEveryMs);
  }, init.joinOffsetMs);
}
