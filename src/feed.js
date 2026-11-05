// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { EventEmitter } from 'node:events';

/**
 * Village-wide live event stream. Everything interesting a villager does or thinks is
 * published here; the web dashboard subscribes to it over Server-Sent Events.
 */
export const feed = new EventEmitter();
feed.setMaxListeners(100);

const recent = []; // last N events, replayed to new viewers
const seenChat = new Map(); // de-dupe public chat heard by all 10 bots
let forward = null; // in a villager process: send events to the main process instead (see cluster.js)

export function forwardEventsTo(fn) {
  forward = fn;
}

export function publish(type, bot, data = {}) {
  const ev = { t: Date.now(), type, bot, ...data };
  if (forward) return forward(ev);
  publishEvent(ev);
}

/** Record and broadcast an event (also used by the main process for events from villager processes). */
export function publishEvent(ev) {
  const { type, ...data } = ev;
  if (type === 'heard') {
    const key = `${data.from}|${data.text}`;
    const now = Date.now();
    if (now - (seenChat.get(key) ?? 0) < 3_000) return;
    seenChat.set(key, now);
    if (seenChat.size > 200) for (const [k, v] of seenChat) if (now - v > 10_000) seenChat.delete(k);
  }
  recent.push(ev);
  if (recent.length > 400) recent.shift();
  feed.emit('event', ev);
}

export function recentEvents() {
  return recent.slice();
}

/** Persistent "experience" for each villager — what makes their brain grow. */
export function statsOf(memory) {
  memory.stats ??= {};
  const s = memory.stats;
  s.born ??= new Date().toISOString();
  s.actions ??= {}; // name -> { ok, fail }
  s.links ??= {}; // "a>b" -> count (actions used one after another: neurons that fire together wire together)
  s.social ??= {}; // name -> interactions
  s.thoughts ??= 0;
  s.deaths ??= 0;
  s.chats ??= 0;
  return s;
}

export function recordAction(memory, name, ok, prev) {
  const s = statsOf(memory);
  const a = (s.actions[name] ??= { ok: 0, fail: 0 });
  ok ? a.ok++ : a.fail++;
  if (prev && prev !== name) {
    const k = `${prev}>${name}`;
    s.links[k] = (s.links[k] ?? 0) + 1;
    const keys = Object.keys(s.links);
    if (keys.length > 60) {
      // forget the weakest connection
      keys.sort((x, y) => s.links[x] - s.links[y]);
      delete s.links[keys[0]];
    }
  }
}

export function recordSocial(memory, who) {
  if (!who) return;
  const s = statsOf(memory);
  s.social[who] = (s.social[who] ?? 0) + 1;
  const keys = Object.keys(s.social);
  if (keys.length > 16) {
    keys.sort((x, y) => s.social[x] - s.social[y]);
    delete s.social[keys[0]];
  }
}
