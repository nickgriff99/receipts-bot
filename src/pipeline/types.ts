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
});
export type TurnCandidate = z.infer<typeof TurnCandidateSchema>;

export function isExplicitTrigger(type: TriggerType): boolean {
  return type !== "ambient_pause";
}

export const TurnDecisionSchema = z.object({
  candidate: TurnCandidateSchema,
  shouldRespond: z.boolean(),
  /** Cheap-gate rationale for ambient candidates, or a short fixed rationale for explicit ones. */
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
