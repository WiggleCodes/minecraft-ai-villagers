// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Several AI services/keys used together. Each request goes to the service that's free soonest (each one is
// paced by its own rate limit), and a service that's rate-limited (429) or failing sits out for a while so the
// others carry the load. One that keeps hitting its limit (a used-up daily quota) sits out longer each time.
// Services with a small tokens-per-minute allowance get a compact version of the request (see compact.js).
import { estimateTokens, compactRequest } from './compact.js';

/**
 * members: [{ name, client, model?, rpm?, tpm? }] where client has the Anthropic-style messages.create().
 * A member's own model (e.g. a different provider's) replaces the default model in the request.
 */
export function createPool(members, log = () => {}) {
  const state = new Map(members.map((m) => [m, { nextAt: 0, restUntil: 0, strikes: 0, tokens: [], tpm: m.tpm || 0 }]));
  const gap = (m) => 60_000 / (m.rpm || 4);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Tokens a member has used in the last minute, and when enough will have freed up for `need` more.
  const tokenFreeAt = (s, need, now) => {
    s.tokens = s.tokens.filter((x) => now - x.t < 60_000);
    let used = s.tokens.reduce((n, x) => n + x.n, 0);
    if (!s.tpm || used + need <= s.tpm) return now;
    for (const x of s.tokens) {
      used -= x.n;
      if (used + need <= s.tpm) return x.t + 60_000;
    }
    return now + 60_000;
  };
  return {
    size: members.length,
    messages: {
      async create(params) {
        let lastErr = null;
        const tried = new Set();
        const full = estimateTokens(params);
        while (tried.size < members.length) {
          // The request as each service would get it (compacted for small allowances, or nothing if it can't fit).
          const now = Date.now();
          const options = members.filter((x) => !tried.has(x) && state.get(x).restUntil <= now).map((m) => {
            const s = state.get(m);
            const budget = s.tpm ? Math.floor(s.tpm * 0.9) : Infinity;
            const req = full <= budget ? params : compactRequest(params, budget);
            const need = req ? estimateTokens(req) : 0;
            return { m, s, req, need, at: req ? Math.max(s.nextAt, tokenFreeAt(s, need, now)) : Infinity };
          });
          for (const o of options) if (!o.req) tried.add(o.m); // too big for this one even compacted
          const pick = options.filter((o) => o.req).sort((a, b) => a.at - b.at)[0];
          if (!pick) break;
          const { m, s, req, need } = pick;
          tried.add(m);
          const start = Math.max(now, pick.at);
          s.nextAt = start + gap(m);
          if (start > now) await sleep(start - now);
          s.tokens.push({ t: Date.now(), n: need });
          try {
            const r = await m.client.messages.create(m.model ? { ...req, model: m.model } : req);
            s.strikes = 0;
            return r;
          } catch (err) {
            lastErr = err;
            if (err.status === 413) {
              // Bigger than this service takes: learn its real limit from the error, and use another.
              const limit = Number(String(err.message).match(/Limit (\d+)/)?.[1]);
              if (limit) s.tpm = limit;
              continue;
            }
            if (err.status === 429 || err.status >= 500 || err.name === 'TimeoutError') {
              s.strikes++;
              // 30 s, 1, 2, 4... minutes, up to an hour: long enough for a daily quota to stop being retried
              const secs = err.status === 429 ? Math.min(3_600, 30 * 2 ** (s.strikes - 1)) : 10;
              s.restUntil = Date.now() + secs * 1000;
              log(`AI pool: ${m.name} ${err.status ?? err.name}, resting it for ${secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`}`);
              continue;
            }
            throw err;
          }
        }
        throw lastErr ?? Object.assign(new Error('429 every AI in the pool is resting'), { status: 429 });
      },
    },
  };
}
