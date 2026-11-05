// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Free AI services the villagers can share. Put a key in .env (see .env.example) and that service joins the
// pool: every key is tested when the village starts, and each service is paced by its own free rate limit.
//
// Free tiers and model names change often, so a preset's model is only a first choice: if the service says
// it doesn't exist (or can't use tools), the service's own model list is searched for a suitable one.
import { createOpenAIClient } from './openaiClient.js';

/**
 * keyEnv: the .env variable(s) holding the key (comma-separate several keys for one service).
 * rpm: requests per minute to stay under the free limit (a little below the published one).
 * prefer: what to look for in the service's model list if the default model is gone.
 */
export const PRESETS = [
  {
    // Free tier: 30 requests but only 8,000 tokens a minute, so it gets compact requests, about 1-2 a minute.
    id: 'groq', label: 'Groq', keyEnv: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b', rpm: 2, tpm: 8000, prefer: [/gpt-oss-120b/, /qwen3/, /llama-4/, /llama.*70b/, /gpt-oss/],
    signup: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini', label: 'Google Gemini', keyEnv: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash', rpm: 8, prefer: [/gemini-[\d.]+-flash$/, /gemini-[\d.]+-flash/, /flash/, /gemini/],
    signup: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter', label: 'OpenRouter (free models)', keyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free', rpm: 10, prefer: [/gpt-oss-120b:free/, /qwen3.*:free/, /llama.*70b.*:free/, /:free$/],
    signup: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'mistral', label: 'Mistral', keyEnv: 'MISTRAL_API_KEY', baseURL: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest', rpm: 20, prefer: [/mistral-small-latest/, /mistral-medium-latest/, /small/],
    signup: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'cloudflare', label: 'Cloudflare Workers AI', keyEnv: 'CLOUDFLARE_API_TOKEN', needs: 'CLOUDFLARE_ACCOUNT_ID',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', rpm: 20, prefer: [/llama-3\.3-70b/, /gpt-oss-120b/, /qwen/],
    signup: 'https://dash.cloudflare.com/profile/api-tokens (Workers AI template; the account id is on the dashboard)',
  },
  {
    id: 'cerebras', label: 'Cerebras', keyEnv: 'CEREBRAS_API_KEY', baseURL: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b', rpm: 25, prefer: [/gpt-oss-120b/, /qwen-3/, /llama.*70b/, /llama/],
    signup: 'https://cloud.cerebras.ai',
  },
  {
    id: 'cohere', label: 'Cohere (trial)', keyEnv: 'COHERE_API_KEY', baseURL: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-03-2025', rpm: 2, prefer: [/command-a/, /command-r-plus/, /command/],
    signup: 'https://dashboard.cohere.com/api-keys',
  },
];

/**
 * Every AI service configured in .env: the main one (OPENAI_API_KEY, several keys allowed), each preset
 * with a key, and EXTRA_AI_n=baseURL|apiKey|model. Returns [{ name, baseURL, apiKey, model, rpm, prefer }].
 */
export function configuredServices(config, env = process.env) {
  const out = [];
  const keys = (v) => String(v ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const mainRpm = config.brain.maxCallsPerMinute || 4;
  keys(config.brain.apiKey).forEach((apiKey, i) => out.push({
    name: `${new URL(config.brain.baseURL).host} key ${i + 1}`, baseURL: config.brain.baseURL, apiKey, model: null, rpm: mainRpm, prefer: [],
  }));
  for (const p of PRESETS) {
    if (p.needs && !env[p.needs]) continue;
    const baseURL = p.baseURL.replace(/\{(\w+)\}/g, (_, k) => env[k] ?? '');
    const model = env[`${p.id.toUpperCase()}_MODEL`] || p.model;
    keys(env[p.keyEnv]).forEach((apiKey, i, all) => out.push({
      name: `${p.label}${all.length > 1 ? ` key ${i + 1}` : ''}`, baseURL, apiKey, model, rpm: p.rpm, tpm: p.tpm ?? 0, prefer: p.prefer,
    }));
  }
  for (const e of config.brain.extras) out.push({ name: `${e.name} (${new URL(e.baseURL).host})`, baseURL: e.baseURL, apiKey: e.apiKey, model: e.model, rpm: Number(env[`${e.name}_RPM`]) || mainRpm, prefer: [] });
  return out;
}

const PING = {
  max_tokens: 400, // reasoning models think before they answer

  system: 'You are a test.',
  tools: [{ name: 'ok', description: 'Call this to say you are working.', input_schema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: 'Call the ok tool.' }],
};

async function listModels(s) {
  try {
    const res = await fetch(`${s.baseURL.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${s.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? data.models ?? []).map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Test every service with a tiny tool-using request. Bad keys are dropped; a missing model is replaced by
 * the best match from the service's model list. Busy (429) services are kept: they just need a moment.
 */
export async function verifyServices(services, defaultModel, log) {
  const check = async (s) => {
    const client = createOpenAIClient({ apiKey: s.apiKey, baseURL: s.baseURL, timeoutMs: 30_000 });
    const tryModel = async (model) => {
      try {
        const r = await client.messages.create({ ...PING, model });
        return { ok: true, tools: r.content.some((c) => c.type === 'tool_use') };
      } catch (err) {
        return { ok: false, status: err.status, message: String(err.message).slice(0, 160) };
      }
    };
    let model = s.model ?? defaultModel;
    let r = await tryModel(model);
    if (!r.ok && [400, 404, 422].includes(r.status) && s.prefer.length) {
      const ids = await listModels(s);
      for (const re of s.prefer) {
        const pick = ids.find((id) => re.test(id) && id !== model);
        if (!pick) continue;
        const r2 = await tryModel(pick);
        if (r2.ok) {
          log(`AI: ${s.name}: "${model}" isn't available, using "${pick}" instead`);
          model = pick;
          r = r2;
          break;
        }
      }
    }
    if (r.ok) {
      if (!r.tools) log(`AI: ${s.name} (${model}) answered but didn't use the test tool; keeping it, but it may act less`);
      return { ...s, model };
    }
    if (r.status === 429) return { ...s, model }; // rate-limited right now: fine, it's a working key
    log(`AI: ${s.name} left out (${r.status ?? 'no answer'}: ${r.message})`);
    return null;
  };
  const results = await Promise.all(services.map(check));
  return results.filter(Boolean);
}
