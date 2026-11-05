// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Messages between the main process and the villager processes: fire-and-forget (send/on) and
// request/reply (request/handle). Works over a forked child process's IPC channel, from either end.

export function createLink(port) {
  let seq = 0;
  const pending = new Map();
  const handlers = {};
  const listeners = {};

  port.on('message', async (m) => {
    if (m?.__reply) {
      const p = pending.get(m.__reply);
      if (!p) return;
      pending.delete(m.__reply);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { status: m.error.status, name: m.error.name }));
      else p.resolve(m.result);
      return;
    }
    if (m?.__req) {
      try {
        const handler = handlers[m.type];
        if (!handler) throw new Error(`no handler for ${m.type}`);
        const result = await handler(m.payload);
        if (port.connected) port.send({ __reply: m.__req, result });
      } catch (err) {
        if (port.connected) port.send({ __reply: m.__req, error: { message: err.message, status: err.status, name: err.name } });
      }
      return;
    }
    for (const fn of listeners[m?.type] ?? []) fn(m.payload);
  });

  return {
    send(type, payload) {
      if (port.connected) port.send({ type, payload });
    },
    request(type, payload, timeoutMs = 180_000) {
      return new Promise((resolve, reject) => {
        if (!port.connected) return reject(new Error('the other process has gone'));
        const id = ++seq;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${type} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        port.send({ __req: id, type, payload });
      });
    },
    handle(type, fn) {
      handlers[type] = fn;
    },
    on(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };
}
