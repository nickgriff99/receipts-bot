import type { LLMProvider } from "../llm/types";
import type { PersonaConfig } from "../llm/types";
import type { MemoryStore } from "../memory/types";
import type { RateLimiter } from "./types";
import type { TurnCandidate, TurnDecision } from "./types";
import { isExplicitTrigger } from "./types";
import { BOT_SPEAKER_ID, FALLBACK_PROACTIVE_CHIME_INTERVAL_SECONDS } from "../config/constants";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:turn-taking");

/**
 * How far back to look for real (non-bot) transcript activity before
 * greenlighting a proactive chime-in attempt. Deliberately shorter than the
 * proactive interval itself (brief: "riff on whatever's being discussed") —
 * if the channel has been silent longer than this, there is nothing fresh
 * to react to and the bot should stay quiet rather than force a comment.
 * Implementation heuristic, not a stakeholder-tunable knob, so it stays a
 * local constant rather than a config field.
 */
const PROACTIVE_ACTIVITY_LOOKBACK_MS = 90_000;

/**
 * Adaptive-cadence learning layer (social-presence round, frodo — brief
 * section 5). Concrete, non-ML scope: read an aggregated recent
 * landed:flopped ratio (`MemoryStore.getRecentEngagementStats`, populated by
 * `PipelineOrchestrator` — see its `pendingEngagementByGuild` doc comment for
 * exactly how a turn resolves to one or the other) and use it to nudge how
 * eager the bot is to speak next, per guild:
 *
 * - Ambient candidates: if recent turns have mostly flopped, decline
 *   BEFORE spending a cheap-gate call at all (saves cost too) — "recent
 *   chime-ins mostly went unanswered, stay quieter for a while." No
 *   amplification lever exists for ambient (there's no interval floor to
 *   shrink) — deliberately one-directional here: damping down is safe,
 *   forcing MORE ambient turns based on a good streak risks regressing the
 *   "talks too much" complaint this whole feature line started from.
 * - Proactive candidates: the per-guild cadence floor
 *   (`proactiveIntervalSeconds`) is scaled up (talk less often) when
 *   recent turns mostly flopped, or scaled down toward (but never below) a
 *   hard floor when recent turns mostly landed — two-directional, since
 *   proactive already has an explicit interval to rescale rather than a
 *   binary gate to skip.
 *
 * Both are ratio-gated by `ENGAGEMENT_MIN_SAMPLES` — a new guild (or one
 * that just restarted, given the current in-process storage — see
 * postgresStore.ts) has zero samples and must be read as "no signal yet",
 * not as a 0% landed rate that would permanently silence the bot.
 */
const ENGAGEMENT_MIN_SAMPLES = 6;
const ENGAGEMENT_FLOP_RATIO_DAMPEN = 0.7;
const ENGAGEMENT_LANDED_RATIO_BOOST = 0.7;
const PROACTIVE_INTERVAL_DAMPEN_MULTIPLIER = 1.5;
const PROACTIVE_INTERVAL_BOOST_MULTIPLIER = 0.75;
/** Never let the engagement signal shrink the proactive cadence floor below this, regardless of how well recent turns have landed. */
const PROACTIVE_INTERVAL_BOOST_FLOOR_SECONDS = 60;

/**
 * Fallback proactive-chime cadence if the caller doesn't wire a real
 * `proactiveIntervalSeconds` — sourced from `config/constants.ts` (Sam,
 * config-lock round) so this fallback and the env-driven default
 * (`AppConfig.defaults.proactiveChimeIntervalSeconds`) can never drift apart.
 */
