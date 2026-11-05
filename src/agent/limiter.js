// Wiggly's Minecraft AI Villagers - (c) 2026 WiggleCodes (https://github.com/WiggleCodes). Licensed under PolyForm Noncommercial 1.0.0. See LICENSE.
/**
 * Shared across all villagers: caps concurrent model calls, calls per minute (spaced evenly, so a
 * rate-limited free API isn't hit with bursts it refuses) and calls per rolling hour.
 */
export class Limiter {
  constructor({ maxConcurrent, maxCallsPerHour, maxCallsPerMinute = 0 }) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxCallsPerHour = maxCallsPerHour;
    this.gapMs = maxCallsPerMinute > 0 ? 60_000 / maxCallsPerMinute : 0;
    this.nextStart = 0; // earliest time the next call may start
    this.active = 0;
    this.queue = [];
    this.calls = []; // timestamps
    // habit_turns: turns run from learned habits instead of the AI (each one is AI calls saved)
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, habit_turns: 0, autopilot_turns: 0 };
  }

  callsLastHour() {
    const cutoff = Date.now() - 3_600_000;
    while (this.calls.length && this.calls[0] < cutoff) this.calls.shift();
    return this.calls.length;
  }

  /** True if the hourly budget is used up (caller should back off). */
  overBudget() {
    return this.maxCallsPerHour > 0 && this.callsLastHour() >= this.maxCallsPerHour;
  }

  /** Roughly how long a new caller would wait for an AI slot right now (urgent callers skip the routine ones). */
  waitMs(urgent = false) {
    const ahead = urgent ? this.queue.filter((q) => q.urgent).length : this.queue.length;
    if (!this.gapMs) return this.active >= this.maxConcurrent ? ahead * 5_000 : 0;
    return Math.max(0, this.nextStart - Date.now()) + ahead * this.gapMs;
  }

  /** Wait for an AI slot. Urgent callers (the owner's instructions) go ahead of everyone else's routine turns. */
  async acquire(urgent = false) {
    if (this.active < this.maxConcurrent) {
      this.active++;
    } else {
      await new Promise((resolve) => {
        const entry = { resolve, urgent };
        if (urgent) {
          const i = this.queue.findIndex((q) => !q.urgent);
          this.queue.splice(i < 0 ? this.queue.length : i, 0, entry);
        } else this.queue.push(entry);
      });
      this.active++;
    }
    // Space calls evenly: claim the next start slot, then wait for it.
    if (this.gapMs) {
      const start = Math.max(Date.now(), this.nextStart);
      this.nextStart = start + this.gapMs;
      if (start > Date.now()) await new Promise((r) => setTimeout(r, start - Date.now()));
    }
  }

  release() {
    this.active--;
    this.queue.shift()?.resolve();
  }

  record(usage) {
    this.calls.push(Date.now());
    this.usage.calls++;
    for (const k of Object.keys(this.usage)) if (k !== 'calls' && usage?.[k]) this.usage[k] += usage[k];
  }
}
