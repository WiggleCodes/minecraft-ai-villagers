// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feed, recentEvents } from './feed.js';
import { ACTION_DEFS } from './bot/actionDefs.js';
import { log } from './log.js';

/**
 * Local control API used by the MCP server (and handy for curl/scripts).
 * Binds to 127.0.0.1 by default. Set API_TOKEN to require `Authorization: Bearer <token>`.
 */
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const THREE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'three');
// Public library files for the 3D brain, served locally so the dashboard works without internet.
const VENDOR = {
  '/vendor/three.module.js': path.join(THREE_DIR, 'build', 'three.module.min.js'),
  '/vendor/OrbitControls.js': path.join(THREE_DIR, 'examples', 'jsm', 'controls', 'OrbitControls.js'),
};
const PAGES = { '/': 'index.html', '/brains.html': 'index.html', '/brain': 'brain.html', '/brain.html': 'brain.html' };

/**
 * The control API talks to the village only through these methods, so it works the same whether all
 * villagers live in this process or are spread over several (see cluster.js):
 *   snapshots(), statuses(), detail(name), log(name), action(name, action, args), directive(name, text, from),
 *   request(name|'all', text, from), setMode(name|'all', mode), broadcast(text, from), plus .store and .limiter.
 */
export function startApi({ config, village }) {
  const { host, port, token } = config.api;
  const from = (body) => body.from ?? 'owner (via Claude)';

  const routes = [
    ['GET', /^\/health$/, () => ({ ok: true })],
    ['GET', /^\/brains$/, () => ({ bots: village.snapshots(), board: village.store.board.slice(-20), events: recentEvents() })],
    ['GET', /^\/actions$/, () => ACTION_DEFS],
    ['GET', /^\/library$/, () => village.store.library],
    ['GET', /^\/bots$/, () => village.statuses()],
    ['GET', /^\/bots\/([^/]+)$/, (m) => village.detail(m[1])],
    ['GET', /^\/bots\/([^/]+)\/log$/, (m) => village.log(m[1])],
    ['POST', /^\/bots\/([^/]+)\/action$/, (m, body) => village.action(m[1], body.action, body.args ?? {})],
    ['POST', /^\/bots\/([^/]+)\/directive$/, async (m, body) => {
      const { name, accepted } = await village.directive(m[1], body.text, from(body));
      return accepted
        ? { ok: true, note: `${name} will work on it. Check progress with get_bot.` }
        : { ok: false, error: `${name} is in manual mode. Set mode to "directed" or "autonomous" first.` };
    }],
    // A "when you can" request: goes on the task list; the villager stays autonomous and fits it in.
    ['POST', /^\/bots\/([^/]+)\/request$/, async (m, body) => {
      const names = await village.request(m[1], String(body.text), from(body));
      return { ok: true, note: m[1] === 'all' ? 'Added to the village task list for anyone to pick up.' : `${names[0]} will fit it in around their own work.` };
    }],
    ['POST', /^\/bots\/([^/]+)\/mode$/, async (m, body) => ({ ok: true, mode: body.mode, bots: await village.setMode(m[1], body.mode) })],
    ['POST', /^\/broadcast$/, async (m, body) => ({ ok: true, sent_to: await village.broadcast(body.text, from(body)) })],
    ['GET', /^\/board$/, () => village.store.board.slice(-30)],
    // Coins, laws, crimes, jail and warrants (see agent/society.js).
    ['GET', /^\/society$/, () => {
      const s = village.store.society ?? {};
      const coins = Object.entries(s.coins ?? {}).sort((a, b) => b[1] - a[1]);
      return {
        treasury: s.treasury ?? 0,
        richest: coins.slice(0, 10),
        laws: s.laws ?? [],
        recent_crimes: (s.crimes ?? []).slice(-15),
        jailed: Object.entries(s.jail ?? {}).filter(([, t]) => t > Date.now()).map(([n, t]) => ({ name: n, until: new Date(t).toISOString() })),
        wanted: Object.entries(s.warrants ?? {}).filter(([, t]) => t > Date.now()).map(([n]) => n),
        recent_ledger: (s.ledger ?? []).slice(-20),
      };
    }],
    ['POST', /^\/board$/, (m, body) => {
      village.store.post(body.author ?? 'Owner', body.text);
      return { ok: true };
    }],
    ['GET', /^\/usage$/, () => ({ ...village.limiter.usage, calls_last_hour: village.limiter.callsLastHour(), hourly_cap: village.limiter.maxCallsPerHour })],
  ];

  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && VENDOR[url.pathname]) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(VENDOR[url.pathname]));
      }
      // The dashboard (a browser) can't set headers on EventSource, so it may pass ?token= instead.
      if (token && req.headers.authorization !== `Bearer ${token}` && url.searchParams.get('token') !== token) {
        return send(401, { error: 'unauthorised' });
      }
      if (req.method === 'GET' && PAGES[url.pathname]) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(WEB_DIR, PAGES[url.pathname])));
      }
      if (req.method === 'GET' && url.pathname === '/stream') return stream(req, res);
      const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (!route) return send(404, { error: 'not found' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100_000) throw new Error('body too large');
        }
        body = raw ? JSON.parse(raw) : {};
      }
      const match = url.pathname.match(route[1]).map((s) => decodeURIComponent(s ?? ''));
      send(200, await route[2](match, body));
    } catch (err) {
      send(err.status ?? 400, { ok: false, error: err.message });
    }
  });
  // Server-Sent Events: live brain activity for the dashboard.
  function stream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write({ type: 'snapshot', t: Date.now(), bots: village.snapshots(), board: village.store.board.slice(-20), events: recentEvents() });
    const statusTimer = setInterval(() => {
      write({
        type: 'status',
        t: Date.now(),
        bots: village.statuses(),
        usage: { calls: village.limiter.usage.calls, per_hour: village.limiter.callsLastHour() },
      });
    }, 3000);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    feed.on('event', write);
    req.on('close', () => {
      clearInterval(statusTimer);
      clearInterval(ping);
      feed.off('event', write);
    });
  }

  server.listen(port, host, () => {
    log('API', `control API on http://${host}:${port}`);
    log('API', `🧠 brain dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  });
  return server;
}
