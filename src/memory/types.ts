import { z } from "zod";
import { TranscriptSegmentSchema } from "../stt/types";
import { BotModeSchema } from "../config/types";
import {
  MAX_FACTS_PER_PROFILE,
  MAX_RUNNING_JOKES_PER_PROFILE,
  MAX_FACT_LENGTH,
  MAX_SENTIMENT_NOTES_LENGTH,
} from "../config/constants";

/**
 * Memory module boundary.
 *
 * `UserMemoryProfile`, `GuildSettings`, `UsageLogEntry`, and
 * `ConversationLogEntry` are the four row shapes with locked Zod schemas +
 * matching PostgreSQL DDL (see schema.ts). These are the most durable/important
 * contracts in the project since they're persisted, not just in-process —
 * `postgresStore.ts` row<->object mappers should stay structurally
 * compatible with these schemas (the mappers aren't required to call
 * `.parse()` on every read for perf, but any new write path should).
 *
 * Sync -> async migration note (Gollum, Postgres migration round): every
 * `MemoryStore` method now returns a `Promise`. The prior SQLite-backed
 * implementation was synchronous only because `better-sqlite3`'s API is
 * synchronous — that was never a property of the *interface*, just an
 * implementation detail that leaked through. Postgres via `pg` is
 * inherently async (real network I/O), so the interface now reflects that
 * honestly. Every call site across `pipeline/orchestrator.ts`,
 * `pipeline/rateLimiter.ts`, `pipeline/turnTaking.ts`,
 * `pipeline/contextAssembler.ts`, `discord/bootstrap.ts`, and
 * `discord/commands/*.ts` was updated to `await` these calls — grep for
 * `.memory.` or `MemoryStore` if adding a new call site.
 *
 * Schema-lock decision (facts/running_jokes storage — see also
 * ARCHITECTURE.md addendum and schema.ts): kept as JSON-encoded TEXT
 * columns, not normalized into a child table. Reasoning: these lists are
 * short, always read/written as a whole per profile (never queried or
 * filtered per-item), and v1 has no requirement to join/search across
 * individual facts. A normalized `user_facts` table would only pay for
 * itself if we needed per-fact timestamps/queries later — flagged as a
 * possible v2 migration, not needed now. What IS needed now: an actual cap,
 * since "read/write whole list" + no pruning would grow unbounded forever.
 * `MAX_FACTS_PER_PROFILE`/`MAX_RUNNING_JOKES_PER_PROFILE` (config/constants.ts)
 * are enforced both here (Zod, defense at the boundary) and in
 * `sqliteStore.ts#dedupeAppend` (truncates to newest N) — belt and braces.
 */

const FactStringSchema = z.string().min(1).max(MAX_FACT_LENGTH);

