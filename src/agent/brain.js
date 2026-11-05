// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import { ACTION_DEFS, ACTION_NAMES } from '../bot/actionDefs.js';
import { observe } from '../bot/observe.js';
import { truncate, fmtPos } from '../bot/util.js';
import { SHARED_RULES, BRAIN_TOOLS, personaPrompt } from './prompts.js';
import { lessonFrom, discoveriesFrom, deathLesson } from './lessons.js';
import { NOT_A_PROBLEM, problemKey, builtInFix, usableSteps } from './troubleshoot.js';
import { nextSteps, skillKey } from './autopilot.js';
import * as society from './society.js';
import { planNext, explain as explainItem, chestLookup } from './planner.js';
import { log } from '../log.js';
import { publish, statsOf } from '../feed.js';

export const MODES = ['autonomous', 'directed', 'manual'];

// Same array for every bot => the tool block is a shared cacheable prefix.
const TOOLS = [...ACTION_DEFS, ...BRAIN_TOOLS].map((t, i, arr) =>
  i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
);

/**
 * The decision loop for one villager.
 *  - autonomous: thinks every ~tickSeconds and whenever something important happens
 *  - directed:   only works on instructions (from chat "@Name ..." or MCP tell_bot), then idles
 *  - manual:     brain off; only direct actions from MCP/HTTP move the bot
 */
export class Brain {
  constructor({ agent, client, limiter, config, allProfiles }) {
    this.agent = agent;
    this.client = client;
    this.limiter = limiter;
    this.cfg = config.brain;
    this.allProfiles = allProfiles;
    this.memory = agent.memory;
    this.mode = this.memory.mode && MODES.includes(this.memory.mode) ? this.memory.mode : this.cfg.defaultMode;
    if (!client) this.mode = 'manual';
    this.directive = null; // { from, text, ticks }
    this.timer = null;
    this.running = false;
    this.pendingWake = false;
    this.abortTick = false;
    this.holdUntil = 0;
    this.lastPlan = null;
    this.ticks = 0;
    this.coordinator = config.coordinator;
    this.habitStreak = 0; // habit turns in a row since the AI last thought
    this.aiDownUntil = 0; // set when the AI service refuses (e.g. out of credits): run on habits meanwhile
    this.turnActions = null; // actions of the current AI turn, to learn a habit from
    // Goal reviews by the AI are staggered so dozens of villagers don't all ask at once.
    this.lastAiAt = Date.now() - Math.random() * this.cfg.aiReviewMinutes * 60_000;
    this.teammates = () => []; // set by the runner once every villager exists
    this.system = [
      { type: 'text', text: SHARED_RULES },
      { type: 'text', text: personaPrompt(agent.profile, allProfiles, config.coordinator), cache_control: { type: 'ephemeral' } },
    ];

    agent.on('wake', () => this.wake());
    agent.on('ready', () => this.wake(2_000 + Math.random() * 6_000));
    agent.on('directive', (d) => this.giveDirective(d.text, d.from, d.toAll));
    agent.on('died', (d) => this.learnFromDeath(d));
    agent.on('request', (r) => this.takeRequest(r).catch((err) => log(this.name, `request failed: ${err.message}`)));
    agent.on('manual-action', () => {
      // A human took the wheel: pause autonomous thinking for a bit.
      this.holdUntil = Date.now() + this.cfg.manualHoldSeconds * 1000;
      if (this.running) this.abortTick = true;
    });
  }

  get name() {
    return this.agent.name;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    if (mode !== 'manual' && !this.client) throw new Error('No AI key set, so only manual mode is available.');
    this.mode = mode;
    this.memory.mode = mode;
    this.agent.saveMemory();
    if (mode === 'manual') {
      clearTimeout(this.timer);
      this.abortTick = this.running;
    } else {
      this.holdUntil = 0;
      this.wake();
    }
    log(this.name, `mode → ${mode}`);
    publish('mode', this.name, { mode });
  }

  giveDirective(text, from = 'owner', toAll = false) {
    // ticks: AI turns spent on it (only real ones count: waiting in the AI queue isn't failing).
    this.directive = { from, text: String(text).slice(0, 500), ticks: 0, toAll, toldWait: false };
    this.holdUntil = 0;
    log(this.name, `directive from ${from}: ${text}`);
    publish('directive', this.name, { from, text: this.directive.text });
    if (this.mode === 'manual') {
      this.agent.say(`(I'm in manual mode, ${from} — switch me to directed or autonomous to give me jobs.)`);
      return false;
    }
    if (this.running) this.abortTick = true;
    // A directive means drop everything: don't finish five minutes of chopping first. (Only our own
    // work: the owner's manual control and survival reflexes carry on.)
    if (this.agent.current?.source === 'brain') this.agent.current.cancel(`${from} gave me a job`);
    this.wake(300);
    return true;
  }

  wake(delay = 800) {
    if (this.mode === 'manual' || !this.client) return;
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    this.schedule(delay);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch((err) => log(this.name, `brain error: ${err.message}`)), ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.mode = 'manual';
  }

  nextDelay() {
    const base = this.cfg.tickSeconds * 1000;
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  // ---------------------------------------------------------------------------

  async tick() {
    if (this.mode === 'manual' || this.running) return;
    const agent = this.agent;
    if (!agent.connected) return this.schedule(10_000);
    if (Date.now() < this.holdUntil) return this.schedule(this.holdUntil - Date.now() + 500);
    if (this.mode === 'directed' && !this.directive) return; // idle until told something
    if (agent.activity === 'sleeping') return this.schedule(20_000);
    if (this.limiter.overBudget()) {
      log(this.name, 'hourly LLM budget reached; pausing thoughts for 5 min');
      return this.schedule(300_000);
    }

    this.running = true;
    this.abortTick = false;
    this.pendingWake = false;
    this.ticks++;
    let nextIn = null;
    const mind = this.chooseMind();
    if (mind.wait) {
      this.running = false;
      return this.schedule(mind.wait);
    }
    if (mind.habit || mind.autopilot) {
      // Learned habits and built-in know-how run without the AI (no credits, no waiting).
      this.remedyRunning = mind.remedy ?? null;
      try {
        nextIn = mind.habit ? await this.replayHabit(mind.habit) : await this.runAutopilot(mind.autopilot);
      } finally {
        this.remedyRunning = null;
        this.running = false;
      }
    } else {
      this.lastAiAt = Date.now();
      statsOf(this.memory).thoughts++;
      publish('thinking', this.name, { on: true });
      try {
        this.habitStreak = 0;
        this.turnActions = [];
        this.aiCalls = 0;
        if (mind.idea) await this.maybeTakeIdea().catch((err) => log(this.name, `library: ${err.message}`));
        nextIn = await this.think();
      } finally {
        this.turnActions = null;
        this.running = false;
        publish('thinking', this.name, { on: false });
      }
    }
    if (this.mode === 'manual') return;
    if (this.pendingWake || this.abortTick) return this.schedule(1_000);
    if (this.directive) {
      if (mind.ai && this.aiCalls) this.directive.ticks++;
      if (this.directive.ticks > 12) {
        agent.say(`I couldn't finish "${truncate(this.directive.text, 60)}", giving up for now.`);
        publish('directive-done', this.name, { summary: 'gave up', ok: false });
        this.directive = null;
      } else return this.schedule(nextIn ?? Math.min(3_000, this.nextDelay()));
    }
    if (this.mode === 'autonomous') this.schedule(nextIn ?? this.nextDelay());
  }

  // ---------- habits: learned routines, replayed without the AI ----------

  /**
   * The situation habits are matched on: role and day/night. (Not the goal text: the AI rewords it all the
   * time, so habits would never repeat. The AI's own turns keep steering towards the goal.)
   */
  situation() {
    const t = this.agent.bot?.time?.timeOfDay ?? 0;
    const night = t > 12500 && t < 23000;
    return `${this.agent.profile.role} | ${night ? 'night' : 'day'}`;
  }

  /** Anything here that needs real thinking: someone talking, danger, low health, a death, a request... */
  needsThought() {
    const bot = this.agent.bot;
    if (!bot?.entity) return true;
    // Danger is worth a thought, but not worth queueing minutes for: reflexes fight and the autopilot eats.
    const queueOk = this.limiter.waitMs() < 15_000;
    if (queueOk && bot.health < 10) return true;
    if (queueOk && bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 10)) return true;
    const humanChat = (e) => (e.type === 'chat' || e.type === 'whisper') && !e.text.includes('(AI)>');
    // (Not 'hurt' or 'spawn': reflexes handle fights, and with dozens of villagers those would flood the AI.)
    return this.agent.events.some((e) => humanChat(e) || ['death', 'request', 'village', 'directive', 'problem'].includes(e.type));
  }