const DEFAULT_PROACTIVE_INTERVAL_SECONDS = FALLBACK_PROACTIVE_CHIME_INTERVAL_SECONDS;

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
 *   4. Proactive triggers (timer-driven, no new segment at all — see
 *      orchestrator.ts's `maybeFireProactiveTurn`) do NOT bypass the
 *      cooldown like explicit triggers, and do NOT get an unconditional
 *      yes — they go through their own lighter gate (`decideProactive`):
 *      a dedicated per-guild cadence floor (so it can't re-attempt faster
 *      than `proactiveIntervalSeconds` regardless of how often the caller
 *      polls) plus a cheap, no-LLM-call heuristic ("has anyone actually
 *      said anything recently") before ever spending a cheap-gate call —
 *      this is what stops it firing into silence or an empty channel.
 *
 * Pure decision logic — no network calls of its own except delegating to
 * the injected LLMProvider's cheapGateCheck, so it's implemented for real.
 */
export class TurnTakingEngine {
  private readonly lastProactiveAttemptAt = new Map<string, number>();

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
    /**
     * Minimum seconds between proactive-chime ATTEMPTS per guild (not just
     * successes) — stamped in `decideProactive` the moment an attempt clears
     * this floor, whether or not it goes on to say yes. Bounds proactive-path
     * API cost to at most one cheap-gate call per interval, independent of
     * how often the caller polls `maybeFireProactiveTurn`. Sam/Merry:
     * sourced from `AppConfig.defaults` once that config field exists —
     * falls back to `DEFAULT_PROACTIVE_INTERVAL_SECONDS` if not supplied.
     */
    private readonly proactiveIntervalSeconds: number = DEFAULT_PROACTIVE_INTERVAL_SECONDS,
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
      // Explicit trigger — respond without the cheap gate. `contextHint`
      // (social-presence round) carries a per-event, name-the-person reason
      // for member_joined/member_left/session_start; every other explicit
      // trigger type leaves it unset and keeps the original fixed string.
      return {
        candidate,
        shouldRespond: true,
        reason: candidate.contextHint ?? `explicit trigger (${candidate.triggerType})`,
        bypassCooldown,
        cheapGateUsed: false,
        decidedAt: Date.now(),
      };
    }

    if (candidate.triggerType === "proactive") {
      return this.decideProactive(candidate, persona);
    }

    // Adaptive-cadence learning layer (social-presence round): if recent
    // ambient/proactive turns have mostly flopped, decline before spending a
    // cheap-gate call at all — see the doc comment above ENGAGEMENT_MIN_SAMPLES.
    const engagementStats = await this.memory.getRecentEngagementStats(candidate.guildId);
    const flopRatio = computeFlopRatio(engagementStats);
    if (flopRatio !== undefined && flopRatio >= ENGAGEMENT_FLOP_RATIO_DAMPEN) {
      log.debug("engagement signal dampening ambient candidate", { guildId: candidate.guildId, flopRatio });
      return {
        candidate,
        shouldRespond: false,
        reason: `recent chime-ins mostly went unanswered (${Math.round(flopRatio * 100)}% flopped) — staying quieter for now`,
        bypassCooldown: false,
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

  /**
   * Proactive-specific gate: cadence floor -> cheap activity heuristic (no
   * LLM call) -> lighter cheap-gate call. Never bypasses the rate limiter's
   * min-gap/per-minute cap (already checked by `decide` before this runs).
   */
  private async decideProactive(candidate: TurnCandidate, persona: PersonaConfig): Promise<TurnDecision> {
    const now = Date.now();

    // Adaptive-cadence learning layer (social-presence round): rescale the
    // per-guild cadence floor by the recent landed:flopped ratio before
    // checking it — two-directional here (unlike the ambient branch above),
    // since proactive already has an explicit interval to stretch or
    // shrink rather than a binary gate to skip.
    const engagementStats = await this.memory.getRecentEngagementStats(candidate.guildId);
    const flopRatio = computeFlopRatio(engagementStats);
    let effectiveIntervalSeconds = this.proactiveIntervalSeconds;
    if (flopRatio !== undefined) {
      if (flopRatio >= ENGAGEMENT_FLOP_RATIO_DAMPEN) {
        effectiveIntervalSeconds = this.proactiveIntervalSeconds * PROACTIVE_INTERVAL_DAMPEN_MULTIPLIER;
      } else if (flopRatio <= 1 - ENGAGEMENT_LANDED_RATIO_BOOST) {
        effectiveIntervalSeconds = Math.max(
          PROACTIVE_INTERVAL_BOOST_FLOOR_SECONDS,
          this.proactiveIntervalSeconds * PROACTIVE_INTERVAL_BOOST_MULTIPLIER,
        );
      }
    }

    const lastAttempt = this.lastProactiveAttemptAt.get(candidate.guildId) ?? 0;
    if (now - lastAttempt < effectiveIntervalSeconds * 1000) {
      return {
        candidate,
        shouldRespond: false,
        reason:
          effectiveIntervalSeconds === this.proactiveIntervalSeconds
            ? "proactive interval not yet elapsed"
            : `proactive interval not yet elapsed (adjusted to ${Math.round(effectiveIntervalSeconds)}s by recent engagement)`,
        bypassCooldown: false,
        cheapGateUsed: false,
        decidedAt: now,
      };
    }

    // Stamp the attempt now (before the heuristic/gate call resolves) so at
    // most one proactive attempt happens per interval regardless of poll
    // frequency or how long the gate call takes.
    this.lastProactiveAttemptAt.set(candidate.guildId, now);

    const hasRecentHumanActivity = candidate.segments.some(
      (s) => s.userId !== BOT_SPEAKER_ID && s.isFinal && s.text.trim().length > 0 && now - s.endedAt <= PROACTIVE_ACTIVITY_LOOKBACK_MS,
    );
    if (!hasRecentHumanActivity) {
      return {
        candidate,
        shouldRespond: false,
        reason: "no recent human activity to riff on",
        bypassCooldown: false,
        cheapGateUsed: false,
        decidedAt: now,
      };
    }

    const gateResult = await this.llm.cheapGateCheck({
      guildId: candidate.guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript: candidate.segments,
    });

    log.debug("proactive cheap-gate result", {
      guildId: candidate.guildId,
      shouldRespond: gateResult.shouldRespond,
      reason: gateResult.reason,
    });

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
      decidedAt: now,
    };
  }
}

/**
 * Recent flopped-ratio out of (landed + flopped), or `undefined` if there
 * aren't enough recorded outcomes yet to act on (see `ENGAGEMENT_MIN_SAMPLES`
 * above) — callers must treat `undefined` as "no signal", never as 0%.
 */
function computeFlopRatio(stats: { landed: number; flopped: number }): number | undefined {
  const total = stats.landed + stats.flopped;
  if (total < ENGAGEMENT_MIN_SAMPLES) return undefined;
  return stats.flopped / total;
}