export const UserMemoryProfileSchema = z.object({
  userId: z.string().min(1),
  guildId: z.string().min(1),
  displayName: z.string().min(1),
  /** Notable facts extracted post-hoc (brief section 5) — free-form short strings, not raw transcript. */
  facts: z.array(FactStringSchema).max(MAX_FACTS_PER_PROFILE),
  runningJokes: z.array(FactStringSchema).max(MAX_RUNNING_JOKES_PER_PROFILE),
  sentimentNotes: z.string().max(MAX_SENTIMENT_NOTES_LENGTH).optional(),
  lastInteractionAt: z.number().int().nonnegative(),
  optedOut: z.boolean(),
  /**
   * Explicit opt-in accept button state — schema/plumbing only this round
   * (Frodo). Sam owns the button/notice-message wiring, Merry owns pipeline
   * gating on this flag; nothing in this repo reads it yet besides the
   * `MemoryStore` accessor pair below.
   */
  consentAccepted: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type UserMemoryProfile = z.infer<typeof UserMemoryProfileSchema>;

export const GuildSettingsSchema = z.object({
  guildId: z.string().min(1),
  mode: BotModeSchema,
  maxResponsesPerMinute: z.number().int().positive(),
  minGapSeconds: z.number().int().nonnegative(),
  sttConfidenceThreshold: z.number().min(0).max(1),
  allowAmbientBargeIn: z.boolean(),
  voiceId: z.string().min(1).optional(), // overrides ELEVENLABS_VOICE_ID default
  /** Admin-pinned consent-notice channel (`/setconsentchannel`) — checked first in `resolveTextChannelId`, falls back to the existing same-name/system/first-sendable chain if unset or no longer sendable. */
  consentChannelId: z.string().min(1).optional(),
  /**
   * Per-guild override for `RateLimiterConfig.maxExplicitResponsesPerMinute`
   * (`pipeline/types.ts`, conversation-continuity round task 2 fix) — Sam's
   * contract-review follow-up. `undefined` (every guild's default until an
   * operator opts in via the `/admin/guilds/:guildId/settings` PUT route,
   * same as `voiceId`/`consentChannelId`'s optional-override pattern above)
   * preserves the rate limiter's pre-existing shared-cap fallback behavior
   * — this field exists so an operator CAN give explicit-address turns
   * their own budget, not so it's on by default. No matching env default
   * (unlike `maxResponsesPerMinute`/`minGapSeconds`) — the investigation
   * that motivated this field (`CONVERSATION_CONTINUITY_ARCHITECTURE.md`
   * section 2b) concluded it's a low-probability edge case under current
   * defaults, so it should be dialed in per-guild if/when live testing
   * actually shows a need, not defaulted on process-wide.
   */
  maxExplicitResponsesPerMinute: z.number().int().positive().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type GuildSettings = z.infer<typeof GuildSettingsSchema>;

/**
 * Adaptive-cadence learning signal (social-presence round, frodo — brief
 * section 5: "actively learning when a good time to talk is"). Recorded
 * once per resolved non-explicit (ambient_pause or proactive) bot turn —
 * never for explicit triggers (mention/reply/name) or system events
 * (member_joined/member_left/session_start), none of which are a timing
 * judgment call. See `PipelineOrchestrator`'s doc comment on
 * `pendingEngagementByGuild` for the exact operational definition:
 *
 * - "landed": a human (consented, non-opted-out — the only kind that ever
 *   reaches `handleSegment`) final transcript segment was observed, started
 *   at or after the bot's reply finished playing, within the follow-up
 *   window.
 * - "flopped": either the follow-up window elapsed with no such segment
 *   (silence), OR a human segment arrived that had already started before
 *   the bot's reply finished (talked over).
 */
export const TurnOutcomeSchema = z.enum(["landed", "flopped"]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/**
 * Situation-type dimension on the adaptive-learning signal (conversation-
 * continuity round, frodo — brief section 6: "learn how and when to
 * respond IN THESE SITUATIONS", plural). Prior rounds recorded one
 * guild-wide lump landed/flopped counter with no notion of WHICH kind of
 * non-explicit turn it was; this splits that into four buckets so the
 * cadence-gating logic in `pipeline/turnTaking.ts` can learn each
 * situation's own landed:flopped ratio instead of one blended average:
 *
 * - "continuation": an `ambient_pause` candidate that hit an active
 *   conversation-thread match (`TurnCandidate.activeThreadContinuation`,
 *   `pipeline/types.ts`) — the bot replying to someone it JUST
 *   greeted/answered, without them re-saying its name.
 * - "ambient": a plain `ambient_pause` candidate that went through the
 *   ordinary cheap-gate and got a YES — pre-existing behavior, same
 *   meaning as the old single "ambient/proactive" lump minus the other
 *   three buckets now split out.
 * - "interjection": the new, rarer, higher-bar "worth jumping into this
 *   specific pause" check (`TurnTakingEngine`'s `decideInterjection`) fired
 *   even though (or without ever asking) the generic ambient gate said yes.
 * - "proactive": timer-driven chime-in, unchanged meaning from before.
 *
 * Deliberately NOT tracked for explicit_mention/explicit_reply/explicit_name
 * (still "always correct to answer", no timing judgment to learn from —
 * same reasoning the original lump signal used to exclude all explicit
 * triggers, unchanged this round) or member_joined/member_left/session_start
 * (rare, bounded system events, not a timing judgment either).
 *
 * Sample-size tradeoff, flagged deliberately: splitting one lump counter
 * into four buckets means each bucket individually reaches
 * `ENGAGEMENT_MIN_SAMPLES` (turnTaking.ts) roughly 4x slower than the old
 * single counter did. Accepted per the owner's explicit ask for
 * situation-specific learning over a faster-but-blended average.
 */
export const TurnOutcomeCategorySchema = z.enum(["continuation", "ambient", "interjection", "proactive"]);
export type TurnOutcomeCategory = z.infer<typeof TurnOutcomeCategorySchema>;

/** One category's landed/flopped counts — same shape reused for the overall aggregate and each per-category bucket below. */
export const EngagementBucketSchema = z.object({
  landed: z.number().int().nonnegative(),
  flopped: z.number().int().nonnegative(),
});
export type EngagementBucket = z.infer<typeof EngagementBucketSchema>;

export const UsageServiceSchema = z.enum(["stt", "llm", "tts"]);
export type UsageService = z.infer<typeof UsageServiceSchema>;

export const UsageUnitTypeSchema = z.enum(["characters", "tokens"]);
export type UsageUnitType = z.infer<typeof UsageUnitTypeSchema>;

export const UsageLogEntrySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  service: UsageServiceSchema,
  unitType: UsageUnitTypeSchema,
  units: z.number().int().nonnegative(),
  occurredAt: z.number().int().nonnegative(),
});
export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

/**
 * Rolling raw transcript log — brief section 5's "raw logs roll into
 * summarized profile updates" and section 8's "never persist raw audio,
 * transcripts/derived memory only, with a stated retention policy". This
 * table holds TEXT only, never audio, and is pruned by `pruneOldLogs`.
 */
export const ConversationLogEntrySchema = TranscriptSegmentSchema.extend({
  loggedAt: z.number().int().nonnegative(),
});
export type ConversationLogEntry = z.infer<typeof ConversationLogEntrySchema>;

export interface MemoryStore {
  getProfile(guildId: string, userId: string): Promise<UserMemoryProfile | undefined>;
  upsertProfile(profile: UserMemoryProfile): Promise<void>;
  appendFacts(guildId: string, userId: string, facts: string[]): Promise<void>;

  isOptedOut(guildId: string, userId: string): Promise<boolean>;
  setOptOut(guildId: string, userId: string, optedOut: boolean): Promise<void>;

  /** Explicit opt-in accept-button state (schema/plumbing only — Sam wires the button, Merry wires pipeline gating). */
  hasAcceptedConsent(guildId: string, userId: string): Promise<boolean>;
  setConsentAccepted(guildId: string, userId: string, accepted: boolean): Promise<void>;

  getGuildSettings(guildId: string): Promise<GuildSettings>;
  setGuildSettings(guildId: string, patch: Partial<Omit<GuildSettings, "guildId">>): Promise<void>;

  appendConversationLog(entry: ConversationLogEntry): Promise<void>;
  /** Delete conversation_log rows older than the cutoff — retention/deletion policy, brief section 8. */
  pruneOldLogs(beforeTimestamp: number): Promise<number>; // returns rows deleted

  logUsage(entry: Omit<UsageLogEntry, "id">): Promise<void>;
  /** Sum of units per service since a timestamp, for cost auditing / dashboards. */
  getUsageSince(guildId: string, sinceTimestamp: number): Promise<Record<UsageService, number>>;

  /**
   * Adaptive-cadence learning signal (see `TurnOutcomeSchema` above) —
   * record one resolved outcome, tagged with WHICH situation-type produced
   * it (`TurnOutcomeCategorySchema`, conversation-continuity round).
   * Persisted to a real `turn_outcomes` table (`memory/schema.ts`) as of the
   * durability round (Sam) — promoted off frodo's original temporary
   * in-process ring buffer so this signal survives a bot restart.
   * `PostgresMemoryStore#recordTurnOutcome` prunes back down to
   * `MAX_ENGAGEMENT_OUTCOMES_PER_GUILD` (config/constants.ts) rows PER
   * (guild, category) on every write — same "cap enforced at the write
   * site" semantics as the old ring buffer, just backed by a real DELETE
   * now, scoped per-category so one noisy category can't evict another's
   * history.
   */
  recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number, category: TurnOutcomeCategory): Promise<void>;
  /**
   * Recent landed/flopped counts for a guild, both as one blended `overall`
   * total (kept for any caller that still wants a single guild-wide signal)
   * and split per `TurnOutcomeCategory` in `byCategory` (conversation-
   * continuity round — see `TurnOutcomeCategorySchema`'s doc comment for
   * why). A category absent from `byCategory` means zero recorded outcomes
   * for it yet — callers must treat that the same as a present-but-empty
   * `{landed: 0, flopped: 0}` bucket: "no signal yet", never an implicit 0%
   * landed rate. "Recent" window is this store's call (currently: last
   * `MAX_ENGAGEMENT_OUTCOMES_PER_GUILD` outcomes per (guild, category),
   * enforced at write time — see `PostgresMemoryStore`).
   */
  getRecentEngagementStats(guildId: string): Promise<{ overall: EngagementBucket; byCategory: Partial<Record<TurnOutcomeCategory, EngagementBucket>> }>;

  close(): Promise<void>;
}