  /**
   * Who runs this turn. The AI only for what needs understanding: a job from the owner, someone talking,
   * a request, a death, being stuck, or an occasional goal review. Otherwise a learned habit or the
   * autopilot's built-in know-how, so the village keeps going without the AI.
   */
  chooseMind() {
    if (this.directive) {
      // The owner's instructions jump the AI queue, but with many villagers asked at once our turn can still
      // be minutes away: keep working meanwhile and join the queue when it's close, instead of giving up.
      const wait = this.limiter.waitMs(true);
      if (wait <= 60_000) return { ai: true };
      if (!this.directive.toldWait && (!this.directive.toAll || this.actingCoordinator() === this.name)) {
        this.directive.toldWait = true;
        const who = this.directive.toAll ? "We'll each" : "I'll";
        this.agent.say(`On it, ${this.directive.from}! The AI is busy, so ${who} get to "${truncate(this.directive.text, 50)}" in a few minutes.`);
      }
      const steps = this.mode === 'autonomous' ? nextSteps(this) : [];
      return steps.length ? { autopilot: steps } : { wait: 10_000 + Math.random() * 20_000 };
    }
    if (this.mode !== 'autonomous') return { ai: true };
    const aiUp = Date.now() >= this.aiDownUntil;
    const queueOk = this.limiter.waitMs() < 15_000;
    if (aiUp && this.needsThought()) return { ai: true };
    this.societyTick();
    // In jail: walk to the village square and stay there until the sentence is served.
    if (society.isJailed(this.agent.store, this.name)) {
      const c = this.agent.store.village.center;
      const me = this.agent.bot?.entity?.position;
      if (c && me && Math.hypot(me.x - c.x, me.z - c.z) > 5) return { autopilot: [{ name: 'go_to', input: { x: c.x, y: c.y, z: c.z, range: 3 }, why: 'going to jail at the village square' }] };
      this.agent.store.call('society.arrived', this.name).catch(() => {});
      return { wait: 15_000 };
    }
    // Something just failed and there's a fix to try: do that first, then retry.
    if (this.remedy) {
      const remedy = this.remedy;
      this.remedy = null;
      return { autopilot: remedy.steps, remedy };
    }
    // A goal review (and, with nothing on our plate, an idea from the library to work on).
    if (aiUp && queueOk && Date.now() - this.lastAiAt > this.cfg.aiReviewMinutes * 60_000) return { ai: true, idea: true };
    const habit = this.habitToUse();
    if (habit) return { habit };
    const steps = nextSteps(this);
    if (steps.length) return { autopilot: steps };
    // Nothing the autopilot knows how to do here: that's something new for the AI to work out.
    return aiUp ? { ai: true, idea: true } : { wait: 20_000 };
  }

  // ---------- the village library: always something to do, and learning what's worth doing ----------

  /** Make a library idea this villager's task and goal. Returns the task, or null if someone else has it. */
  async adoptIdea(idea) {
    const store = this.agent.store;
    const { task } = await store.call('addTask', this.name, idea.text, this.name, idea.id);
    if (task.claimedBy && task.claimedBy !== this.name && store.isClaimed(task)) return null;
    await store.call('claimTask', task.id, this.name);
    store.activityResult(idea.id, null);
    this.memory.goal = idea.text;
    this.agent.saveMemory();
    this.lastIdeaAt = Date.now();
    log(this.name, `💡 took an idea from the library: ${truncate(idea.text, 120)} (task #${task.id})`);
    publish('goal', this.name, { text: idea.text });
    this.agent.pushEvent('request', `You had nothing on your plate, so you took an idea from the village library: "${idea.text}". It's your task #${task.id}. Plan it and do it; finish_task #${task.id} when done.`);
    return task;
  }

  /** Nothing to do (no directive, no task of our own, no fresh goal)? Take the best-suited library idea. */
  async maybeTakeIdea() {
    if (this.directive) return;
    const store = this.agent.store;
    if (store.tasks.some((t) => !t.done && t.claimedBy === this.name && store.isClaimed(t))) return;
    if (this.memory.goal && Date.now() - (this.lastIdeaAt ?? 0) < 30 * 60_000) return;
    const idea = store.pickActivities(this.agent.profile.role, 1)[0];
    if (idea) await this.adoptIdea(idea);
  }

  /**
   * Self-learning from a finished job: it goes into this villager's own experience (with how it was done),
   * and into the village library, so it's worth doing again (or counted as a success if it came from there).
   */
  learnFromJob(text, how, ideaId = null) {
    const store = this.agent.store;
    (this.memory.experience ??= []).push({ t: new Date().toISOString(), text: truncate(text, 140), how: how ? truncate(how, 120) : null });
    if (this.memory.experience.length > 40) store.archive(`experience-${this.name}`, this.memory.experience.shift());
    if (this.memory.goal === text) this.memory.goal = null;
    this.agent.saveMemory();
    if (ideaId) return store.activityResult(ideaId, true);
    // Jobs tied to a place ("bring logs to 2,70,6") don't generalise.
    if (/-?\d+\s*,\s*-?\d+/.test(text)) return;
    if (store.addActivity(text, [this.agent.profile.role.split(' ')[0].toLowerCase()], `learned:${this.name}`)) {
      log(this.name, `💡 learned a new idea for the library: ${truncate(text, 120)}`);
      publish('idea', this.name, { text });
    }
  }

  learnFromTask(task) {
    this.learnFromJob(task.text, task.note, task.ideaId ?? null);
  }

  // ---------- society: coins, laws, crime ----------

  /**
   * Settle votes and check the curfew now and then (cheap). With several villager processes the main
   * process settles votes instead (see cluster.js), so announcements aren't repeated.
   */
  societyTick() {
    const store = this.agent.store;
    if (!store.replica) {
      for (const law of society.tallyLaws(store)) {
        const msg = law.status === 'active' ? `Law #${law.id} has passed: ${law.text}` : `Proposal #${law.id} was rejected: ${law.text}`;
        log(this.name, `⚖️ ${msg}`);
        publish('law', this.name, { id: law.id, text: law.text, status: law.status });
        this.agent.say(msg);
      }
    }
    if (Date.now() - (this._curfewCheckAt ?? 0) > 120_000) {
      this._curfewCheckAt = Date.now();
      const t = this.agent.bot?.time?.timeOfDay ?? 0;
      const crime = society.curfewCrime(store, this.name, { night: t >= 13000 && t <= 23000, centre: store.village.center, pos: this.agent.bot?.entity?.position });
      if (crime) this.punish(crime).catch(() => {});
    }
  }

  /** Apply the punishment for a crime and let everyone know. */
  async punish({ law, what }) {
    const sentence = await this.agent.store.call('society.recordCrime', this.name, law, what);
    log(this.name, `🚨 broke law #${law.id} (${what}): ${sentence}`);
    publish('crime', this.name, { law: law.id, what, sentence });
    this.agent.pushEvent('crime', `You broke law #${law.id} "${law.text}" (${what}): ${sentence}.`, { wake: false });
    this.agent.say(`I broke law #${law.id} and was ${sentence}.`);
  }

