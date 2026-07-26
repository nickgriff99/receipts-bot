import type { LLMProvider } from "../llm/types";
import type { PersonaConfig } from "../llm/types";
import type { MemoryStore } from "../memory/types";
import type { RateLimiter } from "./types";
import type { TurnCandidate, TurnDecision } from "./types";
import { isExplicitTrigger } from "./types";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:turn-taking");

/**
 * Turn-taking / trigger engine — brief section 3.
 *
 * Decision order for every candidate:
 *   1. Opted-out speakers never produce candidates at all (filtered
 *      upstream, before this engine ever sees a segment — see
 *      orchestrator.ts's segment intake).
 *   2. Explicit triggers (name said / @-mention / reply) skip the cheap
 *      gate entirely and bypass the min-gap cooldown, but still respect
 *      the hard per-minute cap.
 *   3. Ambient triggers (natural-pause detection upstream already decided
 *      "there's a lull") go through the haiku cheap-gate call first; if the
 *      gate says no, no full generation happens (this is the main cost
 *      lever, brief section 7). If yes, they're still fully subject to the
 *      rate limiter (cap AND min-gap).
 *
 * Pure decision logic — no network calls of its own except delegating to
 * the injected LLMProvider's cheapGateCheck, so it's implemented for real.
 */
export class TurnTakingEngine {
  constructor(
    private readonly llm: LLMProvider,
    private readonly rateLimiter: RateLimiter,
    /**
     * Only used to log cheap-gate token usage to `usage_log` (brief section
     * 7's "log tokens to Claude" — the cheap-gate call is a real Claude
     * call too, and was previously going unlogged). Not a persistence
     * dependency for turn-taking logic itself.
     */
    private readonly memory: MemoryStore,
  ) {}

  async decide(candidate: TurnCandidate, persona: PersonaConfig): Promise<TurnDecision> {
    const bypassCooldown = isExplicitTrigger(candidate.triggerType);

    if (!(await this.rateLimiter.canRespond(candidate.guildId, { bypassCooldown }))) {
      return {
        candidate,
        shouldRespond: false,
        reason: "rate limited (per-minute cap or min-gap cooldown)",
        bypassCooldown,
        cheapGateUsed: false,
        decidedAt: Date.now(),
      };
    }

    if (bypassCooldown) {
      // Explicit trigger — respond without the cheap gate.
      return {
        candidate,
        shouldRespond: true,
        reason: `explicit trigger (${candidate.triggerType})`,
        bypassCooldown,
        cheapGateUsed: false,
        decidedAt: Date.now(),
      };
    }

    // Ambient — go through the cheap gate first (primary cost lever).
    const gateResult = await this.llm.cheapGateCheck({
      guildId: candidate.guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript: candidate.segments,
    });

    log.debug("cheap-gate result", { guildId: candidate.guildId, shouldRespond: gateResult.shouldRespond, reason: gateResult.reason });

    await this.memory.logUsage({
      guildId: candidate.guildId,
      service: "llm",
      unitType: "tokens",
      units: gateResult.usage.inputTokens + gateResult.usage.outputTokens,
      occurredAt: Date.now(),
    });

    return {
      candidate,
      shouldRespond: gateResult.shouldRespond,
      reason: gateResult.reason,
      bypassCooldown: false,
      cheapGateUsed: true,
      decidedAt: Date.now(),
    };
  }
}
