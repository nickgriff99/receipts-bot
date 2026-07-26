import type { RateLimiter, RateLimiterConfig } from "./types";

interface GuildRateState {
  responseTimestamps: number[]; // sliding 60s window, for the per-minute cap
  lastResponseAt: number | null;
}

/**
 * In-memory sliding-window rate limiter — the primary cost/spam safety
 * valve (brief section 3 + 7). Pure logic, no external deps, so
 * implemented for real rather than stubbed.
 *
 * One instance per process; state is per-guild. If the bot ever runs
 * multi-process, this needs to move to a shared store (Redis, or the
 * Postgres db) — flagged for Merry/ops if horizontal scaling comes up, out
 * of scope for the "medium scale, few guilds" v1 target.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly guildStates = new Map<string, GuildRateState>();

  constructor(private readonly configFor: (guildId: string) => Promise<RateLimiterConfig>) {}

  async canRespond(guildId: string, opts: { bypassCooldown: boolean }): Promise<boolean> {
    const config = await this.configFor(guildId);
    const state = this.stateFor(guildId);
    const now = Date.now();

    this.pruneWindow(state, now);
    if (state.responseTimestamps.length >= config.maxResponsesPerMinute) return false;

    if (!opts.bypassCooldown && state.lastResponseAt !== null) {
      const gapMs = now - state.lastResponseAt;
      if (gapMs < config.minGapSeconds * 1000) return false;
    }

    return true;
  }

  recordResponse(guildId: string): void {
    const state = this.stateFor(guildId);
    const now = Date.now();
    state.responseTimestamps.push(now);
    state.lastResponseAt = now;
    this.pruneWindow(state, now);
  }

  private stateFor(guildId: string): GuildRateState {
    let state = this.guildStates.get(guildId);
    if (!state) {
      state = { responseTimestamps: [], lastResponseAt: null };
      this.guildStates.set(guildId, state);
    }
    return state;
  }

  private pruneWindow(state: GuildRateState, now: number): void {
    const cutoff = now - 60_000;
    while (state.responseTimestamps.length > 0 && state.responseTimestamps[0] < cutoff) {
      state.responseTimestamps.shift();
    }
  }
}