  /** Wages for useful work, paid from the village. */
  payWages(name, r) {
    const PAY = { collect_block: 1, craft: 1, smelt: 1, harvest_crops: 2, build_farm: 3, build_house: 3, build_wall: 3, build_schematic: 3, attack: 1, trade_villager: 2 };
    let amount = PAY[name] ?? 0;
    if (name === 'use_chest' && /^Deposited [1-9]/.test(String(r.result))) amount = 2;
    if (/^build_/.test(name) && /Finished/.test(String(r.result))) amount += 20;
    if (amount) this.agent.store.call('society.wage', this.name, amount, name).catch(() => {});
  }

  /** Run the autopilot's steps, and train the shared skills memory with how each one went. */
  async runAutopilot(steps) {
    const store = this.agent.store;
    const role = this.agent.profile.role;
    publish('step', this.name, { step: 1, text: `Autopilot: ${steps[0].why}.`, tools: steps.map((s) => ({ name: s.name, input: s.input })) });
    const done = [];
    for (const s of steps) {
      if (this.abortTick || this.mode === 'manual') break;
      const r = await this.execTool(s.name, s.input ?? {});
      store.recordSkill(role, skillKey(s), !r.isError);
      this.skillResult(skillKey(s), !r.isError);
      if (s.name === 'build_house' && !r.isError && /Finished/.test(String(r.content))) {
        store.addHouse({ x: s.input.x, z: s.input.z, by: this.name, t: new Date().toISOString() });
      }
      if (r.isError) {
        this.lastPlan = `(autopilot: ${s.why}, but it failed: ${truncate(r.content, 120)})`;
        break;
      }
      done.push(s.why);
    }
    this.limiter.usage.autopilot_turns++;
    if (done.length) {
      this.lastPlan = `(autopilot) ${done.join(', then ')}`;
      publish('thought', this.name, { text: `${done.join(', then ')}.` });
    }
    return null;
  }

  /** Three failures in a row rest a skill for this villager (5-15 min) so they don't repeat a mistake. */
  skillResult(key, ok) {
    const rest = (this.skillRest ??= new Map());
    if (ok) return rest.delete(key);
    const r = rest.get(key) ?? { streak: 0, until: 0 };
    r.streak++;
    if (r.streak >= 3) r.until = Date.now() + Math.min(15, 5 * (r.streak - 2)) * 60_000;
    rest.set(key, r);
  }

  skillResting(key) {
    return (this.skillRest?.get(key)?.until ?? 0) > Date.now();
  }

  /** The learned first step for a habit turn here, if there is one we can use right now. */
  habitToUse() {
    if (this.mode !== 'autonomous' || this.directive || !this.cfg.habitRepeats) return null;
    const aiDown = Date.now() < this.aiDownUntil;
    // With many villagers sharing a rate-limited AI, queueing for it means standing around: keep working
    // on habits instead, and save the AI for things that need it (talk, danger, jobs).
    const crowded = this.limiter.waitMs() > 15_000;
    // Normally the AI still gets every (habitRepeats+1)th turn, and anything new goes to the AI;
    // while the AI is unavailable, habits are all we have.
    if (!aiDown && this.needsThought()) return null;
    if (!aiDown && !crowded && this.habitStreak >= this.cfg.habitRepeats) return null;
    // Habits are shared by everyone in the same role ("village"), so newcomers use what veterans learned.
    return this.agent.store.bestHabit('village', this.situation(), this.lastHabitKey ?? 'start');
  }

  /** Chain up to 4 learned steps ("after X I usually do Y") without asking the AI. */
  async replayHabit(first) {
    const store = this.agent.store;
    const done = [];
    let habit = first;
    while (habit && done.length < 4) {
      if (this.abortTick || this.mode === 'manual') break;
      const { name, input } = habit.step;
      const after = this.lastHabitKey ?? 'start';
      publish('step', this.name, { step: done.length + 1, text: 'Following a habit (no AI needed).', tools: [{ name, input }] });
      const r = await this.execTool(name, input ?? {});
      store.habitResult('village', this.situation(), after, habit.shape, !r.isError);
      if (r.isError) {
        this.habitStreak = this.cfg.habitRepeats; // let the AI look at what went wrong next turn
        this.lastPlan = `(my usual ${name} failed: ${truncate(r.content, 120)})`;
        log(this.name, `🔁 habit ${name} failed; thinking next turn`);
        return 1_000;
      }
      done.push(name);
      this.lastHabitKey = name;
      habit = store.bestHabit('village', this.situation(), name);
    }
    if (!done.length) return 1_000;
    this.habitStreak++;
    this.limiter.usage.habit_turns++;
    this.lastPlan = `(habit) ${done.join(' → ')}`;
    log(this.name, `🔁 habit: ${done.join(' → ')}`);
    publish('thought', this.name, { text: `Did my usual: ${done.join(' → ')}.` });
    return null;
  }

  /**
   * Learn from each action the AI chose, straight away: one that worked becomes "after <previous action>,
   * do this" for the current situation. Small talk and steps tied to exact coordinates (which go stale)
   * aren't learned.
   */
  learnStep(name, input, ok) {
    // Look-ups (find_block, list_schematics, dry runs) only help if the AI reads the answer, so they're not habits.
    const SKIP = ['chat', 'whisper', 'observe', 'stop', 'follow', 'go_to', 'dig_block', 'place_block', 'go_to_player', 'recover_items', 'eat', 'equip', 'find_block', 'list_schematics', 'clean_up', 'take_idea', 'add_idea', 'recall', 'record_fix'];
    if (SKIP.includes(name) || input?.dry_run) return;
    const after = this.lastHabitKey ?? 'start';
    if (ok && !this.directive) {
      const habit = this.agent.store.recordHabit('village', this.situation(), after, { name, input });
      if (habit.ok === 2) log(this.name, `🧠 learned a habit: after ${after}, ${name}`);
    }
    this.lastHabitKey = ok ? name : 'start';
  }

