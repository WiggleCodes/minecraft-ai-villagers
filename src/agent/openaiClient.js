// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Lets the villagers think with any OpenAI-compatible service (NVIDIA build.nvidia.com, OpenRouter, Groq...).
// The brain talks the Anthropic Messages format; this translates requests to OpenAI chat completions and
// the answers back, so the brain works unchanged.

/** Anthropic-style request -> OpenAI chat-completions body. */
function toOpenAI({ model, max_tokens, system, tools, messages }) {
  const out = [];
  const sys = Array.isArray(system) ? system.map((b) => b.text).join('\n\n') : system;
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      // A user turn may hold tool results (one OpenAI "tool" message each) and/or plain text.
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: b.text });
        }
      }
    }
  }
  return {
    model,
    max_tokens,
    temperature: 0.6,
    messages: out,
    tools: tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    tool_choice: tools?.length ? 'auto' : undefined,
  };
}

/** OpenAI chat-completions response -> Anthropic-style response. */
function fromOpenAI(data) {
  const msg = data.choices?.[0]?.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input = {};
    try {
      input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      /* malformed arguments: run the tool with none, it will say what's missing */
    }
    content.push({ type: 'tool_use', id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function.name, input });
  }
  return {
    content,
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  };
}

/** A client with the same `messages.create()` shape as the Anthropic SDK. */
export function createOpenAIClient({ apiKey, baseURL, timeoutMs = 90_000 }) {
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  return {
    messages: {
      async create(params) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(toOpenAI(params)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const err = new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        return fromOpenAI(await res.json());
      },
    },
  };
}
