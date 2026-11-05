#!/usr/bin/env node
// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Limiter } from './agent/limiter.js';
import { createOpenAIClient } from './agent/openaiClient.js';
import { createPool } from './agent/aiPool.js';
import { configuredServices, verifyServices } from './agent/providers.js';
import { createMembers, localVillage } from './village.js';
import { runMaster, runShard, lagMeter } from './cluster/cluster.js';
import { startApi } from './api.js';
import { log } from './log.js';

const config = loadConfig();
process.on('unhandledRejection', (err) => log('village', `unhandled: ${err?.message ?? err}`));

// A villager process started by the main process (SHARDS > 1): it runs its share of the villagers.
if (process.env.VILLAGE_SHARD != null) {
  await runShard({ config, index: Number(process.env.VILLAGE_SHARD) });
} else {
  await startVillage();
}

async function startVillage() {
  log('village', "Wiggly's Minecraft AI Villagers, by WiggleCodes (https://github.com/WiggleCodes)");
  const store = new Store(config.dataFile);

  let client = null;
  let poolSize = 1;
  let perMinute = config.brain.maxCallsPerMinute;
  const services = configuredServices(config);
  if (config.brain.enabled && services.length) {
    // Every free AI service with a key in .env shares the work (see agent/providers.js). Each is tested
    // first, so a wrong key or a retired model doesn't slow the village down.
    log('village', `testing ${services.length} AI service${services.length === 1 ? '' : 's'}…`);
    const ok = await verifyServices(services, config.brain.model, (m) => log('village', m));
    const ai = (ok.length ? ok : services).map((s) => ({ name: s.name, model: s.model, rpm: s.rpm, tpm: s.tpm, client: createOpenAIClient(s) }));
    poolSize = ai.length;
    client = ai.length > 1 ? createPool(ai, (m) => log('village', m)) : ai[0].client;
    // The village may make as many calls a minute as all the services allow together.
    perMinute = ai.reduce((n, m) => n + (m.rpm || config.brain.maxCallsPerMinute || 4), 0);
    log('village', `brains: ${ai.map((m) => `${m.name}${m.model ? ` [${m.model}]` : ''}`).join(', ')} (${perMinute} calls/min together)`);
  } else if (config.brain.enabled) {
    log('village', 'No AI key set — starting every bot in manual mode (MCP control only).');
  } else {
    log('village', '--manual: brains disabled, bots only act on MCP/API commands.');
  }
  const limiter = new Limiter({
    ...config.brain,
    maxConcurrent: config.brain.maxConcurrent * poolSize,
    maxCallsPerMinute: perMinute,
  });

  let village;
  let shutdownVillagers;
  if (config.shards > 1) {
    // Villagers run in several processes (one CPU core each); this one keeps the shared state, AI and API.
    village = runMaster({ config, store, client, limiter });
    shutdownVillagers = () => village.stop();
  } else {
    const members = createMembers({ config, store, client, limiter });
    // Each brain sees its teammates (what they're doing, carrying, where) so they can coordinate.
    for (const m of members.values()) m.brain.teammates = () => [...members.values()].filter((o) => o !== m).map((o) => o.agent);
    village = localVillage({ members, store, limiter });
    // Stagger joins: servers throttle rapid connections from one IP (bukkit.yml connection-throttle).
    let i = 0;
    for (const { agent } of members.values()) setTimeout(() => agent.connect(), i++ * config.joinDelayMs);
    // Lag meter: how late timers fire. When it's high the program is overloaded and villagers walk jerkily.
    // Shown on /usage as loop_lag_ms (average) and loop_lag_max_ms over the last minute.
    lagMeter(({ avg, max }) => {
      limiter.usage.loop_lag_ms = avg;
      limiter.usage.loop_lag_max_ms = max;
    });
    shutdownVillagers = () => {
      for (const { agent, brain } of members.values()) {
        brain.stop();
        agent.disconnect();
      }
    };
  }

  startApi({ config, village });
  log('village', `${config.bots.length} villagers → ${config.server.host}:${config.server.port} | model ${config.brain.model} | owners: ${config.owners.join(', ') || 'anyone'}`);

  // Periodic usage line so you can keep an eye on cost.
  setInterval(() => {
    const u = limiter.usage;
    if (!u.calls) return;
    log('village', `LLM usage: ${u.calls} calls, ${u.input_tokens} in / ${u.output_tokens} out tokens, ${u.cache_read_input_tokens} cached (${limiter.callsLastHour()}/h)`);
  }, 10 * 60_000).unref();

  function shutdown() {
    log('village', 'shutting down…');
    shutdownVillagers();
    store.flush();
    setTimeout(() => process.exit(0), 500);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
