// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function loadConfig() {
  const file = process.env.BOTS_CONFIG ?? path.join(ROOT, 'config', 'bots.json');
  const file_cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  const bots = (file_cfg.bots ?? []).filter((b) => b.enabled !== false);
  for (const b of bots) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(b.name)) {
      throw new Error(`Bot name "${b.name}" is invalid: Minecraft names are 3-16 letters, digits or _`);
    }
  }
  const max = num(process.env.MAX_BOTS, bots.length);

  return {
    server: {
      host: process.env.MC_HOST ?? file_cfg.server?.host ?? '127.0.0.1',
      port: num(process.env.MC_PORT, file_cfg.server?.port ?? 25565),
      version: process.env.MC_VERSION ?? file_cfg.server?.version ?? false, // false = auto-detect
      auth: 'offline',
    },
    bots: bots.slice(0, max),
    owners: process.env.OWNERS ? list(process.env.OWNERS) : file_cfg.owners ?? [],
    allowAttackingPlayers: file_cfg.allowAttackingPlayers ?? false,
    // The villager who keeps the village plan and task list current (first villager if unset or not running).
    coordinator: bots.slice(0, max).some((b) => b.name === file_cfg.coordinator) ? file_cfg.coordinator : bots[0]?.name,
    joinDelayMs: num(process.env.JOIN_DELAY_MS, 5_000),
    chatCooldownMs: num(process.env.CHAT_COOLDOWN_MS, 2_500),
    // Villager processes (one per CPU core you want to use). 1 = everything in one process.
    shards: num(process.env.SHARDS, 1),

    api: {
      host: process.env.API_HOST ?? '127.0.0.1',
      port: num(process.env.API_PORT, 3005),
      token: process.env.API_TOKEN || null,
    },

    brain: {
      enabled: !process.argv.includes('--manual'),
      // Any OpenAI-compatible service: NVIDIA, OpenRouter, Groq...
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      // More OpenAI-compatible services to share the load: EXTRA_AI_1=baseURL|apiKey|model, EXTRA_AI_2=...
      extras: Object.keys(process.env).filter((k) => /^EXTRA_AI_\d+$/.test(k)).sort()
        .map((k) => {
          const [baseURL, apiKey, model] = String(process.env[k]).split('|').map((s) => s.trim());
          return { name: k, baseURL, apiKey, model };
        })
        .filter((e) => e.baseURL && e.apiKey && e.model),
      model: process.env.MODEL ?? 'minimaxai/minimax-m3.1-flash',
      tickSeconds: num(process.env.TICK_SECONDS, 45),
      maxStepsPerTick: num(process.env.MAX_STEPS_PER_TICK, 6),
      maxConcurrent: num(process.env.MAX_CONCURRENT_LLM, 3),
      maxCallsPerHour: num(process.env.MAX_LLM_CALLS_PER_HOUR, 600),
      maxCallsPerMinute: num(process.env.MAX_LLM_CALLS_PER_MINUTE, 0), // 0 = no per-minute cap
      manualHoldSeconds: num(process.env.MANUAL_HOLD_SECONDS, 120),
      // Learned habits replace this many AI turns in a row before the AI gets a turn again (0 = never use habits).
      habitRepeats: num(process.env.HABIT_REPEATS, 3),
      // How often each villager has the AI review its goals when nothing new is happening (autopilot otherwise).
      aiReviewMinutes: num(process.env.AI_REVIEW_MINUTES, 20),
      defaultMode: process.env.DEFAULT_MODE ?? 'autonomous',
    },

    dataFile: process.env.DATA_FILE ?? path.join(ROOT, 'data', 'state.json'),
  };
}