  briefing() {
    const a = this.agent;
    const parts = [];
    if (this.directive) {
      parts.push(`## DIRECTIVE from ${this.directive.from} (top priority)\n${this.directive.text}\n(Call complete_directive when it is done.)`);
    }
    const plan = a.store.village.plan;
    if (plan) {
      const age = Math.round((Date.now() - Date.parse(plan.t)) / 60_000);
      parts.push(`## Village plan (by ${plan.author}, updated ${age} min ago)\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    } else {
      parts.push('## Village plan\n(none yet — the coordinator will set one)');
    }
    if (this.actingCoordinator() === this.name) parts.push(`## Coordinator duties (you lead the village)\n${this.coordinatorDuties()}`);
    const opps = this.opportunities();
    parts.push(`## Opportunities right now (from your surroundings and inventory)\n${opps.map((o) => `- ${o}`).join('\n') || '- nothing special: follow your tasks and goal'}`);
    parts.push(`## Village tasks\n${this.tasksBriefing() || '(no open tasks)'}`);
    parts.push(`## Your team right now\n${this.teamBriefing() || '(no teammates online)'}`);
    const chests = this.chestBriefing();
    if (chests) parts.push(`## Shared chests (what the village already has)\n${chests}`);
    parts.push(`## Current goal\n${this.memory.goal ?? '(none set — choose one that fits your role, or take_idea below)'}`);
    const ideas = a.store.pickActivities(a.profile.role, 3);
    if (ideas.length) {
      const line = (i) => `- [${i.id}] ${i.text}${i.ok ? ` (done ${i.ok}x before)` : ''}`;
      parts.push(`## Ideas from the village library (take_idea one when you have nothing better to do)\n${ideas.map(line).join('\n')}`);
    }
    const done = (this.memory.experience ?? []).slice(-6).map((e) => `- ${e.text}${e.how ? ` — ${e.how}` : ''}`).join('\n');
    if (done) parts.push(`## What you've done before (your experience)\n${done}`);
    const problems = this.problemsBriefing();
    if (problems) parts.push(`## Problems you're working out (find the cause, fix it, then record_fix)\n${problems}`);
    if (this.lastPlan) parts.push(`## Your plan from last turn\n${this.lastPlan}`);
    const notes = this.memory.notes.map((n, i) => `${i}. ${n}`).join('\n');
    parts.push(`## Your memory notes (private)\n${notes || '(none)'}`);
    parts.push(`## Society (coins, laws, justice)\n${society.briefing(a.store, this.name, a.profile.role)}`);
    const deaths = this.deathBriefing();
    if (deaths) parts.push(`## Where you died recently (go back for your items if it is safe)\n${deaths}`);
    const lessons = a.store.lessons.map((l) => `- ${l.text}`).join('\n');
    parts.push(`## Village lessons (mistakes already made — don't repeat them)\n${lessons || '(none yet)'}`);
    parts.push(`## Village knowledge (shared discoveries, nearest first)\n${this.knowledgeBriefing() || '(nothing discovered yet — explore and use find_block)'}`);
    const board = a.store.board.slice(-8).map((b) => `[${b.author}] ${b.text}`).join('\n');
    parts.push(`## Village notice board (latest)\n${board || '(empty)'}`);
    const taken = a.takeEvents();
    const events = taken.map((e) => `- ${e.text}`).join('\n');
    parts.push(`## What happened since your last turn\n${events || '- nothing notable'}`);
    const recent = a.actionLog.slice(-12).map((x) => `- ${x.source === 'manual' ? '[controlled by owner] ' : ''}${x.name} ${JSON.stringify(x.args)} → ${x.ok ? 'ok' : 'FAILED'}: ${truncate(x.summary, 200)}`).join('\n');
    parts.push(`## Your recent actions\n${recent || '- none yet'}`);
    const obs = observe(a);
    parts.push(`## Observation\n${JSON.stringify(obs, null, 0)}`);
    // What the dashboard shows as the "senses" stage of this thought.
    this.perception = {
      events: taken.slice(-6).map((e) => ({ type: e.type, text: truncate(e.text, 140) })),
      health: obs.health,
      food: obs.food,
      time: obs.time,
      sees: (obs.nearby_blocks ?? []).slice(0, 4).map((b) => b.split(' (')[0]),
      near: (obs.nearby_entities ?? []).slice(0, 4),
      threat: (obs.nearby_entities ?? []).some((e) => e.startsWith('HOSTILE')),
      memories: this.memory.notes.length,
      goal: this.memory.goal ?? null,
      directive: this.directive?.text ?? null,
    };
    parts.push('Decide what to do now.');
    return parts.join('\n\n');
  }

  knowledgeBriefing() {
    const me = this.agent.bot?.entity?.position;
    const dist = (p) => (me ? Math.round(Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z)) : null);
    return this.agent.store.knowledge
      .map((k) => ({ k, d: dist(k.pos) }))
      .sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
      .slice(0, 15)
      .map(({ k, d }) => `- ${k.name} at ${k.pos.x},${k.pos.y},${k.pos.z}${d != null ? ` (${d}m away)` : ''}, found by ${k.author}`)
      .join('\n');
  }

  /**
   * An owner's "when you can" request: goes on the task list (for this villager, or for anyone if it was
   * said to @all) and the villager stays autonomous, fitting it in around its own work.
   */
  async takeRequest({ from, text, toAll }) {
    const store = this.agent.store;
    // Every villager hears "@all"; only the first one to handle it adds the task (addTask de-duplicates).
    const { task, added } = await store.call('addTask', from, text, toAll ? null : this.name);
    if (added) {
      log(this.name, `📋 request from ${from} → task #${task.id}${toAll ? ' (anyone)' : ''}: ${truncate(text, 120)}`);
      publish('task', this.name, { id: task.id, text: task.text, assignee: task.assignee, from });
    }
    if (toAll && !added) return;
    this.agent.pushEvent('request', `${from} asked ${toAll ? 'the village' : 'you'} (no rush, fit it in around your own work): "${text}". It's on the task list as #${task.id}.`, { wake: true });
    if (!toAll) this.agent.say(`Will do, ${from}, I'll fit that in.`);
    else if (added) this.agent.say(`Noted, ${from}. It's on the village task list.`);
  }

  // ---------- opportunities: what the surroundings and inventory make possible right now ----------

  /**
   * Worked out by code (no AI) from what the villager sees and carries, so even a modest model makes good
   * use of its surroundings: sleep, food, ores it can mine, upgrades it can afford, storage, beds, crops.
   */
  opportunities() {
    const agent = this.agent;
    const bot = agent.bot;
    if (!bot?.entity || !agent.mcData) return [];
    const mc = agent.mcData;
    const me = bot.entity.position;
    const inv = agent.inventorySnapshot();
    const have = (re) => Object.entries(inv).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
    const ids = (pred) => mc.blocksArray.filter((b) => pred(b.name)).map((b) => b.id);
    const nearest = (pred, r) => bot.findBlock({ matching: ids(pred), maxDistance: r });
    const dist = (p) => Math.round(p.distanceTo(me));
    const animal = (names, r = 24) => bot.nearestEntity((e) => names.includes(e.name) && e.position.distanceTo(me) < r);
    const out = [];

    const t = bot.time?.timeOfDay ?? 0;
    const night = t >= 12542 && t <= 23459;
    const bed = nearest((n) => n.endsWith('_bed'), 48);
    const canMakeBed = have(/_wool$/) >= 3 && (have(/_planks$/) >= 3 || have(/_log$/) >= 1);
    if (night) {
      if (bed) out.push(`It's night: sleep in the bed at ${fmtPos(bed.position)} (sleep). It sets your respawn point and passes the night safely.`);
      else if (canMakeBed) out.push("It's night and there's no bed nearby: craft a bed (3 wool + 3 planks, e.g. white_bed) and sleep.");
      else out.push("It's night and there's no bed: stay near the village, keep your sword ready, and shelter if hurt (build_shelter).");
    } else if (!bed) {
      if (have(/_bed$/)) out.push('You carry a bed: put it down near your home (place_block) so you can sleep tonight.');
      else if (canMakeBed) out.push('You have 3 wool and planks: craft a bed (e.g. white_bed) for tonight.');
      else {
        const sheep = animal(['sheep']);
        if (sheep) out.push(`A sheep is ${dist(sheep.position)}m away: get 3 wool for a bed (attack sheep).`);
      }
    }

    const litter = agent.leftoverScaffold(32).length;
    if (litter) out.push(`Leftover blocks: ${litter} stray block${litter === 1 ? '' : 's'} you placed while walking (pillars/bridges) still stand nearby: clean_up.`);

    const ripe = bot.findBlocks({ matching: ids((n) => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(n)), maxDistance: 16, count: 20 })
      .map((p) => bot.blockAt(p)).filter((b) => b && b.getProperties().age === (b.name === 'beetroots' ? 3 : 7));
    if (ripe.length) out.push(`${ripe.length} ripe crops nearby: harvest_crops (it replants for you).`);

    const RAW = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'];
    const raw = RAW.find((n) => inv[n]);
    const foods = Object.keys(inv).filter((n) => mc.foodsByName[n] && !RAW.includes(n) && n !== 'rotten_flesh');
    if (bot.health <= 14 && bot.food < 20) {
      out.push(`You're hurt (health ${Math.round(bot.health)}/20). Health only comes back with a nearly full food bar (18+), so eat (eat), cooking raw food first if you can (smelt), and avoid fights until healed.`);
    }
    if (bot.food < 16 && raw && (nearest((n) => n === 'furnace' || n === 'smoker', 32) || have(/^cobblestone$/) >= 8)) {
      out.push(`You're getting hungry: cook your raw ${raw} (smelt) for much better food.`);
    }
    if (!foods.length && !raw) {
      const prey = animal(['cow', 'pig', 'chicken', 'sheep', 'rabbit']);
      if (prey) out.push(`You have no food: the ${prey.name} ${dist(prey.position)}m away is a meal (attack ${prey.name}, then cook it).`);
    }

    // Ores it can actually mine with the best pickaxe it carries.
    const tier = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].findIndex((m) => inv[`${m}_pickaxe`]);
    const level = tier < 0 ? 0 : [5, 4, 3, 2, 1, 1][tier]; // 1 wood/gold, 2 stone, 3 iron, 4 diamond+
    const ORES = [['diamond_ore', 3], ['deepslate_diamond_ore', 3], ['iron_ore', 2], ['deepslate_iron_ore', 2], ['gold_ore', 3], ['copper_ore', 2], ['coal_ore', 1], ['deepslate_coal_ore', 1]];
    for (const [ore, need] of ORES) {
      if (level < need) continue;
      const b = nearest((n) => n === ore, 16);
      if (b) {
        out.push(`${ore} ${dist(b.position)}m away at ${fmtPos(b.position)}: collect_block ${ore.replace('deepslate_', '')}.`);
        break;
      }
    }

    // Upgrades it can afford right now.
    const iron = inv.iron_ingot ?? 0;
    if (tier < 0 && (have(/_planks$/) >= 3 || have(/_log$/) >= 1)) out.push('No pickaxe: craft a wooden_pickaxe.');
    else if (level < 2 && iron < 3 && have(/^cobblestone$|^cobbled_deepslate$/) >= 3) out.push('You can upgrade: craft a stone_pickaxe.');
    if (have(/^raw_iron$/) >= 3) out.push(`You have ${inv.raw_iron} raw_iron: smelt it into iron_ingot.`);
    if (iron >= 3 && level < 3) out.push('You have the iron: craft an iron_pickaxe.');
    if (!Object.keys(inv).some((n) => n.endsWith('_sword')) && (have(/_planks$/) >= 2 || have(/^cobblestone$/) >= 2)) out.push('No weapon: craft a sword (stone_sword or wooden_sword).');
    const armour = [['iron_chestplate', 8], ['iron_leggings', 7], ['iron_helmet', 5], ['iron_boots', 4]].filter(([n, c]) => iron >= c && !inv[n] && !bot.inventory.slots.some((s) => s?.name === n));
    if (armour.length) out.push(`You can afford iron armour: craft ${armour.map(([n]) => n).join(' or ')} (you put armour on automatically).`);
    if (iron >= 1 && have(/_planks$/) >= 6 && !inv.shield && bot.inventory.slots[45]?.name !== 'shield') out.push('You can craft a shield (6 planks + 1 iron_ingot).');

    const trader = bot.nearestEntity((e) => (e.name === 'villager' || e.name === 'wandering_trader') && e.position.distanceTo(me) < 32);
    if (trader) out.push(`A Minecraft ${trader.name.replace('_', ' ')} is ${dist(trader.position)}m away: trade_villager to see their trades, sell surplus for emeralds, and buy what you need.`);
    if (bot.inventory.emptySlotCount() <= 4) {
      const chest = nearest((n) => n === 'chest' || n === 'barrel', 32);
      out.push(chest ? `Your inventory is nearly full: deposit spare items in the chest at ${fmtPos(chest.position)} (use_chest).` : 'Your inventory is nearly full: craft a chest and store spare items at the village.');
    }
    return out.slice(0, 8);
  }

