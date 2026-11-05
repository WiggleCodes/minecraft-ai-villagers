// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import fs from 'node:fs';
import path from 'node:path';
import { STARTER_IDEAS } from './agent/libraryStarter.js';

const IMPORT_README = `Village library: imports
========================
Drop .txt or .json files here to give the villagers more things to do. They are read within a minute
(and again whenever you change them), and merged into ../activities.json. Duplicates are ignored.

.txt (or .md): one idea per line. Lines starting with # are ignored. Optional roles in [brackets]:
    Build a fishing hut on the lake shore
    [farmer, cook] Make a pumpkin patch next to the wheat farm
    [builder] Build a market square with stalls

.json: a list of ideas, as text or { "text": ..., "roles": [...] }:
    ["Build a bridge over the river", { "text": "Breed cows in a pen", "roles": ["hunter", "farmer"] }]

Roles are matched against each villager's role (farmer, lumberjack, miner, builder, mason, hunter, guard,
cook, fisher, shepherd, landscaper, courier, blacksmith, quartermaster, explorer). No roles = anyone.
`;

/**
 * Tiny JSON persistence for things that should survive restarts:
 * each villager's notes/goal/home/mode, the shared village notice board, the village centre,
 * and the village's shared learning (discovered resources and lessons from mistakes).
 */
