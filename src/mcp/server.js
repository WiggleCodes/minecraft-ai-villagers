#!/usr/bin/env node
// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
/**
 * MCP server (stdio) for the AI village.
 * It is a thin bridge to the running village (`npm start`), so Claude Desktop / Claude Code
 * can watch the villagers, give them jobs, switch modes, or drive one directly.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_DEFS } from '../bot/actionDefs.js';

const BASE = process.env.VILLAGE_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3005}`;
const TOKEN = process.env.API_TOKEN || null;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`The village isn't running (can't reach ${BASE}). Start it with "npm start" in the project folder.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const botProp = { bot: { type: 'string', description: 'Villager name (see list_bots)' } };

const MANAGEMENT_TOOLS = [
  {
    name: 'list_bots',
    description: 'List all AI villagers with their role, mode, position, health, hunger, current activity and goal.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_bot',
    description: 'Detailed view of one villager: full observation of its surroundings, inventory, brain status, memory notes and recent actions.',
    inputSchema: { type: 'object', properties: botProp, required: ['bot'] },
  },
  {
    name: 'tell_bot',
    description:
      'Give a villager a job in plain English (e.g. "build a wheat farm next to the village chest"). Its AI brain plans and carries it out. Works in autonomous and directed mode.',
    inputSchema: {
      type: 'object',
      properties: { ...botProp, instruction: { type: 'string' } },
      required: ['bot', 'instruction'],
    },
  },
  {
    name: 'tell_all',
    description: 'Give every non-manual villager the same instruction (e.g. "meet at the village centre").',
    inputSchema: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] },
  },
  {
    name: 'set_mode',
    description:
      'Switch a villager (or "all") between: autonomous (lives on its own), directed (only does jobs you give it), manual (brain off — you drive it with the mc_* tools).',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Villager name or "all"' },
        mode: { type: 'string', enum: ['autonomous', 'directed', 'manual'] },
      },
      required: ['bot', 'mode'],
    },
  },
  {
    name: 'get_bot_log',
    description: "A villager's recent action history (who triggered each action, result, duration).",
    inputSchema: { type: 'object', properties: botProp, required: ['bot'] },
  },
  {
    name: 'read_board',
    description: 'Read the village notice board the villagers use to coordinate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'post_board',
    description: 'Pin a message to the village notice board (all villagers read it each turn).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'get_usage',
    description: 'Model API usage so far (calls, tokens, calls in the last hour vs the hourly cap).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Every bot action is exposed directly as mc_<action>, taking an extra "bot" argument.
// Calling one takes over that bot immediately (its brain pauses for a couple of minutes).
const ACTION_TOOLS = ACTION_DEFS.map((a) => ({
  name: `mc_${a.name}`,
  description: `[Direct control] ${a.description}`,
  inputSchema: {
    type: 'object',
    properties: { ...botProp, ...a.input_schema.properties },
    required: ['bot', ...(a.input_schema.required ?? [])],
  },
}));

const server = new Server(
  { name: 'wigglys-minecraft-ai-villagers', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Controls a village of AI players in a Minecraft Java server. Start with list_bots. Prefer tell_bot for goals ("gather 20 oak logs and bring them to me"); use mc_* tools for precise direct control. mc_* calls pause that bot\'s own brain for a short while.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...MANAGEMENT_TOOLS, ...ACTION_TOOLS] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const bot = args.bot ? encodeURIComponent(args.bot) : null;
  try {
    let data;
    switch (name) {
      case 'list_bots': data = await api('GET', '/bots'); break;
      case 'get_bot': data = await api('GET', `/bots/${bot}`); break;
      case 'get_bot_log': data = await api('GET', `/bots/${bot}/log`); break;
      case 'tell_bot': data = await api('POST', `/bots/${bot}/directive`, { text: args.instruction }); break;
      case 'tell_all': data = await api('POST', '/broadcast', { text: args.instruction }); break;
      case 'set_mode': data = await api('POST', `/bots/${bot}/mode`, { mode: args.mode }); break;
      case 'read_board': data = await api('GET', '/board'); break;
      case 'post_board': data = await api('POST', '/board', { text: args.text, author: 'Owner' }); break;
      case 'get_usage': data = await api('GET', '/usage'); break;
      default: {
        if (!name.startsWith('mc_')) throw new Error(`Unknown tool ${name}`);
        const { bot: _ignored, ...actionArgs } = args;
        data = await api('POST', `/bots/${bot}/action`, { action: name.slice(3), args: actionArgs });
        if (data.ok === false) return { content: [{ type: 'text', text: data.error }], isError: true };
        data = data.result;
      }
    }
    if (data?.ok === false) return { content: [{ type: 'text', text: data.error }], isError: true };
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
