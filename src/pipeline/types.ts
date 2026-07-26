import { z } from "zod";
import { TranscriptSegmentSchema } from "../stt/types";
import { TurnOutcomeCategorySchema } from "../memory/types";

/**
 * Pipeline module boundary — turn-taking/trigger logic.
 *
 * `TurnDecision` is the second most-shared shape (after TranscriptSegment)
 * — it's the record of "why did/didn't the bot respond", useful for both
 * driving the orchestrator AND for admin-facing debugging/logging. Locked
 * as a Zod schema (Sam) even though it isn't persisted to Postgres in v1
 * (kept in-memory / structured logs only) — still worth validating at the
 * turn-taking/orchestrator boundary.
 */

export const TriggerTypeSchema = z.enum([
  "explicit_mention",
  "explicit_reply",
  "explicit_name",
  "ambient_pause",
  /**
   * Timer-driven chime-in — no new transcript segment triggered this turn.
   * Fired by `PipelineOrchestrator.maybeFireProactiveTurn` (called
   * periodically by whatever tracks voice-channel presence — see
   * orchestrator.ts's doc comment). Deliberately NOT grouped with the
   * explicit triggers below: it must NOT bypass the min-gap cooldown (that
   * would let it stack with organic chatter and blow the per-minute
   * budget), and it goes through its own lighter gate in
   * TurnTakingEngine.decide rather than either the full ambient cheap-gate
   * or an unconditional yes.
   */
  "proactive",
  /**
   * Social-presence round (frodo) — three system-driven triggers, none of
   * them a "should I speak right now" judgment call, so all three are
   * EXPLICIT (see isExplicitTrigger below): they always fire when the
   * caller decides the event happened, skipping the cheap gate entirely,
   * while still respecting the per-minute rate cap.
   *
   * - "member_joined": a specific person joined a voice channel the bot is
   *   already connected to. Fired by `PipelineOrchestrator.handleMemberJoinedVoice`.
   *   `triggeringUserId` is their REAL Discord user id (not a sentinel) —
   *   this is what lets `ContextAssembler`'s existing speaker-based memory
   *   lookup naturally pick up their `UserMemoryProfile` with zero new
   *   plumbing, by attributing a synthetic transcript segment to that id
   *   (see orchestrator.ts's doc comment on `handleMemberJoinedVoice`).
   * - "member_left": the mirror event for someone leaving. Fired by
   *   `PipelineOrchestrator.handleMemberLeftVoice`. Same real-userId
   *   attribution.
   * - "session_start": a one-time general "hello everyone" fired once per
   *   fresh voice connection (`PipelineOrchestrator.announceSessionStart`,
   *   called from `startVoicePipeline` — covers both explicit `/join` and
   *   auto-join-on-entry). No real speaker to attribute to — uses the
   *   `SESSION_START_TRIGGER_USER_ID` sentinel below, mirroring
   *   `PROACTIVE_TRIGGER_USER_ID`'s pattern.
   */
  "member_joined",
  "member_left",
  "session_start",
]);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

export const TurnCandidateSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  triggerType: TriggerTypeSchema,
  triggeringUserId: z.string().min(1),
  /** Recent window feeding this candidate — oldest first. */
  segments: z.array(TranscriptSegmentSchema),
  detectedAt: z.number().int().nonnegative(),
  /**
   * Social-presence round (frodo): free-text override for WHY this turn is
   * happening, used verbatim as `TurnDecision.reason` in place of the
   * generic `"explicit trigger (${type})"` string — set by the orchestrator
   * for member_joined/member_left/session_start, where the actual reason
   * needs to name the specific person and their memory-state ("greet them
   * like a returning face" vs "brief generic hello") rather than a fixed
   * phrase. `undefined` for every other trigger type (existing explicit
   * triggers keep the old fixed-string behavior — see turnTaking.ts's
   * `decide`). This is the vehicle that flows straight into
   * `LLMRequest.triggerReason` via `ContextAssembler.assemble`, so no new
   * field was needed on the LLM contract itself to carry per-event context.
   */
  contextHint: z.string().optional(),
  /**
   * Conversation-continuity round (frodo, task 1) — set by
   * `PipelineOrchestrator` (which owns `activeThreadByGuild`, the code-level
   * "bot is mid-conversation with this specific person" tracker) when an
   * incoming `ambient_pause` candidate's `triggeringUserId` matches a
   * still-open thread. Deliberately modeled as a flag/hint on the EXISTING
   * `ambient_pause` trigger type rather than a new `TriggerType` — the
   * candidate really is still just an ambient VAD-closed utterance from a
   * turn-taking-mechanics standpoint (no new bypass-the-natural-pause
   * behavior), it just carries extra code-level evidence about WHO it's
   * from. `TurnTakingEngine.decide` treats its presence as at least as
   * reliable as an explicit trigger — see that method's doc comment.
   * `undefined` for every trigger type except `ambient_pause`, and for
   * `ambient_pause` candidates with no open thread for that speaker.
   */
  activeThreadContinuation: z
    .object({
      withUserId: z.string().min(1),
      /** Free-text reason, same `contextHint`-into-`LLMRequest.triggerReason` pattern as the social-presence round's system-event turns. */
      contextHint: z.string().min(1),
    })
    .optional(),
});
export type TurnCandidate = z.infer<typeof TurnCandidateSchema>;