export class Store {
  /**
   * A replica (in a villager process, see cluster.js) never touches the files: it gets its state from the
   * main process, applies changes locally so they're seen at once, and forwards them to the main process.
   */
  constructor(file, { replica = false } = {}) {
    this.file = file;
    this.replica = replica;
    this.link = null; // set on replicas: the connection to the main process
    let data = {};
    try {
      if (!replica) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    this.village = data.village ?? { center: null };
    this.board = data.board ?? [];
    this.bots = data.bots ?? {};
    this.knowledge = data.knowledge ?? [];
    this.lessons = data.lessons ?? [];
    this.tasks = data.tasks ?? [];
    this.society = data.society ?? {}; // coins, laws, crimes, jail (see agent/society.js)
    this.village.chests ??= {};
    // Learned routines live in their own file (data/habits.json) so they're easy to look at.
    this.habitsFile = path.join(path.dirname(file), 'habits.json');
    try {
      this.habits = replica ? {} : JSON.parse(fs.readFileSync(this.habitsFile, 'utf8'));
    } catch {
      this.habits = {};
    }
    // Skills memory (data/skills.json): how each autopilot step works out, per role, shared by everyone.
    this.skillsFile = path.join(path.dirname(file), 'skills.json');
    try {
      this.skills = replica ? {} : JSON.parse(fs.readFileSync(this.skillsFile, 'utf8'));
    } catch {
      this.skills = {};
    }
    // Solutions (data/solutions.json): problems villagers ran into and what fixed them (agent/troubleshoot.js).
    this.solutionsFile = path.join(path.dirname(file), 'solutions.json');
    try {
      this.solutions = replica ? {} : JSON.parse(fs.readFileSync(this.solutionsFile, 'utf8'));
    } catch {
      this.solutions = {};
    }
    // The village library (data/library/): things worth doing, learned and imported. Survives world resets.
    this.libraryDir = path.join(path.dirname(file), 'library');
    this.libraryFile = path.join(this.libraryDir, 'activities.json');
    this.library = { activities: [] };
    this._importSeen = new Map(); // import file -> mtime already read
    if (!replica) {
      try {
        this.library = JSON.parse(fs.readFileSync(this.libraryFile, 'utf8'));
      } catch {
        for (const idea of STARTER_IDEAS) this.addActivity(idea.text, idea.roles, 'starter');
      }
      this.library.activities ??= [];
      try {
        fs.mkdirSync(path.join(this.libraryDir, 'import'), { recursive: true });
        const readme = path.join(this.libraryDir, 'import', 'README.txt');
        if (!fs.existsSync(readme)) fs.writeFileSync(readme, IMPORT_README);
      } catch {
        /* read-only disk: imports just won't work */
      }
      this.loadImports();
      setInterval(() => this.loadImports(), 60_000).unref();
    }
    // Habits are shared village-wide (matched by role), so older per-villager ones are merged in.
    for (const [owner, situations] of Object.entries(this.habits)) {
      if (owner === 'village') continue;
      for (const [sit, afters] of Object.entries(situations ?? {})) {
        for (const [after, list] of Object.entries(afters ?? {})) {
          if (!Array.isArray(list)) continue;
          const into = (((this.habits.village ??= {})[sit] ??= {})[after] ??= []);
          for (const h of list) if (!into.some((x) => x.shape === h.shape)) into.push(h);
        }
      }
      delete this.habits[owner];
    }
    this._timer = null;
    if (replica) {
      // Changes made here are applied locally and forwarded to the main process, which owns the files.
      for (const op of Store.OPS) {
        const local = this[op].bind(this);
        this[op] = (...args) => {
          const result = local(...args);
          this.link?.send('op', { op, args });
          return result;
        };
      }
    }
  }

  // Shared-state changes that are safe to apply on a replica and forward (no ids handed out).
  // Ones that hand out ids (tasks) or decide things (society) go through call() to the main process.
  static OPS = ['setVillageCenter', 'post', 'addKnowledge', 'addLesson', 'noteChest', 'setPlan', 'recordHabit', 'habitResult', 'recordSkill', 'addHouse', 'addActivity', 'activityResult', 'archive', 'recordSolution'];
  static SHARED = ['village', 'board', 'tasks', 'knowledge', 'lessons', 'society', 'habits', 'skills', 'library', 'solutions'];

  /**
   * Run a store method (or a society function, as "society.<name>") where the shared state lives: here,
   * or in the main process when this is a replica. Always returns a promise.
   */
  async call(method, ...args) {
    if (this.replica) return this.link.request('storeCall', { method, args });
    if (method.startsWith('society.')) {
      const society = await import('./agent/society.js');
      return society[method.slice(8)](this, ...args);
    }
    return this[method](...args);
  }

  /** The shared state, for sending to replicas. */
  snapshot() {
    return Object.fromEntries(Store.SHARED.map((k) => [k, this[k]]));
  }

  /** Take the main process's shared state (keeps this process's own villagers' memories). */
  applySnapshot(snap) {
    for (const k of Store.SHARED) if (snap[k] !== undefined) this[k] = snap[k];
    this.village.chests ??= {};
  }

  addHouse(entry) {
    (this.village.houses ??= []).push(entry);
    this.save();
  }

  botMemory(name) {
    this.bots[name] ??= { notes: [], goal: null, home: null, mode: null };
    return this.bots[name];
  }

  setVillageCenter(pos) {
    this.village.center = pos;
    this.save();
  }

  /** True if `author` already posted something near-identical among the last 12 posts. */
  isRepeatPost(author, text) {
    const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    const a = words(text);
    return this.board.slice(-12).some((p) => {
      if (p.author !== author) return false;
      const b = words(p.text);
      const shared = [...a].filter((w) => b.has(w)).length;
      return shared / Math.max(1, Math.min(a.size, b.size)) >= 0.7;
    });
  }

  post(author, text) {
    this.board.push({ t: new Date().toISOString(), author, text: String(text).slice(0, 300) });
    if (this.board.length > 50) this.stash('board', this.board.splice(0, this.board.length - 50).map((p) => ({ ...p, text: `${p.author}: ${p.text}` })));
    this.save();
  }

  /** Shared discovery, one entry per resource per 16x16 area (re-finding it refreshes it). Returns true if new. */
  addKnowledge(author, name, pos) {
    const key = `${name}@${pos.x >> 4},${pos.z >> 4}`;
    const i = this.knowledge.findIndex((k) => k.key === key);
    if (i >= 0) this.knowledge.splice(i, 1);
    this.knowledge.push({ t: new Date().toISOString(), author, key, name: String(name).slice(0, 80), pos });
    if (this.knowledge.length > 60) this.stash('knowledge', this.knowledge.splice(0, this.knowledge.length - 60));
    this.save();
    return i < 0;
  }

  /** Shared lesson from a mistake. Returns true if it wasn't already known. */
  addLesson(author, text) {
    if (this.lessons.some((l) => l.text === text)) return false;
    this.lessons.push({ t: new Date().toISOString(), author, text });
    if (this.lessons.length > 25) this.stash('lessons', this.lessons.splice(0, this.lessons.length - 25));
    this.save();
    return true;
  }

  /** Last-seen contents of a chest, so everyone knows what the village already has. */
  noteChest(pos, contents) {
    this.village.chests[`${pos.x},${pos.y},${pos.z}`] = { t: new Date().toISOString(), contents };
    this.save();
  }

  // ---------- village task list ----------

  /** A claim with no finish after this long is treated as abandoned and the task reopens. */
  static CLAIM_TTL_MS = 20 * 60_000;

  isClaimed(task) {
    return !!task.claimedBy && Date.now() - Date.parse(task.claimedAt) < Store.CLAIM_TTL_MS;
  }

  /** The shared village plan: numbered steps everyone works towards, kept current by the coordinator. */
  setPlan(author, steps) {
    this.village.plan = { t: new Date().toISOString(), author, steps: steps.map((s) => String(s).slice(0, 200)).slice(0, 10) };
    this.save();
  }

  /** Add a task (optionally meant for one villager), or return the existing open one with the same text. */
  addTask(author, text, assignee = null, ideaId = null) {
    text = String(text).trim().slice(0, 200);
    const norm = text.toLowerCase();
    const existing = this.tasks.find((t) => !t.done && t.text.toLowerCase() === norm);
    if (existing) return { task: existing, added: false };
    const id = this.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const task = { id, t: new Date().toISOString(), author, text, assignee, claimedBy: null, claimedAt: null, done: false, ...(ideaId ? { ideaId } : {}) };
    this.tasks.push(task);
    // Keep every open task, but only the latest 10 finished ones.
    const done = this.tasks.filter((t) => t.done);
    if (done.length > 10) {
      const old = done.slice(0, -10);
      this.stash('tasks', old.map((t) => ({ t: t.doneAt ?? t.t, text: `#${t.id} ${t.text} (done by ${t.doneBy})`, note: t.note })));
      this.tasks = this.tasks.filter((t) => !old.includes(t));
    }
    this.save();
    return { task, added: true };
  }

  claimTask(id, name) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.done) return { error: `There is no open task #${id}.` };
    if (this.isClaimed(task) && task.claimedBy !== name) return { error: `${task.claimedBy} is already working on #${id}. Pick another task or help them directly.` };
    task.claimedBy = name;
    task.claimedAt = new Date().toISOString();
    this.save();
    return { task };
  }

  finishTask(id, name, note) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.done) return { error: `There is no open task #${id}.` };
    task.done = true;
    task.doneBy = name;
    task.note = note ? String(note).slice(0, 200) : null;
    task.doneAt = new Date().toISOString();
    this.save();
    return { task };
  }

  // ---------- habits: routines that worked, replayed without asking the AI ----------

  /**
   * Remember "in this situation, after `after`, I did `step` and it worked". Each villager builds up a
   * table of what usually comes next (chop logs -> craft planks -> deposit...), one step at a time.
   */
  recordHabit(bot, situation, after, step) {
    // Same habit = same action on the same thing (block/item/target...), whatever the amounts.
    const what = Object.fromEntries(Object.entries(step.input ?? {}).filter(([k]) => ['block', 'item', 'target', 'operation', 'player', 'name', 'material', 'seeds'].includes(k)));
    const shape = JSON.stringify([step.name, what]);
    const list = (((this.habits[bot] ??= {})[situation] ??= {})[after] ??= []);
    let habit = list.find((h) => h.shape === shape);
    if (!habit) {
      habit = { shape, step, ok: 0, fail: 0 };
      list.push(habit);
    }
    habit.step = step; // replay the most recent version
    habit.ok++;
    habit.last = new Date().toISOString();
    list.sort((a, b) => (b.ok - 2 * b.fail) - (a.ok - 2 * a.fail));
    if (list.length > 4) list.length = 4;
    this.save();
    return habit;
  }

  /** The step worth trusting after `after` here: worked at least twice, and much more often than it failed. */
  bestHabit(bot, situation, after) {
    return (this.habits[bot]?.[situation]?.[after] ?? []).find((h) => h.ok >= 2 && h.fail * 2 < h.ok) ?? null;
  }

  /** How a replayed habit went. Found by key (not object identity) so it also works across processes. */
  habitResult(bot, situation, after, shape, ok) {
    const habit = (this.habits[bot]?.[situation]?.[after] ?? []).find((h) => h.shape === shape);
    if (!habit) return;
    if (ok) habit.ok++;
    else habit.fail++;
    habit.last = new Date().toISOString();
    this.save();
  }

  // ---------- long-term memory archive: nothing is ever thrown away ----------
  // What drops out of the working memory (old notes, past jobs, lessons, discoveries, board posts, finished
  // tasks) is appended to data/memory-archive/<kind>.jsonl, without limit, and searchable with recall().

  /** Archive from a villager's own memory (forwarded to the main process, which writes it). */
  archive(kind, items) {
    this.stash(kind, items);
  }

  /**
   * Write to the archive (main process only). Store methods trimming shared lists use this directly: in a
   * villager process they're replayed by the main process anyway, so forwarding would write things twice.
   */
  stash(kind, items) {
    if (this.replica) return;
    const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
    if (!list.length) return;
    try {
      const dir = path.join(path.dirname(this.file), 'memory-archive');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(kind).replace(/[^\w-]+/g, '_').slice(0, 60);
      fs.appendFileSync(path.join(dir, `${safe}.jsonl`), list.map((x) => JSON.stringify(typeof x === 'string' ? { text: x } : x)).join('\n') + '\n');
    } catch (err) {
      console.error(`memory archive: ${err.message}`);
    }
  }

  /** Search the archive (and the live memory) for `query`. `who` adds that villager's own notes and jobs. */
  recall(query, who = null, limit = 8) {
    const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    const dir = path.join(path.dirname(this.file), 'memory-archive');
    const kinds = ['lessons', 'knowledge', 'board', 'tasks', 'library'];
    if (who) kinds.push(`notes-${who}`, `experience-${who}`);
    const found = [];
    const consider = (kind, entry) => {
      const text = [entry.text, entry.name, entry.how, entry.note, entry.pos && `at ${entry.pos.x},${entry.pos.y},${entry.pos.z}`].filter(Boolean).join(' ');
      const lower = text.toLowerCase();
      const score = words.filter((w) => lower.includes(w)).length;
      if (score) found.push({ score, t: entry.t ?? '', line: `[${kind.replace(/-.*/, '')}${entry.t ? ` ${String(entry.t).slice(0, 10)}` : ''}] ${text.slice(0, 220)}` });
    };
    for (const kind of kinds) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(dir, `${kind.replace(/[^\w-]+/g, '_')}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { consider(kind, JSON.parse(line)); } catch { /* skip a damaged line */ }
      }
    }
    for (const l of this.lessons) consider('lessons', l);
    for (const k of this.knowledge) consider('knowledge', k);
    if (who) for (const n of this.bots[who]?.notes ?? []) consider('notes', { text: n });
    found.sort((a, b) => b.score - a.score || String(b.t).localeCompare(String(a.t)));
    return found.slice(0, limit).map((f) => f.line);
  }

  // ---------- the village library: things worth doing (learned, imported, starter ideas) ----------

  /** Same idea, same id in every process (no central counter needed). */
  static ideaId(text) {
    const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    let h = 2166136261;
    for (const c of norm) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return `i${(h >>> 0).toString(36)}`;
  }

  /** Add an idea unless it's already there. Returns true if new. */
  addActivity(text, roles = [], source = 'learned') {
    text = String(text).trim().replace(/\s+/g, ' ').slice(0, 200);
    if (text.length < 8) return false;
    const id = Store.ideaId(text);
    if (this.library.activities.some((a) => a.id === id)) return false;
    const clean = (Array.isArray(roles) ? roles : [roles]).map((r) => String(r).toLowerCase().trim()).filter(Boolean).slice(0, 6);
    this.library.activities.push({ id, text, roles: clean, source: String(source).slice(0, 60), uses: 0, ok: 0, added: new Date().toISOString() });
    if (this.library.activities.length > 400) {
      // The working library keeps the 400 best; the idea that has worked least moves to the archive
      // (never the ones you imported).
      const drop = this.library.activities
        .filter((a) => !a.source.startsWith('import'))
        .sort((a, b) => (a.ok - a.uses * 0.3) - (b.ok - b.uses * 0.3))[0];
      if (drop) this.stash('library', this.library.activities.splice(this.library.activities.indexOf(drop), 1));
    }
    this.save();
    return true;
  }

  /** A villager took an idea on (ok=null), or finished it (ok=true). */
  activityResult(id, ok = null) {
    const a = this.library.activities.find((x) => x.id === id);
    if (!a) return;
    if (ok === null) a.uses++;
    else if (ok) a.ok++;
    a.last = new Date().toISOString();
    this.save();
  }

  /**
   * A few ideas suited to `role`: proven ones first (finished often for how often they're taken), with some
   * variety, skipping `exclude` (ids) and anything already on the open task list.
   */
  pickActivities(role, n = 3, exclude = []) {
    role = String(role ?? '').toLowerCase();
    const open = new Set(this.tasks.filter((t) => !t.done).map((t) => Store.ideaId(t.text)));
    return this.library.activities
      .filter((a) => !exclude.includes(a.id) && !open.has(a.id))
      .filter((a) => !a.roles.length || a.roles.some((r) => role.includes(r)))
      .map((a) => ({ a, score: (a.ok + 1) / (a.uses + 2) + Math.random() * 0.35 }))
      .sort((x, y) => y.score - x.score)
      .slice(0, n)
      .map((x) => x.a);
  }

  /** Read data/library/import/: .txt/.md (one idea per line, optional [roles]) and .json (list). */
  loadImports() {
    const dir = path.join(this.libraryDir, 'import');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(txt|md|json)$/i.test(f) && f !== 'README.txt');
    } catch {
      return;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (this._importSeen.get(f) === mtime) continue;
      this._importSeen.set(f, mtime);
      let ideas = [];
      try {
        const raw = fs.readFileSync(full, 'utf8').replace(/^﻿/, '');
        if (/\.json$/i.test(f)) {
          const data = JSON.parse(raw);
          ideas = (Array.isArray(data) ? data : data.ideas ?? data.activities ?? [])
            .map((x) => (typeof x === 'string' ? { text: x, roles: [] } : { text: x?.text, roles: x?.roles ?? [] }));
        } else {
          for (let line of raw.split(/\r?\n/)) {
            line = line.replace(/^\s*[-*\d.)]+\s+/, '').trim(); // allow bullet / numbered lists
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/^\[([^\]]*)\]\s*(.+)$/);
            ideas.push(m ? { text: m[2], roles: m[1].split(',') } : { text: line, roles: [] });
          }
        }
      } catch (err) {
        console.error(`library import ${f}: ${err.message}`);
        continue;
      }
      let added = 0;
      for (const idea of ideas) if (idea.text && this.addActivity(idea.text, idea.roles, `import:${f}`)) added++;
      if (added) console.log(`library: imported ${added} new idea${added === 1 ? '' : 's'} from ${f}`);
    }
  }

  // ---------- solutions: problems and what fixed them ----------

  /**
   * How a problem (see troubleshoot.problemKey) went: ok=true/false for a fix that was tried. `fix` (optional)
   * sets or replaces the fix: { how: text, steps?: [{ name, input }] }. A fix that keeps failing is replaced
   * by the next one found.
   */
  recordSolution(key, by, ok, fix = null) {
    const s = (this.solutions[key] ??= { ok: 0, fail: 0 });
    if (fix && (!s.how || s.fail > s.ok || fix.steps?.length)) {
      if (s.how && s.how !== fix.how) this.stash('solutions', { t: s.t, text: `${key} -> ${s.how}`, how: `replaced (${s.ok} ok, ${s.fail} failed)` });
      Object.assign(s, { how: String(fix.how).slice(0, 300), steps: fix.steps ?? s.steps ?? null, by, ok: 0, fail: 0 });
    }
    if (ok === true) s.ok++;
    if (ok === false) s.fail++;
    s.t = new Date().toISOString();
    this.save();
  }

  /** The best known fix for a problem, if it has worked more often than not. */
  solutionFor(key) {
    const s = this.solutions[key];
    return s?.how && s.fail <= s.ok + 1 ? s : null;
  }

  // ---------- skills: the autopilot training itself ----------

  /**
   * Record how a skill went for a role (shared experience). Resting a skill after repeated failures is
   * up to each villager (see Brain.skillResult): what fails for one, where they are, can work for another.
   */
  recordSkill(role, key, ok) {
    const s = ((this.skills[role] ??= {})[key] ??= { ok: 0, fail: 0, streak: 0 });
    if (ok) {
      s.ok++;
      s.streak = 0;
    } else {
      s.fail++;
      s.streak++;
    }
    delete s.restUntil; // (older versions rested skills for the whole role)
    s.last = new Date().toISOString();
    this.save();
  }

  /** Debounced write. */
  save() {
    if (this.replica) return; // the main process owns the files; our villagers' memories are sent with their status
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    if (this.replica) return;
    clearTimeout(this._timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ village: this.village, board: this.board, bots: this.bots, knowledge: this.knowledge, lessons: this.lessons, tasks: this.tasks, society: this.society }, null, 2));
    fs.renameSync(tmp, this.file);
    fs.mkdirSync(this.libraryDir, { recursive: true });
    for (const [f, data] of [[this.habitsFile, this.habits], [this.skillsFile, this.skills], [this.libraryFile, this.library], [this.solutionsFile, this.solutions]]) {
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${f}.tmp`, f);
    }
  }
}