  // ---------- teamwork: plan, tasks, team, chests ----------

  /** The configured coordinator, or the first online villager if they're offline. */
  actingCoordinator() {
    const online = new Set([this.agent, ...this.teammates()].filter((t) => t.connected).map((t) => t.name));
    const order = this.allProfiles.map((p) => p.name);
    return online.has(this.coordinator) ? this.coordinator : order.find((n) => online.has(n));
  }

  /** Idle online teammates with no task in hand. */
  idleTeammates() {
    const store = this.agent.store;
    return this.teammates()
      .filter((t) => t.connected && t.activity === 'idle' && !t.current)
      .filter((t) => !store.tasks.some((x) => !x.done && x.claimedBy === t.name && store.isClaimed(x)))
      .map((t) => t.name);
  }

  coordinatorDuties() {
    const store = this.agent.store;
    const duties = [];
    const plan = store.village.plan;
    if (!plan) duties.push("There is no village plan yet: write one now with set_village_plan (3-6 concrete steps toward the owner's goals).");
    else if (Date.now() - Date.parse(plan.t) > 15 * 60_000) duties.push('The plan is over 15 minutes old: review it and update it if things have moved on.');
    const open = store.tasks.filter((t) => !t.done && !store.isClaimed(t)).length;
    if (open < 3) duties.push('Few open tasks: break the current plan step into concrete tasks with post_task, each for the best-suited teammate.');
    const idle = this.idleTeammates();
    if (idle.length) duties.push(`Idle teammates: ${idle.slice(0, 8).join(', ')}${idle.length > 8 ? ` and ${idle.length - 8} more` : ''}. Give them tasks (post_task with "for") or ask them in chat.`);
    return duties.length ? duties.map((d) => `- ${d}`).join('\n') : '- Everything is on track. Do your own work, and check in again in a few turns.';
  }

  tasksBriefing() {
    const store = this.agent.store;
    const open = store.tasks.filter((t) => !t.done).slice(-15).map((t) => {
      const who = store.isClaimed(t) ? (t.claimedBy === this.name ? 'YOU are on it' : `${t.claimedBy} is on it`) : 'open';
      const forWhom = t.assignee ? ` (for ${t.assignee === this.name ? 'YOU' : t.assignee})` : '';
      const byOwner = !this.allProfiles.some((p) => p.name === t.author);
      return `- #${t.id} [${who}] ${t.text}${forWhom}, ${byOwner ? `REQUESTED BY YOUR OWNER ${t.author}` : `posted by ${t.author}`}`;
    });
    const done = store.tasks.filter((t) => t.done).slice(-3).map((t) => `- #${t.id} [done by ${t.doneBy}] ${t.text}`);
    return [...open, ...done].join('\n');
  }

