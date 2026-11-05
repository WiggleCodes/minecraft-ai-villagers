// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// The villagers living in this process, and the village methods the control API uses to reach them.
import { AgentBot } from './bot/agentBot.js';
import { Brain } from './agent/brain.js';
import { observe } from './bot/observe.js';
import { statsOf } from './feed.js';

/** Create the bodies and brains for `profiles` (everyone in config.bots by default). */
export function createMembers({ config, store, client, limiter, profiles = config.bots }) {
  const allAgentNames = new Set(config.bots.map((b) => b.name));
  const members = new Map(); // lower-case name -> { agent, brain }
  for (const profile of profiles) {
    const agent = new AgentBot({ profile, config, store, allAgentNames });
    const brain = new Brain({ agent, client, limiter, config, allProfiles: config.bots });
    members.set(profile.name.toLowerCase(), { agent, brain });
  }
  return members;
}

/** Everything about a villager that other processes (and the dashboard) need, in plain JSON. */
export function snapshotOf({ agent, brain }) {
  const pos = agent.bot?.entity?.position;
  return {
    ...agent.status(),
    mode: brain.mode,
    thinking: brain.running,
    directive: brain.directive?.text ?? null,
    last_plan: brain.lastPlan,
    personality: agent.profile.personality,
    notes: agent.memory.notes,
    stats: statsOf(agent.memory),
    inventory: agent.inventorySnapshot(),
    pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
  };
}

const short = ({ inventory, pos, personality, notes, stats, ...status }) => status;

/** The village methods for members that live in this process. */
export function localVillage({ members, store, limiter }) {
  const get = (name) => {
    const v = members.get(String(name).toLowerCase());
    if (!v) {
      const err = new Error(`No villager called "${name}". Known: ${[...members.values()].map((m) => m.agent.name).join(', ')}`);
      err.status = 404;
      throw err;
    }
    return v;
  };
  const targets = (name) => (name === 'all' ? [...members.values()] : [get(name)]);
  return {
    store,
    limiter,
    members,
    get,
    has: (name) => members.has(String(name).toLowerCase()),
    snapshots: () => [...members.values()].map(snapshotOf),
    statuses: () => [...members.values()].map((m) => short(snapshotOf(m))),
    async detail(name) {
      const v = get(name);
      return { ...v.agent.status(), brain: v.brain.status(), observation: observe(v.agent) };
    },
    async log(name) {
      const v = get(name);
      return { actions: v.agent.actionLog, pending_events: v.agent.events };
    },
    action: (name, action, args) => get(name).agent.runAction(action, args, 'manual'),
    async directive(name, text, from) {
      const v = get(name);
      return { name: v.agent.name, accepted: v.brain.giveDirective(text, from) };
    },
    async request(name, text, from) {
      const list = targets(name);
      for (const v of list) v.agent.emit('request', { from, text, toAll: name === 'all' });
      return list.map((v) => v.agent.name);
    },
    async setMode(name, mode) {
      const list = targets(name);
      for (const v of list) v.brain.setMode(mode);
      return list.map((v) => v.agent.name);
    },
    async broadcast(text, from) {
      const list = [...members.values()].filter((v) => v.brain.mode !== 'manual');
      for (const v of list) v.brain.giveDirective(text, from, true);
      return list.map((v) => v.agent.name);
    },
  };
}
