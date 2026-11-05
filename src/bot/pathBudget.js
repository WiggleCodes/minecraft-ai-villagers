// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
// Keeps path-finding cheap with dozens of villagers: one route-planning budget for every villager in this
// process, and cheaper walk/sprint/jump decisions while following a route.
//
// Out of the box each bot may think about paths for tickTimeout ms every physics tick, and gives up after
// thinkTimeout ms of *wall-clock* time. With a dozen bots in one process that's more thinking than a tick
// has room for: the process falls behind, every search runs out of wall-clock time ("Took to long to decide
// path to goal!"), gets retried, and the lag grows. Here all searches share BUDGET_MS of every WINDOW_MS,
// split fairly between the bots currently searching, and thinkTimeout counts real thinking time instead.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const AStar = require('mineflayer-pathfinder/lib/astar.js');
const Physics = require('mineflayer-pathfinder/lib/physics.js');

// While walking a path, every tick each bot decides walk/sprint/jump by simulating up to ~340 future ticks
// of physics (a 200-tick straight-line test plus seven 20-tick jump tests). That was the biggest CPU cost
// of all. The next path node is always a block or two away, so 40 ticks (2 s) is plenty, and a decision
// stays good for a few ticks.
const MAX_SIM_TICKS = 40;
const DECISION_MS = 150;
const simulate = Physics.prototype.simulateUntil;
Physics.prototype.simulateUntil = function simulateUntil(goal, controller, ticks = 1, state = null) {
  return simulate.call(this, goal, controller, Math.min(ticks, MAX_SIM_TICKS), state);
};
for (const name of ['canStraightLine', 'canSprintJump', 'canWalkJump']) {
  const decide = Physics.prototype[name];
  Physics.prototype[name] = function (path, flag) {
    const p = path[0];
    const key = `${name}|${flag}|${p.x},${p.y},${p.z}`;
    const memo = (this.memo ??= new Map());
    const hit = memo.get(key);
    const now = performance.now();
    if (hit && now - hit.t < DECISION_MS) return hit.v;
    const v = decide.call(this, path, flag);
    if (memo.size > 50) memo.clear();
    memo.set(key, { t: now, v });
    return v;
  };
}

const WINDOW_MS = 50; // one game tick
const BUDGET_MS = Number(process.env.PATH_BUDGET_MS ?? 20); // leaves the rest of the tick for physics, packets and brains
const WALL_LIMIT_MS = 30_000; // a search still waiting for its turn after this long gives up

let windowStart = 0;
let used = 0;
let searching = new Set(); // searches that asked for time this window
let lastSearching = 1; // ...and how many did in the previous one

AStar.prototype.compute = function compute() {
  const now = performance.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    used = 0;
    lastSearching = Math.max(1, searching.size);
    searching = new Set();
  }
  searching.add(this);
  if (this.window !== windowStart) {
    this.window = windowStart;
    this.windowUsed = 0;
  }
  this.spent ??= 0;
  const slice = Math.min(this.tickTimeout, BUDGET_MS / lastSearching - this.windowUsed, BUDGET_MS - used);
  if (slice <= 0) {
    return now - this.startTime > WALL_LIMIT_MS ? this.makeResult('timeout', this.bestNode) : this.makeResult('partial', this.bestNode);
  }

  const t0 = performance.now();
  try {
    while (!this.openHeap.isEmpty()) {
      const elapsed = performance.now() - t0;
      if (elapsed > slice) return this.makeResult('partial', this.bestNode);
      if (this.spent + elapsed > this.timeout) return this.makeResult('timeout', this.bestNode);
      const node = this.openHeap.pop();
      if (this.goal.isEnd(node.data)) return this.makeResult('success', node);
      this.openDataMap.delete(node.data.hash);
      this.closedDataSet.add(node.data.hash);
      this.visitedChunks.add(`${node.data.x >> 4},${node.data.z >> 4}`);

      for (const neighborData of this.movements.getNeighbors(node.data)) {
        if (this.closedDataSet.has(neighborData.hash)) continue;
        const g = node.g + neighborData.cost;
        const heuristic = this.goal.heuristic(neighborData);
        if (this.maxCost > 0 && g + heuristic > this.maxCost) continue;
        let neighborNode = this.openDataMap.get(neighborData.hash);
        let update = false;
        if (neighborNode === undefined) {
          neighborNode = new node.constructor();
          this.openDataMap.set(neighborData.hash, neighborNode);
        } else {
          if (neighborNode.g < g) continue;
          update = true;
        }
        neighborNode.set(neighborData, g, heuristic, node);
        if (neighborNode.h < this.bestNode.h) this.bestNode = neighborNode;
        if (update) this.openHeap.update(neighborNode);
        else this.openHeap.push(neighborNode);
      }
    }
    return this.makeResult('noPath', this.bestNode);
  } finally {
    const took = performance.now() - t0;
    used += took;
    this.spent += took;
    this.windowUsed += took;
  }
};