  teamBriefing() {
    const me = this.agent.bot?.entity?.position;
    const store = this.agent.store;
    // The 10 nearest teammates in detail (a big village would make every briefing huge otherwise).
    const online = this.teammates().filter((t) => t.connected && t.bot?.entity);
    const near = me ? [...online].sort((a, b) => a.bot.entity.position.distanceTo(me) - b.bot.entity.position.distanceTo(me)) : online;
    const shown = near.slice(0, 10);
    const rest = this.teammates().length - shown.length;
    return shown.map((t) => {
      const s = t.status();
      if (!s.online) return `- ${t.name} (${s.role}): offline`;
      const dist = me ? ` | ${Math.round(t.bot.entity.position.distanceTo(me))}m away` : '';
      const inv = Object.entries(t.inventorySnapshot()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ');
      const task = store.tasks.find((x) => !x.done && x.claimedBy === t.name && store.isClaimed(x));
      return `- ${t.name} (${s.role}): ${s.current_action ?? s.activity}${task ? ` [task #${task.id}]` : ''}${dist} | goal: ${truncate(s.goal ?? 'none', 80)} | carrying: ${inv || 'nothing'}`;
    }).join('\n') + (rest > 0 ? `\n- ...and ${rest} more villagers further away or offline` : '');
  }

  /** Chests someone looked into in the last 2 hours, with their biggest stacks. */
  chestBriefing() {
    return Object.entries(this.agent.store.village.chests ?? {})
      .filter(([, c]) => Date.now() - Date.parse(c.t) < 2 * 3_600_000)
      .map(([pos, c]) => {
        const items = Object.entries(c.contents).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ');
        return `- chest at ${pos} (checked ${Math.round((Date.now() - Date.parse(c.t)) / 60_000)} min ago): ${items || 'empty'}`;
      })
      .join('\n');
  }

  /** Unrecovered death sites from the last 10 minutes (dropped items despawn after 5). */
  deathBriefing() {
    return (this.memory.deathSites ?? [])
      .filter((d) => !d.recovered && Date.now() - d.t < 10 * 60_000)
      .map((d) => {
        const min = (Date.now() - d.t) / 60_000;
        const items = Object.entries(d.items).map(([k, v]) => `${k} x${v}`).join(', ');
        const status = min < 5
          ? `about ${Math.max(0, Math.round(5 - min))} min left before they vanish: use recover_items`
          : 'probably despawned by now';
        return `- ${Math.round(min)} min ago at ${d.pos.x},${d.pos.y},${d.pos.z}${d.cause ? ` (${d.cause})` : ''}. Dropped: ${items}. ${status}.`;
      })
      .join('\n');
  }

  learnFromDeath(death) {
    log(this.name, `☠️ died at ${death.pos.x},${death.pos.y},${death.pos.z}${death.cause ? ` (${death.cause})` : ''}`);
    const lesson = deathLesson(death.cause);
    if (lesson && this.agent.store.addLesson(this.name, lesson)) {
      log(this.name, `📘 lesson: ${lesson}`);
      publish('lesson', this.name, { text: lesson });
    }
  }

  /**
   * Feed an action's outcome into the village's shared lessons and knowledge, and into problem solving.
   * Returns a hint for the AI when it failed (a known or suggested fix).
   */
  learnFrom(name, r, input = {}) {
    const store = this.agent.store;
    if (r.ok) this.payWages(name, r);
    if (!r.ok) {
      const lesson = lessonFrom(r.error);
      if (lesson && store.addLesson(this.name, lesson)) {
        log(this.name, `📘 lesson: ${lesson}`);
        publish('lesson', this.name, { text: lesson });
      }
      return this.noteProblem(name, input, r.error);
    }
    this.problemSolved(name);
    for (const { name: what, pos } of discoveriesFrom(name, r.result)) {
      if (store.addKnowledge(this.name, what, pos)) publish('knowledge', this.name, { name: what, pos });
    }
    return null;
  }

  // ---------- problem solving: villagers figure issues out themselves ----------

  /**
   * An action failed: recognise the problem and line up a fix (a solution someone found before, or a
   * built-in one) to run before trying again. A problem that keeps coming back without a working fix gets
   * an AI turn to work out the cause. Returns a hint about the fix, for the AI.
   */
  noteProblem(name, input, error) {
    if (NOT_A_PROBLEM.test(error)) return null;
    const key = problemKey(name, error);
    const problems = (this.problems ??= new Map());
    for (const [k, e] of problems) if (Date.now() - e.t > 30 * 60_000) problems.delete(k);
    const p = problems.get(key) ?? { key, name, count: 0, fixes: 0 };
    Object.assign(p, { input, error, t: Date.now() });
    p.count++;
    problems.set(key, p);

    const store = this.agent.store;
    // A fix that was just tried didn't work.
    if (this.remedyRunning?.key === key && this.remedyRunning.known) store.recordSolution(key, this.name, false);
    const known = store.solutionFor(key);
    const learned = known ? usableSteps(known.steps).map((s) => ({ ...s, why: s.why ?? known.how })) : [];
    const mc = this.agent.mcData;
    const chestIds = ['chest', 'barrel'].map((n) => mc?.blocksByName[n]?.id).filter(Boolean);
    const steps = learned.length ? learned : builtInFix({
      action: name, args: input ?? {}, error, inv: this.agent.inventorySnapshot(),
      chestNear: !!this.agent.bot?.findBlock({ matching: chestIds, maxDistance: 32 }),
    });
    const hint = known ? `Known fix (worked for ${known.by} before): ${known.how}` : steps ? `Suggested fix: ${steps.map((s) => s.why).join('; ')}.` : null;
    if (steps && p.fixes < 2) {
      p.fixes++;
      this.remedy = { key, steps: [...steps, { name, input, why: `trying ${name} again` }], known: !!known, how: known?.how ?? steps.map((s) => s.why).join(', then ') };
      log(this.name, `🔧 problem: ${truncate(error, 100)} → ${known ? 'known fix' : 'trying'}: ${truncate(this.remedy.how, 120)}`);
    } else if (p.count >= 2 && !p.escalated) {
      p.escalated = true;
      log(this.name, `🤔 working out a problem: ${name} keeps failing: ${truncate(error, 120)}`);
      this.agent.pushEvent('problem', `PROBLEM TO SOLVE: ${name} has failed ${p.count} times: "${truncate(error, 200)}". ${hint ?? 'Nobody has a fix for this yet.'} Work out why (observe, figure_out, recall, check chests), fix it, try again, then record_fix what worked so everyone knows.`, { wake: true });
    }
    return hint;
  }

  /**
   * An action worked: if it had been failing, what fixed it is a solution worth keeping. Either the fix that
   * was just run, or what this villager did in between (the AI working it out).
   */
  problemSolved(name) {
    const problems = this.problems;
    if (!problems?.size) return;
    const store = this.agent.store;
    for (const [key, p] of problems) {
      if (p.name !== name) continue;
      problems.delete(key);
      const remedy = this.remedyRunning?.key === key ? this.remedyRunning : null;
      if (remedy) {
        const steps = remedy.steps.slice(0, -1).map(({ name: n, input }) => ({ name: n, input }));
        store.recordSolution(key, this.name, true, remedy.known ? null : { how: remedy.how, steps });
        if (!remedy.known) log(this.name, `🔧 solved: ${truncate(p.error, 80)} by ${truncate(remedy.how, 100)}`);
        continue;
      }
      const IGNORE = new Set(['observe', 'chat', 'whisper', 'find_block', 'equip', 'eat', 'go_to', 'go_to_player', 'follow', 'stop', name]);
      const between = this.agent.actionLog.filter((x) => x.t > p.t && x.ok && !IGNORE.has(x.name)).slice(-4);
      const steps = usableSteps(between.map((x) => ({ name: x.name, input: x.args })));
      if (!steps.length) continue;
      const how = steps.map((s) => `${s.name} ${JSON.stringify(s.input)}`).join(', then ');
      store.recordSolution(key, this.name, true, { how: `${how}, then ${name} again`, steps });
      log(this.name, `🔧 figured out: ${truncate(p.error, 80)} → ${truncate(how, 120)}`);
      publish('lesson', this.name, { text: `Fix for "${truncate(p.error, 80)}": ${truncate(how, 120)}` });
    }
  }

  /** Problems this villager is working out, with any known fixes, for the briefing. */
  problemsBriefing() {
    const open = [...(this.problems?.values() ?? [])].filter((p) => p.escalated);
    return open.map((p) => {
      const known = this.agent.store.solutionFor(p.key);
      return `- ${p.name} failed ${p.count}x: "${truncate(p.error, 160)}"${known ? ` — known fix: ${known.how}` : ''}`;
    }).join('\n');
  }

  /** The owner is waiting on this turn: a directive, or them talking to us. Goes ahead in the AI queue. */
  urgent() {
    return !!this.directive || this.agent.events.some((e) => e.owner);
  }

  async think() {
    const urgent = this.urgent();
    // Standing still for minutes in the AI queue helps nobody: work on autopilot and try again shortly
    // (before the briefing, so whatever needed thought - someone talking, a request - is still waiting).
    // The owner's business waits its (much shorter) turn instead.
    if (!urgent && this.limiter.waitMs() > 90_000) {
      this.aiDownUntil = Date.now() + 30_000;
      return 1_000;
    }
    const messages = [{ role: 'user', content: this.briefing() }];
    let waitMs = null;
    publish('perceive', this.name, this.perception);

    for (let step = 0; step < this.cfg.maxStepsPerTick; step++) {
      if (this.abortTick || this.mode === 'manual') break;
      if (step > 0 && this.limiter.waitMs(urgent) > 90_000) break;
      let response;
      await this.limiter.acquire(urgent);
      const callStarted = Date.now();
      try {
        response = await this.client.messages.create({
          model: this.cfg.model,
          max_tokens: 1024,
          system: this.system,
          tools: TOOLS,
          messages,
        }, { urgent });
        this.aiCalls++;
        this.limiter.record(response.usage);
        response._ms = Date.now() - callStarted;
      } catch (err) {
        log(this.name, `model call failed: ${err.status ?? ''} ${err.message}`);
        // Out of credits / rate-limited: keep living on learned habits for a while instead of standing still.
        // (A 429 is usually a brief rate limit: 30s. Out of credits / payment problems: 5 minutes.)
        if ([402, 403, 429].includes(err.status) || /quota|credit|payment|limit/i.test(err.message)) {
          const secs = err.status === 429 ? 30 : 300;
          this.aiDownUntil = Date.now() + secs * 1000;
          log(this.name, `AI unavailable: running on learned habits for ${secs}s`);
          return secs * 1000;
        }
        return err.status === 429 ? 60_000 : 30_000;
      } finally {
        this.limiter.release();
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolUses = response.content.filter((c) => c.type === 'tool_use');
      const text = response.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
      publish('step', this.name, {
        step: step + 1,
        text: truncate(text, 300),
        tools: toolUses.map((t) => ({ name: t.name, input: t.input })),
        tokens_in: response.usage?.input_tokens ?? 0,
        tokens_cached: response.usage?.cache_read_input_tokens ?? 0,
        tokens_out: response.usage?.output_tokens ?? 0,
        ms: response._ms,
      });
      if (!toolUses.length) {
        if (text) {
          this.lastPlan = truncate(text, 400);
          log(this.name, `💭 ${truncate(text, 200)}`);
          publish('thought', this.name, { text: this.lastPlan });
        }
        break;
      }

      const results = [];
      for (const tu of toolUses) {
        if (this.abortTick) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Skipped: interrupted by the owner.', is_error: true });
          continue;
        }
        const r = await this.execTool(tu.name, tu.input ?? {});
        if (!ACTION_NAMES.has(tu.name)) publish('result', this.name, { tool: tu.name, ok: !r.isError, summary: truncate(r.content, 160) });
        if (r.wait) waitMs = r.wait;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: truncate(r.content, 2500), is_error: !!r.isError });
      }
      messages.push({ role: 'user', content: results });
      if (waitMs) break;
      // Another step would mean queueing behind the rest of the village: get back to work on what was decided.
      if (this.limiter.waitMs(urgent) > 30_000) {
        this.lastPlan ??= '(AI busy — carry on with your plan)';
        break;
      }
      if (step === this.cfg.maxStepsPerTick - 1) this.lastPlan = '(ran out of steps last turn — continue where you left off)';
    }
    return waitMs;
  }

