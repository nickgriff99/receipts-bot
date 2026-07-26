import { z } from "zod";
import { TranscriptSegmentSchema } from "../stt/types";

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
});
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;

export interface RateLimiter {
  /**
   * @param bypassCooldown - true for explicit triggers: still enforces the
   *   per-minute cap, but ignores the min-gap-seconds cooldown (brief
   *   section 3: "explicit-address triggers can bypass part of this
   *   cooldown").
   *
   * Async (Gollum, Postgres migration round): `InMemoryRateLimiter`'s
   * `configFor` callback reads per-guild `maxResponsesPerMinute`/
   * `minGapSeconds` via `MemoryStore.getGuildSettings`, which is now async
   * (real Postgres I/O) — so this had to become async too, even though the
   * limiter's own sliding-window state is still pure in-memory logic.
   */
  canRespond(guildId: string, opts: { bypassCooldown: boolean }): Promise<boolean>;
  recordResponse(guildId: string): void;
}

export interface RateLimiterConfig {
  maxResponsesPerMinute: number;
  minGapSeconds: number;
}
