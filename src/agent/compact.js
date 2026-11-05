// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// A smaller version of a villager's AI request, for free services that only take a few thousand tokens a
// minute (e.g. Groq's free tier: 8,000). Same situation, said more briefly: the tools villagers use most with
// short descriptions, condensed rules, and the briefing without its least important sections.

/** Rough token count (about 3.6 characters per token for this kind of text). */
export const estimateTokens = (params) => Math.ceil(JSON.stringify(params).length / 3.6);

const CORE_TOOLS = new Set([
  'observe', 'chat', 'go_to', 'go_to_player', 'explore', 'find_block', 'collect_block', 'dig_block', 'place_block',
  'craft', 'smelt', 'use_chest', 'equip', 'eat', 'attack', 'sleep', 'give_item', 'build_house', 'build_farm',
  'harvest_crops', 'clean_up', 'figure_out', 'remember', 'recall', 'set_goal', 'post_task', 'claim_task',
  'finish_task', 'take_idea', 'complete_directive', 'wait',
]);

const COMPACT_RULES = `You are an AI villager in a Minecraft survival world, working with other AI villagers and human players.
- Act through tools. Several independent actions can go in one reply.
- Top priority: a DIRECTIVE from your owner (call complete_directive when done). Then your tasks, then your role's work.
- Gather what you need first; check shared chests before gathering. Read errors and adapt; don't repeat failing actions.
- Never attack players, cheat, or grief builds. Keep chat short and in character.
- End with one or two sentences: what you're doing next and why.`;

// Briefing sections to drop first when the request is too big (least important first).
const DROP_ORDER = [
  'Village notice board', 'Village knowledge', 'Village lessons', 'Society', 'Where you died recently',
  'Shared chests', 'Your team right now', "What you've done before", 'Your memory notes', 'Coordinator duties',
  'Village plan', 'Ideas from the village library', 'Your recent actions', 'Opportunities right now',
];

const firstSentence = (s) => {
  const t = String(s ?? '').split(/(?<=\.)\s/)[0];
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
};

function slimTool(t) {
  const props = Object.fromEntries(Object.entries(t.input_schema?.properties ?? {}).map(([k, v]) => {
    const { description, ...rest } = v;
    return [k, rest];
  }));
  return { name: t.name, description: firstSentence(t.description), input_schema: { ...t.input_schema, properties: props } };
}

function dropSection(text, title) {
  const parts = text.split(/\n\n(?=## )/);
  const kept = parts.filter((p) => !p.startsWith(`## ${title}`));
  return kept.length === parts.length ? null : kept.join('\n\n');
}

/** A version of `params` that fits in `budget` tokens, or null if it can't be made small enough. */
export function compactRequest(params, budget) {
  // Tools already used in this turn must stay available, or the conversation wouldn't make sense.
  const used = new Set(params.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_use').map((b) => b.name)));
  const tools = (params.tools ?? []).filter((t) => CORE_TOOLS.has(t.name) || used.has(t.name)).map(slimTool);
  const system = Array.isArray(params.system)
    ? params.system.map((b, i) => (i === 0 ? { type: 'text', text: COMPACT_RULES } : { type: 'text', text: b.text }))
    : COMPACT_RULES;
  // Tool results from earlier steps of this turn: the gist is enough.
  const messages = params.messages.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 600 ? { ...b, content: `${b.content.slice(0, 600)}…` } : b)) }
    : m));
  const out = { ...params, system, tools, messages };
  const first = messages[0];
  if (typeof first?.content === 'string') {
    let text = first.content;
    for (const title of DROP_ORDER) {
      if (estimateTokens({ ...out, messages: [{ ...first, content: text }, ...messages.slice(1)] }) <= budget) break;
      text = dropSection(text, title) ?? text;
    }
    out.messages = [{ ...first, content: text }, ...messages.slice(1)];
  }
  return estimateTokens(out) <= budget ? out : null;
}
