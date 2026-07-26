import type { RateLimiter, RateLimiterConfig } from "./types";

interface GuildRateState {
  /** Sliding 60s window for non-bypass (ambient/proactive) responses. */
  responseTimestamps: number[];
  /**
   * Sliding 60s window for bypassCooldown-class responses (explicit
   * triggers + active-thread continuations) — task 2 fix, conversation-
   * continuity round. Populated regardless of whether
   * `maxExplicitResponsesPerMinute` is actually configured for a guild, so
   * turning the separate budget on/off later needs no backfill.
   */
  explicitResponseTimestamps: number[];
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

    this.pruneWindow(state.responseTimestamps, now);
    this.pruneWindow(state.explicitResponseTimestamps, now);

    if (opts.bypassCooldown) {
      if (config.maxExplicitResponsesPerMinute !== undefined) {
        // Independent explicit-class budget (task 2 fix, conversation-
        // continuity round) — doesn't compete with ambient/proactive volume
        // at all, so a burst of chime-ins earlier in the same 60s window can
        // never silently swallow a legitimate direct-address/continuation
        // reply. See RateLimiterConfig.maxExplicitResponsesPerMinute's doc
        // comment (pipeline/types.ts) for the full investigation writeup.
        return state.explicitResponseTimestamps.length < config.maxExplicitResponsesPerMinute;
      }
      // Not configured for this guild — preserve the exact pre-existing
      // behavior: share ONE combined cap with everything else. bypassCooldown
      // already means "skip the min-gap check", nothing else to enforce here.
      return state.responseTimestamps.length + state.explicitResponseTimestamps.length < config.maxResponsesPerMinute;
    }

    const generalCount =
      config.maxExplicitResponsesPerMinute !== undefined
        ? state.responseTimestamps.length
        : state.responseTimestamps.length + state.explicitResponseTimestamps.length;
    if (generalCount >= config.maxResponsesPerMinute) return false;

    if (state.lastResponseAt !== null) {
      const gapMs = now - state.lastResponseAt;
      if (gapMs < config.minGapSeconds * 1000) return false;
    }

    return true;
  }

  recordResponse(guildId: string, opts: { bypassCooldown: boolean }): void {
    const state = this.stateFor(guildId);
    const now = Date.now();
    if (opts.bypassCooldown) state.explicitResponseTimestamps.push(now);
    else state.responseTimestamps.push(now);
    state.lastResponseAt = now;
    this.pruneWindow(state.responseTimestamps, now);
    this.pruneWindow(state.explicitResponseTimestamps, now);
  }

  private stateFor(guildId: string): GuildRateState {
    let state = this.guildStates.get(guildId);
    if (!state) {
      state = { responseTimestamps: [], explicitResponseTimestamps: [], lastResponseAt: null };
      this.guildStates.set(guildId, state);
    }
    return state;
  }

  private pruneWindow(timestamps: number[], now: number): void {
    const cutoff = now - 60_000;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }
}
