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
   * record one resolved outcome. Persisted to a real `turn_outcomes` table
   * (`memory/schema.ts`) as of the durability round (Sam) — promoted off
   * frodo's original temporary in-process ring buffer so this signal
   * survives a bot restart. `PostgresMemoryStore#recordTurnOutcome` prunes
   * back down to `MAX_ENGAGEMENT_OUTCOMES_PER_GUILD` (config/constants.ts)
   * rows per guild on every write — same "cap enforced at the write site"
   * semantics as the old ring buffer, just backed by a real DELETE now.
   */
  recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number): Promise<void>;
  /**
   * Aggregated recent landed/flopped counts for a guild — consumed by
   * `TurnTakingEngine` to damp (ambient) or rescale the cadence floor
   * (proactive) when recent turns have mostly flopped. "Recent" window is
   * this store's call (currently: last `MAX_ENGAGEMENT_OUTCOMES_PER_GUILD`
   * outcomes per guild, enforced at write time — see `PostgresMemoryStore`)
   * — the consumer only reads aggregate counts and treats a low/zero sample
   * count as "no signal yet", never as an implicit 0% landed rate.
   */
  getRecentEngagementStats(guildId: string): Promise<{ landed: number; flopped: number }>;

  close(): Promise<void>;
}
