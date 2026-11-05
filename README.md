# Wiggly's Minecraft AI Villagers

**Created by [WiggleCodes](https://github.com/WiggleCodes).** © 2026 WiggleCodes. Free for non-commercial use (see [Licence](#licence)).

AI villagers that join your Minecraft (Java Edition) world as real players and live there: chopping trees, mining, farming, building, hunting and chatting. They learn from their mistakes, share what they discover, plan together under a coordinator, and go back for their things when they die.

You can leave them to it, give them jobs in chat, watch their minds in a live **brain dashboard**, or take direct control from Claude Desktop or Claude Code through an **MCP server**.

```
 Minecraft world (LAN world or offline-mode server)
        ▲  one player connection per villager (mineflayer)
        │
 ┌──────┴───────────────────── npm start ───────────────────────┐
 │  Village runner                                              │
 │   • Body ×N    pathfinding, mining, crafting, fighting,      │
 │                reflexes (eat, defend, flee, respawn)         │
 │   • Brain ×N   an AI model decides what to do each turn      │
 │   • Store      notes, goals, plan, tasks, lessons,           │
 │                discoveries, notice board (data/state.json)   │
 │   • Control API + brain dashboard   http://127.0.0.1:3005    │
 └──────▲───────────────────────────────────────────────────────┘
        │ HTTP
 MCP server (stdio)  ◄── Claude Desktop / Claude Code
```

## What makes them clever

**They run themselves, and use the AI only for new things.**
- **Autopilot:** built-in know-how for every role (lumberjacks chop and make planks, miners quarry and mine visible ore, builders build houses on plots round the village square, masons build the town wall, hunters hunt, blacksmiths smelt and forge, guards patrol and defend, shepherds make beds...), plus basics for everyone: tools, a weapon, food, storing a full inventory.
- **Skills memory** (`data/skills.json`): how every step works out, shared by everyone in the same role. A step that fails three times in a row rests for 15–30 minutes, so the village trains itself and stops repeating mistakes.
- **The AI is asked only when it's needed:** a job from you, someone talking to them, a request, a death, the village moving, being stuck with nothing sensible to do, and a goal review every `AI_REVIEW_MINUTES` (20 by default). Everything the AI does that works is learned as a shared habit, so the next villager in that role can do it without asking.

**They learn as a village.**
- **Lessons from mistakes.** When something fails for a clear reason (no pickaxe for stone, a missing ingredient, no bed nearby), it becomes a lesson that *every* villager sees, so nobody repeats it.
- **Shared discoveries.** Trees, ores, water, chests and other useful places found by anyone go on one shared map, shown to each villager nearest-first.
- **Lessons from death.** What killed a villager (mobs, lava, drowning, falling…) becomes a survival lesson for the whole village.
- **Personal memory.** Each villager keeps its own notes, goal and home, and sees its last 12 actions so it notices when it's going round in circles.
- **Habits that save AI credits.** Every successful action the AI chooses is remembered in `data/habits.json` as "in this role, after doing X, I do Y". Once a step has worked twice, villagers replay their habits (up to 4 steps at a time) **without calling the AI**. The AI still gets every fourth turn (`HABIT_REPEATS`), plus anything new: chat, danger, low health, jobs, or a habit that fails. If the AI service refuses (out of credits), villagers keep working on their habits instead of standing still.

**They plan and work as a team.**
- **A coordinator** (Aragorn by default) keeps a short **village plan** up to date and breaks it into **tasks**, assigning each to the best-suited villager.
- Villagers **claim** a task before starting it so nobody duplicates work, and **finish** it when done. An abandoned claim reopens after 20 minutes.
- Each villager sees a **team roster**: what everyone is doing, where they are and what they're carrying. They also see what's already in the **shared chests**, so they gather what's missing instead of over-producing.
- They can hand items over, post requests, and wake each other up by name.

**They build properly.** Villagers decide *what* and *where*; blueprint builders place every block.
- `build_house`: walls with a doorway and a flat roof (a 5x5 house is about 70 blocks). It digs out the inside if the house is cut into a slope, and hangs a door if the villager has one.
- `build_wall`: a protective ring wall with a 3-wide gate, around the village centre or between two corners, following the ground.
- `build_farm` and `harvest_crops`: till the banks of a pond or river, plant seeds, and later harvest and replant.
- `build_schematic`: build a ready-made design from the [schematics](schematics/) folder (`list_schematics` shows them). In *shape* mode the structure is built from blocks the villagers can get (stairs and slabs become full blocks; windows, furniture and lights are left out), and a dry run reports the materials needed first. Included: `smallhouse1`, a 21 x 20 manor from [PrismarineJS mineflayer-builder](https://github.com/PrismarineJS/mineflayer-builder) (MIT licence). Add your own `.schem` downloads to the folder; they're kept out of your GitHub upload.
- Builds can be run again with the same settings to carry on where they stopped, which is handy for big walls or when the blocks run out. While building, villagers never dig through or pillar up on their own work.

**They use tools, armour and resources sensibly.**
- **Smart crafting:** ask for the thing you actually want (an iron pickaxe, a chest, a door). In-between items are made automatically (planks from logs, sticks from planks, a crafting table, crafted and placed), using whichever wood they're carrying.
- **Armour reflex:** they always wear the best armour they carry, and a shield in the off hand.
- They follow the real Minecraft progression, from wooden tools up to iron tools and armour.

**They look after their things.** When a villager dies it remembers where, what it dropped and what killed it. A reflex sends it straight back to pick everything up before the items vanish (5 minutes in Minecraft), unless lava or a fall killed it there.

**They use their surroundings.** Every turn, code works out an **Opportunities** list from what the villager can see and carry, so even a modest AI model makes good use of it. For example: a bed to sleep in, ripe crops to harvest, ore it can mine with its pickaxe, upgrades it can afford (stone or iron pickaxe, iron armour, shield), raw food to cook, animals to hunt, wool for a bed, or a full inventory to empty into a chest.

**Reflexes run without the AI.** With no AI calls, they eat when hungry, fight back when hit, flee when health is low, put on better armour, **sleep at night** when a bed is within 32 blocks (setting their respawn point, and a sleeping villager uses no AI), put a carried bed down at the village, pick up items lying nearby, go back for what they dropped when they died, respawn, and reconnect if kicked.

## The villagers

The fellowship, each with a role, a personality and long-term ambitions:

| Name | Role | | Name | Role |
|---|---|---|---|---|
| Treebeard | lumberjack | | Rosie | cook and gatherer |
| Gimli | miner | | Merry | quartermaster |
| Samwise | farmer | | Thorin | mason (builds the town wall) |
| Aragorn | builder and **coordinator** | | Smeagol | fisher |
| Bilbo | explorer and cartographer | | Radagast | shepherd |
| Legolas | hunter | | Galadriel | landscaper |
| Celebrimbor | blacksmith and crafter | | Pippin | courier |
| Boromir | guard | | | |

Edit [config/bots.json](config/bots.json) to rename them, change their personalities and goals, add or remove villagers, or pick a different `"coordinator"`. Names must be 3–16 letters, digits or `_`. `MAX_BOTS` in `.env` limits how many join (the first N in the list).

## Watch their minds (brain dashboard)

While the village is running, open **http://localhost:3005** in a browser.

Each villager's mind is drawn as a glowing network that grows with experience. A **core** pulses while it thinks, **skill neurons** grow with the things it does, **memories** appear as small stars, **friends** as pink neurons, and its **goal** as a gold neuron above the core. Brains grow and level up over time, and that growth is saved across restarts.

- **Constellation view** shows every mind in a ring. **Grid view** (press `G`) adds health and food bars and each villager's activity.
- **Sleep mode** (press `S`) goes full-screen and dims everything. Press `S` or `Esc` to wake it, or open `http://localhost:3005/?sleep`.
- **On a phone or tablet:** set `API_HOST=0.0.0.0` and an `API_TOKEN` in `.env`, then open `http://<your-pc's-ip>:3005/?token=<your token>`. On Windows you may need to allow port 3005 through the firewall.
- Add `?demo` to the address to preview the dashboard with pretend villagers.

### Inside one villager's head

Click any villager (its name or its glowing brain) to open its **full brain**: an interactive 3D brain you can drag to turn, scroll to zoom and click into. Use the menu at the top or the ← → keys to switch villagers.

- **Real anatomy, mapped to what the villager does.** The prefrontal cortex lights up while the AI is reasoning. The occipital lobe takes in what it sees, the hippocampus stores and recalls memories, Broca's area speaks, Wernicke's area understands your @jobs, the amygdala reacts to danger, the cerebellum runs skilled work like mining and building, and the brainstem handles automatic reflexes like eating.
- **Signals travel between regions in the order the villager actually processes things.** Senses go to memory, then to reasoning, then to the motor cortex, then to the cerebellum. Results flow back to the planner, green for success and red for failure.
- **How it's thinking** (left panel) is a live, step-by-step trace of every thought: what it sensed, what it heard, what it recalled, each reasoning step with the action it chose (and how many tokens it used), what happened, and its conclusion.
- **Brain regions** (right panel) shows live activity meters. Choose a region (or click it in 3D) to fly the camera to it, dim everything else, and see what it has been doing.
- **The brain fills in as the villager gains experience.** A new villager starts with a sparse little brain; regions it uses a lot glow brighter even at rest.

Add `?demo` to preview it without Minecraft, e.g. `http://localhost:3005/brain?bot=Gimli&demo`. three.js is served from the project itself, so the 3D view works without internet.

## Setup

**You need:** Node.js 20 or newer, Minecraft Java Edition, and an AI key (see step 2).

1. **Install**
   ```bash
   npm install
   cp .env.example .env       # Windows: copy .env.example .env
   ```
   Put your Minecraft username in `OWNERS=` so only you can give orders.

2. **Choose the villagers' brain** (in `.env`):
   - **Free option, NVIDIA:** get a free key at [build.nvidia.com](https://build.nvidia.com) and put it in `OPENAI_API_KEY`. `.env.example` is already set up for NVIDIA (`OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`, `MODEL=minimaxai/minimax-m3.1-flash`, `MAX_LLM_CALLS_PER_MINUTE=4`). The free tier is rate-limited (about 4 villager decisions a minute), so learned habits do much of the work. For any other OpenAI-compatible service (OpenRouter, Groq...), change `OPENAI_BASE_URL` and `MODEL` to match.
   - **More capacity:** list several keys in `OPENAI_API_KEY` (comma separated) and/or add other services as `EXTRA_AI_1=baseURL|apiKey|model`, `EXTRA_AI_2=...`. The villagers take turns across all of them, a rate-limited one sits out for 30 seconds, and the per-minute limit scales with the pool. Keys from the same account usually share one limit; mixing providers gives genuinely separate allowances.
   - **No key at all:** villagers run in manual mode and only move when you control them through the MCP tools.

3. **Open a world for them.** Either:
   - **A singleplayer world:** press Esc, then *Open to LAN*. Put the port it shows in `MC_PORT=` (it changes each time you open the world). A LAN world holds 8 players, so that's you plus 7 villagers.
   - **A server:** `docker compose up -d` starts a ready-made Paper server, or use your own with `online-mode=false`, `spawn-protection=0` and enough `max-players`.

   > The villagers need offline mode because they don't have Microsoft accounts. Keep the server on your own network; don't port-forward it. You can still join with your normal launcher.

4. **Start the village**
   ```bash
   npm start            # villagers with brains
   npm run manual       # brains off: MCP control only
   ```
   Villagers join a few seconds apart. Their thoughts, lessons, plans and tasks are logged in the console, a colour per villager.

5. **Connect Claude (optional).**
   - **Claude Desktop:** add this to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and restart Claude Desktop:
     ```json
     {
       "mcpServers": {
         "wigglys-ai-villagers": {
           "command": "node",
           "args": ["C:\\path\\to\\this\\folder\\src\\mcp\\server.js"]
         }
       }
     }
     ```
   - **Claude Code:**
     ```bash
     claude mcp add wigglys-ai-villagers -- node /path/to/this/folder/src/mcp/server.js
     ```
   If you set `API_TOKEN` in `.env`, add `"env": { "API_TOKEN": "same-value" }` to the MCP config as well.

## Talking to them in game

- `@Samwise plant a wheat farm next to the village chest`: a **job**, done now as top priority. Only players in `OWNERS` can give jobs (anyone, if it's empty).
- `@Samwise plant more wheat when you can`: a **request**. It goes on Samwise's task list and he fits it in around his own work, staying fully autonomous. Words like *when you can*, *later*, *no rush*, *whenever*, *sometime* or *todo:* make it a request.
- `@all todo: build a bridge over the river`: an open request on the village task list, for whoever suits it best.
- `@all meet me at the village centre`: a job for everyone.
- `@all this is where you live now` (or *this is our village*, *the village centre is here*): moves the village centre to where you're standing, and the villagers settle there.
- `@Aragorn add a stone wall with a gate to the plan`: the coordinator updates the village plan and tasks.
- `@Gimli build a 7x7 cobblestone house next to the village centre`: the builders handle the rest.
- `@Boromir stop`: stops immediately.
- Whispering (`/msg Gimli ...`) from an owner also counts as a job.
- Saying a villager's name in normal chat gets their attention; they reply when it makes sense.

## Modes

| Mode | What the villager does |
|---|---|
| `autonomous` (default) | Lives on its own: thinks every `TICK_SECONDS`, and straight away when someone talks to it, it gets hurt, or it dies. |
| `directed` | Waits until you give it a job (in chat or with `tell_bot`), does it, then waits again. Uses no AI while waiting. |
| `manual` | Brain off. Only moves when you use the `mc_*` tools. |

Using an `mc_*` tool on a villager takes it over straight away and pauses its brain for `MANUAL_HOLD_SECONDS`. After that it carries on with its own life.

## MCP tools

| Tool | Use |
|---|---|
| `list_bots`, `get_bot`, `get_bot_log` | Who's where, doing what, carrying what |
| `tell_bot`, `tell_all` | Give jobs in plain English |
| `set_mode` | autonomous / directed / manual, per villager or `all` |
| `read_board`, `post_board` | The village notice board |
| `get_usage` | AI calls and tokens so far |
| `mc_observe`, `mc_go_to`, `mc_go_to_player`, `mc_follow`, `mc_stop`, `mc_explore`, `mc_find_block`, `mc_collect_block`, `mc_dig_block`, `mc_place_block`, `mc_build_shelter`, `mc_build_house`, `mc_build_wall`, `mc_build_schematic`, `mc_list_schematics`, `mc_build_farm`, `mc_harvest_crops`, `mc_craft`, `mc_smelt`, `mc_use_chest`, `mc_equip`, `mc_eat`, `mc_attack`, `mc_sleep`, `mc_give_item`, `mc_chat`, `mc_whisper`, `mc_recover_items`, `mc_set_home`, `mc_go_home` | Direct control of one villager |

Things to ask Claude: *"Who's online and what are they up to?"*, *"Get Gimli to mine 30 cobblestone and put it in the village chest"*, *"Put everyone in directed mode"*, *"Take control of Legolas and walk him to 120, 64, -40"*.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `MODEL` | `minimaxai/minimax-m3.1-flash` | The AI model the villagers think with |
| `TICK_SECONDS` | `45` | How often an idle villager thinks. Lower is livelier but uses more AI |
| `MAX_STEPS_PER_TICK` | `6` | How many actions in a row per thought |
| `MAX_CONCURRENT_LLM` | `3` | How many villagers can think at the same moment |
| `MAX_LLM_CALLS_PER_HOUR` | `600` | Hard cap on AI calls per hour across the village (`0` = no cap) |
| `AI_REVIEW_MINUTES` | `20` | How often each villager has the AI review its goals when nothing new is happening |
| `VIEW_DISTANCE` | `4` | Chunks loaded around each villager; small keeps memory low with many villagers |
| `HABIT_REPEATS` | `3` | Habit turns (no AI) allowed in a row before the AI thinks again. `0` = always use the AI |
| `MAX_BOTS` | all | Only start the first N villagers |
| `DEFAULT_MODE` | `autonomous` | Starting mode for every villager |
| `JOIN_DELAY_MS` | `5000` | Gap between villagers joining |
| `API_HOST` / `API_PORT` / `API_TOKEN` | `127.0.0.1` / `3005` / none | Where the dashboard and control API listen, and their password |

The runner logs AI usage every 10 minutes, and `get_usage` shows it on demand. Tool definitions and personas are prompt-cached to keep costs down.

## Adding new abilities

Every action lives in two places:

- [src/bot/actionDefs.js](src/bot/actionDefs.js): name, description and input schema (shared by the brain and the MCP server).
- [src/bot/actions.js](src/bot/actions.js): the code that does it.

Add both, and the action appears automatically as a brain tool and as an `mc_<name>` MCP tool.

## Files

```
config/bots.json        villagers, coordinator, owners, server address
src/runner.js           starts everything
src/bot/agentBot.js     connection, reflexes, chat, death memory
src/bot/actions.js      action handlers
src/bot/crafting.js     smart crafting (makes in-between ingredients)
src/bot/building.js     blueprint builders: houses, walls, schematics, farms, harvesting
schematics/             designs for build_schematic (see schematics/README.md for credits)
src/bot/util.js         helpers, including a fast block search
src/bot/observe.js      what a villager "sees"
src/agent/brain.js      the decision loop: briefing, planning, tasks, teamwork
src/agent/prompts.js    shared rules, personas, brain-only tools
src/agent/lessons.js    turns failures, deaths and finds into shared learning
src/agent/autopilot.js  built-in role know-how that runs without the AI
src/agent/limiter.js    caps on how much AI the village uses
src/store.js            saved state: memory, plan, tasks, lessons, discoveries
src/api.js              control API and dashboard stream
src/feed.js             live event stream and experience stats
src/web/index.html      the brain dashboard (all villagers)
src/web/brain.html      the full 3D brain for one villager
src/mcp/server.js       MCP server (stdio)
data/state.json         everything the village remembers (created when it runs)
```

## Troubleshooting

- **"Server full" and villagers keep leaving and rejoining**: an Open to LAN world only holds 8 players (you plus 7 villagers). Set `MAX_BOTS=7` or use a server with more `max-players`.
- **Villagers can't connect after you reopen your world**: Open to LAN picks a new port each time. Update `MC_PORT`.
- **"No data available for version …"**: the bot library supports Minecraft up to 1.21.11 and 26.1. Use one of those versions.
- **"You are not whitelisted" / "Failed to verify username"**: the server isn't in offline mode, or it has a whitelist.
- **Villagers can't break blocks near spawn**: set `spawn-protection=0`.
- **Villagers stop thinking**: your AI quota or `MAX_LLM_CALLS_PER_HOUR` may be used up. The console log says which.
- **MCP says the village isn't running**: run `npm start` first; the MCP server only connects to it.

## Licence

**Wiggly's Minecraft AI Villagers** was created by **[WiggleCodes](https://github.com/WiggleCodes)**. © 2026 WiggleCodes. WiggleCodes owns the copyright and is the original author.

It is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify and share it for non-commercial purposes, as long as every copy keeps the licence and the `Required Notice` line crediting WiggleCodes. Selling it or using it commercially is not allowed without written permission from WiggleCodes. See [LICENSE](LICENSE) for the full terms. Third-party libraries it uses keep their own licences, and the included `smallhouse1` design is © PrismarineJS under the MIT licence (see [schematics/LICENSE-mineflayer-builder.txt](schematics/LICENSE-mineflayer-builder.txt)).
