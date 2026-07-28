import type { LLMProvider } from "../llm/types";
import type { PersonaConfig } from "../llm/types";
import type { MemoryStore, EngagementBucket } from "../memory/types";
import type { RateLimiter } from "./types";
import type { TurnCandidate, TurnDecision } from "./types";
import { isExplicitTrigger } from "./types";
import {
  BOT_SPEAKER_ID,
  FALLBACK_PROACTIVE_CHIME_INTERVAL_SECONDS,
  INTERJECTION_MIN_INTERVAL_SECONDS,
  PROACTIVE_JITTER_MIN_MULTIPLIER,
  PROACTIVE_JITTER_MAX_MULTIPLIER,
} from "../config/constants";
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
 * section 5; extended with a per-category dimension in the
 * conversation-continuity round — brief section 6). Concrete, non-ML scope:
 * read an aggregated recent landed:flopped ratio per situation-type
 * (`MemoryStore.getRecentEngagementStats`, populated by
 * `PipelineOrchestrator` — see its `pendingEngagementByGuild` doc comment
 * for exactly how a turn resolves to one or the other) and use it to nudge
 * how eager the bot is to speak next, per guild AND per category:
 *
 * - Ambient candidates: if recent AMBIENT-category turns have mostly
 *   flopped, decline the generic ambient gate before spending a cheap-gate
 *   call at all (saves cost too) — "recent chime-ins mostly went
 *   unanswered, stay quieter for a while." Even when damped this way, the
 *   rarer interjection check (task 5) still gets its own shot, gated by its
 *   OWN category's engagement stats instead — see `decideInterjection`.
 * - Proactive candidates: the per-guild cadence floor
 *   (`proactiveIntervalSeconds`) is scaled up (talk less often) when recent
 *   PROACTIVE-category turns have mostly flopped, or scaled down toward
 *   (but never below) a hard floor when they've mostly landed —
 *   two-directional, since proactive already has an explicit interval to
 *   rescale rather than a binary gate to skip.
 * - Active-thread continuations (task 1) and explicit triggers are
 *   deliberately NOT gated by this signal at all — see
 *   `TurnOutcomeCategorySchema`'s doc comment (memory/types.ts) for why
 *   those aren't a timing judgment to learn from in the first place.
 *
 * All three ratio checks are gated by `ENGAGEMENT_MIN_SAMPLES` — a new
 * guild, a freshly-split category, or one that just restarted (given the
 * current in-process rate-limiter/attempt-timing state) has zero samples
 * and must be read as "no signal yet", not as a 0% landed rate that would
 * permanently silence the bot.
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
 * Turn-taking / trigger engine — brief section 3; extended in the
 * conversation-continuity round with active-thread continuations (task 1),
 * a quick-gap interjection check (task 5), and jittered proactive cadence
 * (task 4).
 *
 * Decision order for every candidate:
 *   1. Opted-out speakers never produce candidates at all (filtered
 *      upstream, before this engine ever sees a segment — see
 *      orchestrator.ts's segment intake).
 *   2. Explicit triggers (name said / @-mention / reply) skip the cheap
 *      gate entirely and bypass the min-gap cooldown, but still respect
 *      the hard per-minute cap (its own separate, more generous cap as of
 *      the rate-limiter task-2 fix, if configured — see rateLimiter.ts).
 *   3. Active-thread continuations (task 1) — an `ambient_pause` candidate
 *      whose speaker matches a still-open `activeThreadContinuation` (set
 *      by `PipelineOrchestrator` right after the bot most recently spoke TO
 *      that specific person) — are treated as AT LEAST as reliable as an
 *      explicit trigger: same cheap-gate skip, same cooldown bypass. This
 *      is a code-level, deterministic check (not another LLM prompt
 *      instruction) precisely because the prior round's cheap-gate-only
 *      "DIRECT ADDRESS" prompt guidance was a probabilistic per-call
 *      judgment with no memory of WHO the bot was just talking to.
 *   4. Plain ambient triggers (natural-pause detection upstream already
 *      decided "there's a lull", no active thread match) go through the
 *      haiku cheap-gate call first; if the gate says no, no full
 *      generation happens (this is the main cost lever, brief section 7).
 *      If the ambient gate declines OR is damped out entirely by the
 *      engagement signal, a second, much rarer/higher-bar interjection
 *      check (task 5) still gets a shot before giving up on the candidate.
 *   5. Proactive triggers (timer-driven, no new segment at all — see
 *      orchestrator.ts's `maybeFireProactiveTurn`) do NOT bypass the
 *      cooldown like explicit triggers, and do NOT get an unconditional
 *      yes — they go through their own lighter gate (`decideProactive`):
 *      a dedicated, now-jittered per-guild cadence floor (so it can't
 *      re-attempt faster than a randomized band around
 *      `proactiveIntervalSeconds`, avoiding a metronomic feel) plus a
 *      cheap, no-LLM-call heuristic ("has anyone actually said anything
 *      recently") before ever spending a cheap-gate call — this is what
 *      stops it firing into silence or an empty channel.
 *
 * Pure decision logic — no network calls of its own except delegating to
 * the injected LLMProvider's cheapGateCheck, so it's implemented for real.
 */
export class TurnTakingEngine {
  private readonly lastProactiveAttemptAt = new Map<string, number>();
  /**
   * Jittered proactive-cadence target for the CURRENT wait cycle, per guild
   * (task 4). Drawn fresh once per cycle (when the previous attempt is
   * stamped) rather than on every `decide` call, so the effective floor
   * doesn't flicker mid-wait — see `decideProactive`'s doc comment on the
   * jitter draw.
   */
  private readonly jitteredProactiveIntervalSeconds = new Map<string, number>();
  /** Mirrors `lastProactiveAttemptAt` for the interjection check (task 5) — its own, much shorter cooldown, independent of the proactive timer. */
  private readonly lastInterjectionAttemptAt = new Map<string, number>();

  constructor(
    private readonly llm: LLMProvider,
    private readonly rateLimiter: RateLimiter,
    /**
     * Only used to log cheap-gate token usage to `usage_log` (brief section
     * 7's "log tokens to Claude" — the cheap-gate call is a real Claude
     * call too, and was previously going unlogged) and to read the
     * per-category engagement signal. Not a persistence dependency for
     * turn-taking DECISION logic itself.
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
    const isContinuation = candidate.triggerType === "ambient_pause" && !!candidate.activeThreadContinuation;
    const bypassCooldown = isExplicitTrigger(candidate.triggerType) || isContinuation;

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

    if (isExplicitTrigger(candidate.triggerType)) {
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

    // ambient_pause from here on.

    if (isContinuation) {
      // Active-thread continuation (task 1) — code-level, deterministic:
      // treat exactly as reliably as an explicit trigger. See
      // `PipelineOrchestrator`'s `activeThreadByGuild` doc comment for how
      // this gets set, and `TurnCandidateSchema.activeThreadContinuation`
      // (pipeline/types.ts) for why this stays modeled as a flag on
      // `ambient_pause` rather than a new `TriggerType`.
      log.debug("active-thread continuation — skipping cheap gate", {
        guildId: candidate.guildId,
        withUserId: candidate.activeThreadContinuation!.withUserId,
      });
      return {
        candidate,
        shouldRespond: true,
        reason: candidate.activeThreadContinuation!.contextHint,
        bypassCooldown: true,
        cheapGateUsed: false,
        decidedAt: Date.now(),
        category: "continuation",
      };
    }

    const engagementStats = await this.memory.getRecentEngagementStats(candidate.guildId);
    const ambientFlopRatio = computeFlopRatio(engagementStats.byCategory.ambient ?? EMPTY_BUCKET);
    if (ambientFlopRatio !== undefined && ambientFlopRatio >= ENGAGEMENT_FLOP_RATIO_DAMPEN) {
      log.debug("engagement signal dampening ambient candidate — trying interjection instead", {
        guildId: candidate.guildId,
        ambientFlopRatio,
      });
      return this.decideInterjection(candidate, persona, engagementStats);
    }

    // Ambient — go through the cheap gate first (primary cost lever).
    const gateResult = await this.llm.cheapGateCheck({
      guildId: candidate.guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript: candidate.segments,
      checkKind: "ambient",
    });

    log.debug("cheap-gate result", { guildId: candidate.guildId, shouldRespond: gateResult.shouldRespond, reason: gateResult.reason });

    // Fire-and-forget, logged on failure (merry, wiring pass) — a
    // usage_log write is cost-audit only, must never abort turn-taking's
    // shouldRespond decision. Same non-critical-persistence treatment as
    // `orchestrator.ts`'s logUsage call sites and the `recordTurnOutcome`
    // fire-and-forget precedent.
    void this.memory
      .logUsage({
        guildId: candidate.guildId,
        service: "llm",
        unitType: "tokens",
        units: gateResult.usage.inputTokens + gateResult.usage.outputTokens,
        occurredAt: Date.now(),
      })
      .catch((err) => {
        log.error("failed to log ambient cheap-gate usage", {
          guildId: candidate.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    if (gateResult.shouldRespond) {
      return {
        candidate,
        shouldRespond: true,
        reason: gateResult.reason,
        bypassCooldown: false,
        cheapGateUsed: true,
        decidedAt: Date.now(),
        category: "ambient",
      };
    }

    // Generic ambient gate said no — task 5's quick-gap interjection check
    // gets its own, much rarer shot at this exact pause before giving up.
    return this.decideInterjection(candidate, persona, engagementStats);
  }

  /**
   * Quick-gap interjection check (task 5, conversation-continuity round).
   * Owner's chosen SMALLER scope: this never reconsiders whether the bot is
   * allowed to speak at all right now — it only ever runs on an
   * `ambient_pause` candidate, which by construction never exists until VAD
   * has already closed the speaker's utterance on silence (see
   * discord/bootstrap.ts's `subscribeAudioForUser` — partial transcripts
   * never reach turn-taking). So "never talk over an in-progress sentence"
   * already holds by construction here, same as everywhere else in this
   * engine — this method does not touch that floor.
   *
   * Decoupled from both the generic ambient gate's conservative bar (may
   * run even when that gate said no, or was damped out entirely) and from
   * the proactive timer's ~2-3min cadence floor (own much shorter
   * `INTERJECTION_MIN_INTERVAL_SECONDS` cooldown instead) — see
   * `llm/claudeProvider.ts`'s `buildInterjectionGateSystemPrompt` for the
   * distinct, higher-bar prompt this calls.
   *
   * @param engagementStats - reused from the caller when already fetched
   *   (the ambient-damping path already has it) to avoid a redundant
   *   `MemoryStore` round-trip; fetched fresh otherwise.
   */
  private async decideInterjection(
    candidate: TurnCandidate,
    persona: PersonaConfig,
    engagementStats?: Awaited<ReturnType<MemoryStore["getRecentEngagementStats"]>>,
  ): Promise<TurnDecision> {
    const now = Date.now();
    const guildId = candidate.guildId;

    const lastAttempt = this.lastInterjectionAttemptAt.get(guildId) ?? 0;
    if (now - lastAttempt < INTERJECTION_MIN_INTERVAL_SECONDS * 1000) {
      return {
        candidate,
        shouldRespond: false,
        reason: "interjection cooldown not yet elapsed",
        bypassCooldown: false,
        cheapGateUsed: false,
        decidedAt: now,
      };
    }

    const stats = engagementStats ?? (await this.memory.getRecentEngagementStats(guildId));
    const interjectionFlopRatio = computeFlopRatio(stats.byCategory.interjection ?? EMPTY_BUCKET);
    if (interjectionFlopRatio !== undefined && interjectionFlopRatio >= ENGAGEMENT_FLOP_RATIO_DAMPEN) {
      return {
        candidate,
        shouldRespond: false,
        reason: `recent interjections mostly went unanswered (${Math.round(interjectionFlopRatio * 100)}% flopped) — staying quieter for now`,
        bypassCooldown: false,
        cheapGateUsed: false,
        decidedAt: now,
      };
    }

    // Stamp the attempt now (before the gate call resolves), same
    // one-attempt-per-window pattern as `decideProactive` below.
    this.lastInterjectionAttemptAt.set(guildId, now);

    const gateResult = await this.llm.cheapGateCheck({
      guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript: candidate.segments,
      checkKind: "interjection",
    });

    log.debug("interjection cheap-gate result", { guildId, shouldRespond: gateResult.shouldRespond, reason: gateResult.reason });

    void this.memory
      .logUsage({
        guildId,
        service: "llm",
        unitType: "tokens",
        units: gateResult.usage.inputTokens + gateResult.usage.outputTokens,
        occurredAt: now,
      })
      .catch((err) => {
        log.error("failed to log interjection cheap-gate usage", {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return {
      candidate,
      shouldRespond: gateResult.shouldRespond,
      reason: gateResult.reason,
      bypassCooldown: false,
      cheapGateUsed: true,
      decidedAt: now,
      category: "interjection",
    };
  }

  /**
   * Proactive-specific gate: jittered cadence floor -> cheap activity
   * heuristic (no LLM call) -> lighter cheap-gate call. Never bypasses the
   * rate limiter's min-gap/per-minute cap (already checked by `decide`
   * before this runs).
   */
  private async decideProactive(candidate: TurnCandidate, persona: PersonaConfig): Promise<TurnDecision> {
    const now = Date.now();

    // Adaptive-cadence learning layer: rescale the per-guild cadence floor
    // by the recent PROACTIVE-category landed:flopped ratio before checking
    // it — two-directional here (unlike the ambient branch above), since
    // proactive already has an explicit interval to stretch or shrink
    // rather than a binary gate to skip.
    const engagementStats = await this.memory.getRecentEngagementStats(candidate.guildId);
    const flopRatio = computeFlopRatio(engagementStats.byCategory.proactive ?? EMPTY_BUCKET);
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

    // Organic-cadence jitter (task 4): drawn once per wait cycle and cached
    // (not re-rolled every `decide` call) so the effective floor doesn't
    // flicker mid-wait as the engagement ratio shifts poll to poll. Cleared
    // right after an attempt is stamped below, so the NEXT cycle draws a
    // fresh value against whatever `effectiveIntervalSeconds` is current at
    // that point. This is deliberately done here (the cadence-floor CHECK),
    // not in bootstrap.ts's `setInterval` poll cadence — that timer already
    // ticks at a fixed rate and is the only thing that ever calls in, so
    // jitter has to come from varying how many ticks are allowed to pass
    // before one is accepted, not from varying the tick rate itself.
    let jitteredIntervalSeconds = this.jitteredProactiveIntervalSeconds.get(candidate.guildId);
    if (jitteredIntervalSeconds === undefined) {
      jitteredIntervalSeconds = computeJitteredInterval(effectiveIntervalSeconds);
      this.jitteredProactiveIntervalSeconds.set(candidate.guildId, jitteredIntervalSeconds);
    }

    const lastAttempt = this.lastProactiveAttemptAt.get(candidate.guildId) ?? 0;
    if (now - lastAttempt < jitteredIntervalSeconds * 1000) {
      return {
        candidate,
        shouldRespond: false,
        reason:
          effectiveIntervalSeconds === this.proactiveIntervalSeconds
            ? "proactive interval not yet elapsed"
            : `proactive interval not yet elapsed (adjusted to ~${Math.round(jitteredIntervalSeconds)}s by recent engagement + jitter)`,
        bypassCooldown: false,
        cheapGateUsed: false,
        decidedAt: now,
      };
    }

    // Stamp the attempt now (before the heuristic/gate call resolves) so at
    // most one proactive attempt happens per interval regardless of poll
    // frequency or how long the gate call takes. Clear the cached jitter
    // target so the NEXT wait cycle draws a fresh one.
    this.lastProactiveAttemptAt.set(candidate.guildId, now);
    this.jitteredProactiveIntervalSeconds.delete(candidate.guildId);

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
      checkKind: "ambient",
    });

    log.debug("proactive cheap-gate result", {
      guildId: candidate.guildId,
      shouldRespond: gateResult.shouldRespond,
      reason: gateResult.reason,
    });

    void this.memory
      .logUsage({
        guildId: candidate.guildId,
        service: "llm",
        unitType: "tokens",
        units: gateResult.usage.inputTokens + gateResult.usage.outputTokens,
        occurredAt: Date.now(),
      })
      .catch((err) => {
        log.error("failed to log proactive cheap-gate usage", {
          guildId: candidate.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return {
      candidate,
      shouldRespond: gateResult.shouldRespond,
      reason: gateResult.reason,
      bypassCooldown: false,
      cheapGateUsed: true,
      decidedAt: now,
      category: "proactive",
    };
  }
}

const EMPTY_BUCKET: EngagementBucket = { landed: 0, flopped: 0 };

/**
 * Recent flopped-ratio out of (landed + flopped), or `undefined` if there
 * aren't enough recorded outcomes yet to act on (see `ENGAGEMENT_MIN_SAMPLES`
 * above) — callers must treat `undefined` as "no signal", never as 0%.
 */
function computeFlopRatio(stats: EngagementBucket): number | undefined {
  const total = stats.landed + stats.flopped;
  if (total < ENGAGEMENT_MIN_SAMPLES) return undefined;
  return stats.flopped / total;
}

/**
 * Task 4 — draws a jitter multiplier uniformly from
 * [`PROACTIVE_JITTER_MIN_MULTIPLIER`, `PROACTIVE_JITTER_MAX_MULTIPLIER`]
 * and applies it to the base interval. See that constant's doc comment
 * (config/constants.ts) for why the band is centered slightly above 1.0.
 */
function computeJitteredInterval(baseSeconds: number): number {
  const multiplier =
    PROACTIVE_JITTER_MIN_MULTIPLIER + Math.random() * (PROACTIVE_JITTER_MAX_MULTIPLIER - PROACTIVE_JITTER_MIN_MULTIPLIER);
  return baseSeconds * multiplier;
}