  async execTool(name, input) {
    const a = this.agent;
    if (ACTION_NAMES.has(name)) {
      const r = await a.runAction(name, input, 'brain');
      const hint = this.learnFrom(name, r, input);
      // Did that break a law the village can see?
      if (society.activeLaws(a.store).length) {
        const crimes = await a.store.call('society.crimesIn', this.name, name, input, r.ok, { names: [...a.allAgentNames], centre: a.store.village.center, houses: a.store.village.houses });
        for (const c of crimes) await this.punish(c);
      }
      if (this.turnActions) this.learnStep(name, input, r.ok); // only while the AI is choosing, not when replaying
      return r.ok ? { content: r.result } : { content: hint ? `${r.error}\n${hint}` : r.error, isError: true };
    }
    switch (name) {
      case 'remember': {
        this.memory.notes.push(String(input.note).slice(0, 200));
        // The 40 newest stay in mind; older ones go to the long-term archive (recall finds them).
        if (this.memory.notes.length > 40) a.store.archive(`notes-${this.name}`, { t: new Date().toISOString(), text: this.memory.notes.shift() });
        a.saveMemory();
        publish('memory', this.name, { text: this.memory.notes.at(-1), count: this.memory.notes.length });
        return { content: 'Saved.' };
      }
      case 'forget_note': {
        const i = Number(input.index);
        if (!(i >= 0 && i < this.memory.notes.length)) return { content: 'No such note.', isError: true };
        a.store.archive(`notes-${this.name}`, { t: new Date().toISOString(), text: `(set aside as outdated) ${this.memory.notes.splice(i, 1)[0]}` });
        a.saveMemory();
        publish('forget', this.name, { count: this.memory.notes.length });
        return { content: 'Deleted.' };
      }
      case 'set_goal':
        this.memory.goal = String(input.goal).slice(0, 300);
        a.saveMemory();
        log(this.name, `🎯 goal: ${this.memory.goal}`);
        publish('goal', this.name, { text: this.memory.goal });
        return { content: 'Goal set.' };
      case 'share_discovery': {
        const pos = { x: Math.floor(Number(input.x)), y: Math.floor(Number(input.y)), z: Math.floor(Number(input.z)) };
        if (![pos.x, pos.y, pos.z].every(Number.isFinite)) return { content: 'Give x, y and z coordinates.', isError: true };
        a.store.addKnowledge(this.name, input.what, pos);
        log(this.name, `🗺️ shared: ${truncate(input.what, 80)} at ${pos.x},${pos.y},${pos.z}`);
        publish('knowledge', this.name, { name: input.what, pos });
        return { content: 'Shared with the village.' };
      }
      case 'set_village_plan': {
        const lead = this.actingCoordinator();
        if (lead !== this.name) return { content: `Only ${lead} (the coordinator) sets the village plan. Suggest changes to them in chat, or post_task what you think is needed.`, isError: true };
        const steps = (Array.isArray(input.steps) ? input.steps : String(input.steps ?? '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
        if (!steps.length) return { content: 'Give at least one step.', isError: true };
        a.store.setPlan(this.name, steps);
        log(this.name, `🗺️ village plan: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
        publish('plan', this.name, { steps });
        return { content: 'Village plan updated. Now break the current step into tasks with post_task.' };
      }
      case 'post_task': {
        const assignee = input.for ? String(input.for) : null;
        const { task, added } = await a.store.call('addTask', this.name, input.task, assignee);
        if (added) {
          log(this.name, `📋 task #${task.id}: ${truncate(task.text, 120)}${assignee ? ` (for ${assignee})` : ''}`);
          publish('task', this.name, { id: task.id, text: task.text, assignee });
        }
        return { content: added ? `Posted as task #${task.id}.` : `That task already exists as #${task.id}.` };
      }
      case 'claim_task': {
        const r = await a.store.call('claimTask', Number(input.id), this.name);
        if (r.error) return { content: r.error, isError: true };
        log(this.name, `🙋 claimed task #${r.task.id}: ${truncate(r.task.text, 120)}`);
        publish('task-claimed', this.name, { id: r.task.id });
        return { content: `You are now working on #${r.task.id}: ${r.task.text}. Call finish_task when it is done.` };
      }
      case 'figure_out': {
        const mc = a.mcData;
        const item = String(input.item).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
        if (!mc?.itemsByName[item] && !['planks', 'log', 'wool'].includes(item)) return { content: `"${item}" isn't an item id.`, isError: true };
        const next = planNext(a.bot, mc, item, Math.max(1, Number(input.count) || 1), { goal: item, fromChest: chestLookup(a) });
        const how = explainItem(mc, item);
        return { content: `${how}\n${next ? `Your next step: ${next.name} ${JSON.stringify(next.input)} (${next.why}).` : 'You already have it.'}` };
      }
      case 'pay': {
        const to = this.teammates().find((t) => t.name.toLowerCase() === String(input.to).toLowerCase())?.name;
        if (!to) return { content: `No villager called ${input.to}.`, isError: true };
        const err = await a.store.call('society.pay', this.name, to, input.amount, input.why);
        if (err) return { content: err, isError: true };
        publish('pay', this.name, { to, amount: input.amount, why: input.why });
        return { content: `Paid ${input.amount} coins to ${to}.` };
      }
      case 'buy': {
        // A fair offer is accepted automatically if the seller has spare: they hand the items over, then the coins move.
        const seller = this.teammates().find((t) => t.name.toLowerCase() === String(input.from).toLowerCase());
        if (!seller?.connected) return { content: `${input.from} isn't around to trade.`, isError: true };
        const count = Math.max(1, Number(input.count) || 1);
        const price = Number(input.price);
        const stack = seller.bot.inventory.items().filter((i) => i.name === input.item || i.name.endsWith(`_${input.item}`));
        const has = stack.reduce((n, i) => n + i.count, 0);
        const fair = Math.ceil(society.priceOf(stack[0]?.name ?? input.item) * count * 0.8);
        if (has < count + 4) return { content: `${seller.name} doesn't have ${count} spare ${input.item} (has ${has}).`, isError: true };
        if (!(price >= fair)) return { content: `${seller.name} wants at least ${fair} coins for ${count} ${input.item}.`, isError: true };
        if (society.coins(a.store, this.name) < price) return { content: `You only have ${society.coins(a.store, this.name)} coins.`, isError: true };
        const g = await seller.runAction('give_item', { player: this.name, item: stack[0].name, count }, 'reflex');
        if (!g.ok) return { content: `The handover failed: ${g.error}`, isError: true };
        await a.store.call('society.pay', this.name, seller.name, price, `bought ${count} ${stack[0].name}`);
        log(this.name, `💰 bought ${count} ${stack[0].name} from ${seller.name} for ${price} coins`);
        publish('trade', this.name, { from: seller.name, item: stack[0].name, count, price });
        return { content: `Bought ${count} ${stack[0].name} from ${seller.name} for ${price} coins (pick up what they tossed if it's on the ground).` };
      }
      case 'propose_law': {
        const law = await a.store.call('society.proposeLaw', this.name, input);
        log(this.name, `⚖️ proposed law #${law.id}: ${law.text} (${law.rule}, fine ${law.fine})`);
        publish('law', this.name, { id: law.id, text: law.text, status: 'proposed' });
        this.agent.say(`I propose law #${law.id}: ${law.text}. Please vote!`);
        return { content: `Proposed as #${law.id}. It needs ${3} yes votes (and more yes than no) within 30 minutes. Your yes is counted.` };
      }
      case 'vote_law': {
        const r = await a.store.call('society.voteLaw', this.name, input.id, String(input.vote).toLowerCase().startsWith('y'));
        if (r.error) return { content: r.error, isError: true };
        return { content: `Voted ${input.vote} on #${r.law.id}. Status: ${r.law.status}.` };
      }
      case 'report_crime': {
        const r = await a.store.call('society.report', this.name, input.who, input.law_id, input.what);
        if (r.error) return { content: r.error, isError: true };
        if (r.convicted) {
          log(this.name, `🚨 ${input.who} convicted of breaking law #${r.law.id}: ${r.sentence}`);
          publish('crime', input.who, { law: r.law.id, what: input.what, sentence: r.sentence });
          return { content: `${input.who} has been convicted and ${r.sentence}.` };
        }
        return { content: 'Reported. One more report from another villager will convict them.' };
      }
      case 'finish_task': {
        const r = await a.store.call('finishTask', Number(input.id), this.name, input.note);
        if (r.error) return { content: r.error, isError: true };
        a.store.call('society.wage', this.name, 10, `task #${input.id}`).catch(() => {});
        log(this.name, `✔️ finished task #${r.task.id}: ${truncate(r.task.text, 120)}`);
        publish('task-done', this.name, { id: r.task.id, note: r.task.note });
        this.learnFromTask(r.task);
        return { content: `Task #${r.task.id} done. Pick your next task.` };
      }
      case 'record_fix': {
        const fix = String(input.fix ?? '').trim();
        if (fix.length < 8) return { content: 'Describe the fix: what you did that made it work.', isError: true };
        // The problem this is about: the open one that best matches, or the most recent one.
        const words = String(input.problem ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const open = [...(this.problems?.values() ?? [])];
        const score = (p) => words.filter((w) => p.error.toLowerCase().includes(w) || p.name.includes(w)).length;
        const p = open.sort((x, y) => score(y) - score(x) || y.t - x.t)[0];
        const key = p?.key ?? `note: ${String(input.problem ?? 'problem').toLowerCase().slice(0, 90)}`;
        a.store.recordSolution(key, this.name, true, { how: fix });
        if (p) this.problems.delete(p.key);
        log(this.name, `🔧 recorded a fix: ${truncate(fix, 140)}`);
        publish('lesson', this.name, { text: `Fix for "${truncate(p?.error ?? input.problem, 80)}": ${truncate(fix, 120)}` });
        return { content: 'Saved: everyone will use this fix next time.' };
      }
      case 'recall': {
        const hits = await a.store.call('recall', String(input.query ?? ''), this.name);
        return { content: hits.length ? hits.join('\n') : 'Nothing in your long-term memory about that.' };
      }
      case 'take_idea': {
        const idea = a.store.library.activities.find((x) => x.id === String(input.id).replace(/[[\]]/g, '').trim());
        if (!idea) return { content: 'No idea with that id. Use one listed under "Ideas from the village library".', isError: true };
        const task = await this.adoptIdea(idea);
        if (!task) return { content: 'Someone else is already doing that one. Pick another idea.', isError: true };
        return { content: `It's your task #${task.id} and your goal now: ${idea.text}. Plan the steps and get going; finish_task #${task.id} when done.` };
      }
      case 'add_idea': {
        const text = String(input.idea ?? '');
        if (/-?\d+\s*,\s*-?\d+/.test(text)) return { content: 'Describe the job without coordinates, so it can be reused anywhere.', isError: true };
        const added = a.store.addActivity(text, input.roles ?? [], `learned:${this.name}`);
        if (added) {
          log(this.name, `💡 new idea for the library: ${truncate(text, 120)}`);
          publish('idea', this.name, { text });
        }
        return { content: added ? 'Saved to the village library.' : 'The library already has that idea.' };
      }
      case 'post_to_board':
        if (a.store.isRepeatPost(this.name, input.message)) {
          return { content: 'You already posted almost the same thing recently. Only post when there is real news.', isError: true };
        }
        a.store.post(this.name, input.message);
        log(this.name, `📌 ${truncate(input.message, 160)}`);
        publish('board', this.name, { text: String(input.message).slice(0, 300) });
        return { content: 'Posted.' };
      case 'complete_directive':
        if (!this.directive) return { content: 'There is no active directive.' };
        log(this.name, `✅ directive done: ${truncate(input.summary, 160)}`);
        publish('directive-done', this.name, { summary: truncate(input.summary, 200), ok: true });
        a.pushEvent('directive', `You finished the directive "${truncate(this.directive.text, 80)}": ${input.summary}`);
        // What the owner asks for is worth remembering how to do, and doing again some day.
        this.learnFromJob(this.directive.text, input.summary);
        this.directive = null;
        return { content: 'Directive closed.' };
      case 'wait': {
        const s = Math.min(600, Math.max(10, Number(input.seconds) || 30));
        return { content: `Waiting ${s}s.`, wait: s * 1000 };
      }
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
  }

  status() {
    return {
      mode: this.mode,
      thinking: this.running,
      directive: this.directive?.text ?? null,
      last_plan: this.lastPlan,
      paused_for_manual_s: Math.max(0, Math.round((this.holdUntil - Date.now()) / 1000)),
      opportunities: this.opportunities(),
      notes: this.memory.notes,
    };
  }
}