/**
 * Sentinel `triggeringUserId` for proactive candidates — there is no real
 * speaking user to attribute the turn to (mirrors the `BOT_SPEAKER_ID`
 * sentinel pattern in config/constants.ts for the bot's own transcript
 * lines). `TurnCandidateSchema.triggeringUserId` requires a non-empty
 * string, so this fills that slot without inventing a fake real user.
 */
export const PROACTIVE_TRIGGER_USER_ID = "__proactive__";

/**
 * Sentinel `triggeringUserId` for the "session_start" trigger — the one
 * new system-driven trigger type (social-presence round) with no real
 * person to attribute to (member_joined/member_left both use the real
 * joining/leaving user's Discord id instead, deliberately — see
 * TriggerTypeSchema's doc comment).
 */
export const SESSION_START_TRIGGER_USER_ID = "__session_start__";

/**
 * Allowlist, not "everything except ambient_pause" — that inverse form
 * silently misclassified any future trigger type as explicit (which is
 * exactly the bug this would have caused for "proactive": explicit triggers
 * bypass the cooldown AND skip the cheap-gate entirely, neither of which is
 * correct for a timer-driven chime-in). Extend this list deliberately when
 * adding a genuinely explicit trigger type.
 *
 * member_joined/member_left/session_start (social-presence round) are
 * included here deliberately: none of them are a "should I speak right now"
 * timing judgment — they're rare, bounded, unambiguous system events — so
 * they should always fire (skip the cheap gate) and get playback priority,
 * same as a direct mention. They still fully respect the rate limiter's
 * per-minute cap (bypassCooldown only skips the min-gap-seconds cooldown,
 * see RateLimiter.canRespond's doc comment) — a burst of joins/leaves can't
 * blow the budget, it just competes for the same capped slots as everything
 * else.
 */
export function isExplicitTrigger(type: TriggerType): boolean {
  return (
    type === "explicit_mention" ||
    type === "explicit_reply" ||
    type === "explicit_name" ||
    type === "member_joined" ||
    type === "member_left" ||
    type === "session_start"
  );
}

export const TurnDecisionSchema = z.object({
  candidate: TurnCandidateSchema,
  shouldRespond: z.boolean(),
  /** Cheap-gate rationale for ambient/proactive candidates, or a short fixed rationale for explicit ones. */
  reason: z.string(),
  /** True for explicit triggers — bypasses the min-gap cooldown (still subject to the per-minute cap). */
  bypassCooldown: z.boolean(),
  /** Whether the haiku cheap-gate call was actually made for this candidate (always false for explicit triggers). */
  cheapGateUsed: z.boolean(),
  decidedAt: z.number().int().nonnegative(),
  /**
   * Conversation-continuity round (frodo, task 6) — which
   * `TurnOutcomeCategory` this decision belongs to, for
   * `PipelineOrchestrator` to tag the engagement window it opens (if any)
   * with. `undefined` for explicit triggers and system events (member
   * joined/left, session start) — same "not a timing judgment, don't track
   * it" set `TurnOutcomeCategorySchema`'s doc comment describes.
   */
  category: TurnOutcomeCategorySchema.optional(),
});
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;

export interface RateLimiter {
  /**
   * @param bypassCooldown - true for explicit triggers (and, as of the
   *   conversation-continuity round, active-thread continuations — see
   *   `TurnCandidate.activeThreadContinuation`): still enforces a per-minute
   *   cap, but ignores the min-gap-seconds cooldown (brief section 3:
   *   "explicit-address triggers can bypass part of this cooldown").
   *
   * Async (Gollum, Postgres migration round): `InMemoryRateLimiter`'s
   * `configFor` callback reads per-guild `maxResponsesPerMinute`/
   * `minGapSeconds` via `MemoryStore.getGuildSettings`, which is now async
   * (real Postgres I/O) — so this had to become async too, even though the
   * limiter's own sliding-window state is still pure in-memory logic.
   */
  canRespond(guildId: string, opts: { bypassCooldown: boolean }): Promise<boolean>;
  /**
   * @param opts.bypassCooldown - must match the value passed to the
   *   `canRespond` call that approved this response (task 2 fix,
   *   conversation-continuity round) — routes the timestamp into the
   *   correct sliding window (see `RateLimiterConfig.maxExplicitResponsesPerMinute`'s
   *   doc comment for why bypass-class responses get their own bucket).
   */
  recordResponse(guildId: string, opts: { bypassCooldown: boolean }): void;
}

export interface RateLimiterConfig {
  maxResponsesPerMinute: number;
  minGapSeconds: number;
  /**
   * Task 2 fix (conversation-continuity round): a SEPARATE per-minute cap
   * just for bypassCooldown-class responses (explicit triggers + active-
   * thread continuations), investigated as a possible cause of "isn't
   * consistently talking when directly addressed" — a burst of
   * ambient/proactive replies earlier in the same 60s window sharing ONE
   * cap with explicit-address replies could in principle silently swallow a
   * legitimate direct-address turn. Optional/additive: `undefined` (until
   * Sam wires a real `GuildSettings`/env column for it) means "not
   * configured for this guild" and falls back to the exact pre-existing
   * behavior of sharing one combined cap across every response class —
   * zero behavior change until a deployment actually sets this.
   */
  maxExplicitResponsesPerMinute?: number;
}
