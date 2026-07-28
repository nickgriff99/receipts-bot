import { Pool, types } from "pg";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";
import {
  MAX_FACTS_PER_PROFILE,
  MAX_ENGAGEMENT_OUTCOMES_PER_GUILD,
  MAX_GUILD_RUNNING_JOKES,
  LIVE_CONTEXT_OVERRIDE_DEFAULT_TTL_MS,
  LIVE_CONTEXT_OVERRIDE_MAX_TTL_MS,
} from "../config/constants";
import { SCHEMA_SQL } from "./schema";
import type {
  MemoryStore,
  UserMemoryProfile,
  GuildSettings,
  GuildMemory,
  ConversationLogEntry,
  UsageLogEntry,
  UsageService,
  TurnOutcome,
  TurnOutcomeCategory,
  EngagementBucket,
} from "./types";
import type { BotMode } from "../config/types";

const log = logger.child("memory:postgres");

/**
 * `pg` returns BIGINT/INT8 columns as JS strings by default (avoids silent
 * precision loss for values outside `Number.MAX_SAFE_INTEGER`). Every
 * BIGINT column in this schema is an epoch-millisecond timestamp or a
 * usage-unit count — both comfortably inside safe-integer range — so this
 * project wants plain `number`s, not strings, matching the Zod schemas
 * (`z.number().int()...`) and the old SQLite implementation's behavior
 * (better-sqlite3 returned plain numbers). Set once, module-load time, not
 * per-query.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => parseInt(value, 10));

interface UserProfileRow {
  guild_id: string;
  user_id: string;
  display_name: string;
  facts_json: unknown;
  running_jokes_json: unknown;
  sentiment_notes: string | null;
  last_interaction_at: number;
  opted_out: boolean;
  consent_accepted: boolean;
  created_at: number;
  updated_at: number;
}

interface GuildSettingsRow {
  guild_id: string;
  mode: string;
  max_responses_per_minute: number;
  min_gap_seconds: number;
  stt_confidence_threshold: number;
  allow_ambient_barge_in: boolean;
  voice_id: string | null;
  consent_channel_id: string | null;
  max_explicit_responses_per_minute: number | null;
  live_context_override: string | null;
  live_context_override_expires_at: number | null;
  updated_at: number;
}

interface GuildMemoryRow {
  guild_id: string;
  running_jokes_json: unknown;
  updated_at: number;
}

export interface PostgresMemoryStoreDefaults {
  mode: BotMode;
  maxResponsesPerMinute: number;
  minGapSeconds: number;
  sttConfidenceThreshold: number;
  allowAmbientBargeIn: boolean;
}

/**
 * `pg`-backed implementation of MemoryStore — replaces the SQLite-backed
 * `SqliteMemoryStore` (see memory/schema.ts for the DDL port writeup, and
 * memory/types.ts for the sync->async interface migration this required).
 *
 * No ORM (project constraint) — plain parameterized SQL (`$1, $2, ...`)
 * against the `pg` `Pool` API directly. `ON CONFLICT ... DO UPDATE` upsert
 * semantics and the `dedupeAppend` cap-and-truncate logic are ported
 * verbatim from the SQLite version.
 */
export class PostgresMemoryStore implements MemoryStore {
  private readonly pool: Pool;
  private readonly defaults: PostgresMemoryStoreDefaults;
  /**
   * Schema migration ("CREATE TABLE IF NOT EXISTS ...", same pattern as the
   * old `db.exec(SCHEMA_SQL)`) kicked off at construction time, same as
   * before — but `pg` is async so it can't finish before the constructor
   * returns. Every public method awaits this first, so callers don't need
   * a separate async-init step and can't race the schema.
   */
  private readonly ready: Promise<void>;

  constructor(connectionString: string, defaults: PostgresMemoryStoreDefaults) {
    this.pool = new Pool({ connectionString });
    this.defaults = defaults;
    this.ready = this.pool.query(SCHEMA_SQL).then(
      () => {
        log.info("postgres store ready");
      },
      (err) => {
        log.error("postgres schema migration failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
  }

  async getProfile(guildId: string, userId: string): Promise<UserMemoryProfile | undefined> {
    await this.ready;
    const result = await this.pool.query<UserProfileRow>(
      `SELECT * FROM user_profiles WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId],
    );
    const row = result.rows[0];
    return row ? rowToProfile(row) : undefined;
  }

  async upsertProfile(profile: UserMemoryProfile): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO user_profiles
        (guild_id, user_id, display_name, facts_json, running_jokes_json, sentiment_notes, last_interaction_at, opted_out, consent_accepted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         display_name = excluded.display_name,
         facts_json = excluded.facts_json,
         running_jokes_json = excluded.running_jokes_json,
         sentiment_notes = excluded.sentiment_notes,
         last_interaction_at = excluded.last_interaction_at,
         opted_out = excluded.opted_out,
         consent_accepted = excluded.consent_accepted,
         updated_at = excluded.updated_at`,
      [
        profile.guildId,
        profile.userId,
        profile.displayName,
        JSON.stringify(profile.facts),
        JSON.stringify(profile.runningJokes),
        profile.sentimentNotes ?? null,
        profile.lastInteractionAt,
        profile.optedOut,
        profile.consentAccepted,
        profile.createdAt,
        profile.updatedAt,
      ],
    );
  }

  async appendFacts(guildId: string, userId: string, facts: string[]): Promise<void> {
    if (facts.length === 0) return;
    const existing = await this.getProfile(guildId, userId);
    const now = Date.now();
    const merged: UserMemoryProfile = existing
      ? { ...existing, facts: dedupeAppend(existing.facts, facts), updatedAt: now, lastInteractionAt: now }
      : {
          guildId,
          userId,
          displayName: userId,
          facts,
          runningJokes: [],
          optedOut: false,
          consentAccepted: false,
          createdAt: now,
          updatedAt: now,
          lastInteractionAt: now,
        };
    await this.upsertProfile(merged);
  }

  async isOptedOut(guildId: string, userId: string): Promise<boolean> {
    const profile = await this.getProfile(guildId, userId);
    return profile?.optedOut ?? false;
  }

  async setOptOut(guildId: string, userId: string, optedOut: boolean): Promise<void> {
    const existing = await this.getProfile(guildId, userId);
    const now = Date.now();
    const profile: UserMemoryProfile = existing
      ? { ...existing, optedOut, updatedAt: now }
      : {
          guildId,
          userId,
          displayName: userId,
          facts: [],
          runningJokes: [],
          optedOut,
          consentAccepted: false,
          createdAt: now,
          updatedAt: now,
          lastInteractionAt: now,
        };
    await this.upsertProfile(profile);
  }

  async hasAcceptedConsent(guildId: string, userId: string): Promise<boolean> {
    const profile = await this.getProfile(guildId, userId);
    return profile?.consentAccepted ?? false;
  }

  async setConsentAccepted(guildId: string, userId: string, accepted: boolean): Promise<void> {
    const existing = await this.getProfile(guildId, userId);
    const now = Date.now();
    const profile: UserMemoryProfile = existing
      ? { ...existing, consentAccepted: accepted, updatedAt: now }
      : {
          guildId,
          userId,
          displayName: userId,
          facts: [],
          runningJokes: [],
          optedOut: false,
          consentAccepted: accepted,
          createdAt: now,
          updatedAt: now,
          lastInteractionAt: now,
        };
    await this.upsertProfile(profile);
  }

  async getGuildSettings(guildId: string): Promise<GuildSettings> {
    await this.ready;
    const result = await this.pool.query<GuildSettingsRow>(`SELECT * FROM guild_settings WHERE guild_id = $1`, [guildId]);
    const row = result.rows[0];
    if (row) return rowToSettings(row);

    const fallback: GuildSettings = {
      guildId,
      mode: this.defaults.mode,
      maxResponsesPerMinute: this.defaults.maxResponsesPerMinute,
      minGapSeconds: this.defaults.minGapSeconds,
      sttConfidenceThreshold: this.defaults.sttConfidenceThreshold,
      allowAmbientBargeIn: this.defaults.allowAmbientBargeIn,
      updatedAt: Date.now(),
    };
    await this.setGuildSettings(guildId, fallback);
    return fallback;
  }

  async setGuildSettings(guildId: string, patch: Partial<Omit<GuildSettings, "guildId">>): Promise<void> {
    await this.ready;
    const current = (await this.hasGuildSettingsRow(guildId)) ? await this.getGuildSettings(guildId) : undefined;
    const merged: GuildSettings = {
      guildId,
      mode: patch.mode ?? current?.mode ?? this.defaults.mode,
      maxResponsesPerMinute: patch.maxResponsesPerMinute ?? current?.maxResponsesPerMinute ?? this.defaults.maxResponsesPerMinute,
      minGapSeconds: patch.minGapSeconds ?? current?.minGapSeconds ?? this.defaults.minGapSeconds,
      sttConfidenceThreshold: patch.sttConfidenceThreshold ?? current?.sttConfidenceThreshold ?? this.defaults.sttConfidenceThreshold,
      allowAmbientBargeIn: patch.allowAmbientBargeIn ?? current?.allowAmbientBargeIn ?? this.defaults.allowAmbientBargeIn,
      voiceId: patch.voiceId ?? current?.voiceId,
      consentChannelId: patch.consentChannelId ?? current?.consentChannelId,
      maxExplicitResponsesPerMinute: patch.maxExplicitResponsesPerMinute ?? current?.maxExplicitResponsesPerMinute,
      // Deliberately ignore patch.liveContextOverride/liveContextOverrideExpiresAt
      // entirely (never `patch.x ?? current?.x` like every other optional
      // override above) — these two fields have exactly one legitimate write
      // path, `setLiveContextOverride`/`clearLiveContextOverride` below, which
      // enforce the TTL cap. Letting the generic patch echo them through would
      // let a caller set an uncapped/unpaired override by going around that
      // logic. See GuildSettingsSchema's doc comment (memory/types.ts).
      liveContextOverride: current?.liveContextOverride,
      liveContextOverrideExpiresAt: current?.liveContextOverrideExpiresAt,
      updatedAt: Date.now(),
    };

    await this.pool.query(
      `INSERT INTO guild_settings
        (guild_id, mode, max_responses_per_minute, min_gap_seconds, stt_confidence_threshold, allow_ambient_barge_in, voice_id, consent_channel_id, max_explicit_responses_per_minute, live_context_override, live_context_override_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (guild_id) DO UPDATE SET
         mode = excluded.mode,
         max_responses_per_minute = excluded.max_responses_per_minute,
         min_gap_seconds = excluded.min_gap_seconds,
         stt_confidence_threshold = excluded.stt_confidence_threshold,
         allow_ambient_barge_in = excluded.allow_ambient_barge_in,
         voice_id = excluded.voice_id,
         consent_channel_id = excluded.consent_channel_id,
         max_explicit_responses_per_minute = excluded.max_explicit_responses_per_minute,
         live_context_override = excluded.live_context_override,
         live_context_override_expires_at = excluded.live_context_override_expires_at,
         updated_at = excluded.updated_at`,
      [
        merged.guildId,
        merged.mode,
        merged.maxResponsesPerMinute,
        merged.minGapSeconds,
        merged.sttConfidenceThreshold,
        merged.allowAmbientBargeIn,
        merged.voiceId ?? null,
        merged.consentChannelId ?? null,
        merged.maxExplicitResponsesPerMinute ?? null,
        merged.liveContextOverride ?? null,
        merged.liveContextOverrideExpiresAt ?? null,
        merged.updatedAt,
      ],
    );
  }

  /**
   * See `MemoryStore.setLiveContextOverride`'s doc comment for why this is a
   * dedicated method rather than routed through `setGuildSettings`. Ensures
   * a row exists first (via `getGuildSettings`'s existing fallback-insert
   * behavior), then updates only these two columns directly — never touches
   * any other guild setting, so this can't race a concurrent admin-settings
   * PATCH into clobbering unrelated fields.
   */
  async setLiveContextOverride(guildId: string, text: string, ttlMs?: number): Promise<void> {
    await this.ready;
    await this.getGuildSettings(guildId); // ensure a row exists
    const cappedTtlMs = Math.min(ttlMs ?? LIVE_CONTEXT_OVERRIDE_DEFAULT_TTL_MS, LIVE_CONTEXT_OVERRIDE_MAX_TTL_MS);
    const expiresAt = Date.now() + cappedTtlMs;
    await this.pool.query(
      `UPDATE guild_settings SET live_context_override = $1, live_context_override_expires_at = $2, updated_at = $3 WHERE guild_id = $4`,
      [text, expiresAt, Date.now(), guildId],
    );
  }

  async clearLiveContextOverride(guildId: string): Promise<void> {
    await this.ready;
    await this.getGuildSettings(guildId); // ensure a row exists
    await this.pool.query(
      `UPDATE guild_settings SET live_context_override = NULL, live_context_override_expires_at = NULL, updated_at = $1 WHERE guild_id = $2`,
      [Date.now(), guildId],
    );
  }

  async getGuildMemory(guildId: string): Promise<GuildMemory> {
    await this.ready;
    const result = await this.pool.query<GuildMemoryRow>(`SELECT * FROM guild_memory WHERE guild_id = $1`, [guildId]);
    const row = result.rows[0];
    if (row) return rowToGuildMemory(row);
    return { guildId, runningJokes: [], updatedAt: Date.now() };
  }

  async appendGuildRunningJokes(guildId: string, jokes: string[]): Promise<void> {
    if (jokes.length === 0) return;
    await this.ready;
    const existing = await this.getGuildMemory(guildId);
    const merged = dedupeAppend(existing.runningJokes, jokes, MAX_GUILD_RUNNING_JOKES);
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO guild_memory (guild_id, running_jokes_json, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id) DO UPDATE SET
         running_jokes_json = excluded.running_jokes_json,
         updated_at = excluded.updated_at`,
      [guildId, JSON.stringify(merged), now],
    );
  }

  private async hasGuildSettingsRow(guildId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM guild_settings WHERE guild_id = $1`, [guildId]);
    return (result.rowCount ?? 0) > 0;
  }

  async appendConversationLog(entry: ConversationLogEntry): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO conversation_log
        (id, guild_id, channel_id, user_id, display_name, text, is_final, confidence, started_at, ended_at, logged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.id,
        entry.guildId,
        entry.channelId,
        entry.userId,
        entry.displayName,
        entry.text,
        entry.isFinal,
        entry.confidence,
        entry.startedAt,
        entry.endedAt,
        entry.loggedAt,
      ],
    );
  }

  async pruneOldLogs(beforeTimestamp: number): Promise<number> {
    await this.ready;
    const result = await this.pool.query(`DELETE FROM conversation_log WHERE started_at < $1`, [beforeTimestamp]);
    return result.rowCount ?? 0;
  }

  async logUsage(entry: Omit<UsageLogEntry, "id">): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO usage_log (id, guild_id, service, unit_type, units, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), entry.guildId, entry.service, entry.unitType, entry.units, entry.occurredAt],
    );
  }

  async getUsageSince(guildId: string, sinceTimestamp: number): Promise<Record<UsageService, number>> {
    await this.ready;
    const result = await this.pool.query<{ service: UsageService; total: number }>(
      `SELECT service, SUM(units) as total FROM usage_log WHERE guild_id = $1 AND occurred_at >= $2 GROUP BY service`,
      [guildId, sinceTimestamp],
    );
    const usage: Record<UsageService, number> = { stt: 0, llm: 0, tts: 0, web_search: 0 };
    for (const row of result.rows) usage[row.service] = Number(row.total);
    return usage;
  }

  async recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number, category: TurnOutcomeCategory): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO turn_outcomes (guild_id, outcome, category, occurred_at) VALUES ($1, $2, $3, $4)`,
      [guildId, outcome, category, occurredAt],
    );
    // Retention: cap enforced at the write site (see schema.ts's turn_outcomes
    // comment) — keep only the newest MAX_ENGAGEMENT_OUTCOMES_PER_GUILD rows
    // PER (guild, category) now (conversation-continuity round), same
    // semantics as frodo's original in-process ring buffer, just ported to a
    // real DELETE instead of an array splice, and scoped per-category so one
    // noisy category (e.g. frequent ambient chatter) can't evict another's
    // (e.g. rarer interjection) history.
    await this.pool.query(
      `DELETE FROM turn_outcomes
       WHERE guild_id = $1
         AND category = $2
         AND id NOT IN (
           SELECT id FROM turn_outcomes WHERE guild_id = $1 AND category = $2 ORDER BY occurred_at DESC LIMIT $3
         )`,
      [guildId, category, MAX_ENGAGEMENT_OUTCOMES_PER_GUILD],
    );
  }

  async getRecentEngagementStats(
    guildId: string,
  ): Promise<{ overall: EngagementBucket; byCategory: Partial<Record<TurnOutcomeCategory, EngagementBucket>> }> {
    await this.ready;
    // LIMIT here is defense-in-depth, not the primary bound (recordTurnOutcome's
    // DELETE already keeps this table at <= MAX_ENGAGEMENT_OUTCOMES_PER_GUILD
    // rows per (guild, category)) — cheap insurance against reading a
    // stale/over-grown set if a prune ever fails to run. Bound is now
    // multiplied by the number of categories (4) since retention is
    // per-category, not per-guild, as of this round.
    const result = await this.pool.query<{ outcome: TurnOutcome; category: TurnOutcomeCategory }>(
      `SELECT outcome, category FROM turn_outcomes WHERE guild_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [guildId, MAX_ENGAGEMENT_OUTCOMES_PER_GUILD * 4],
    );
    const overall: EngagementBucket = { landed: 0, flopped: 0 };
    const byCategory: Partial<Record<TurnOutcomeCategory, EngagementBucket>> = {};
    for (const row of result.rows) {
      const bucket = byCategory[row.category] ?? (byCategory[row.category] = { landed: 0, flopped: 0 });
      if (row.outcome === "landed") {
        overall.landed++;
        bucket.landed++;
      } else {
        overall.flopped++;
        bucket.flopped++;
      }
    }
    return { overall, byCategory };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToProfile(row: UserProfileRow): UserMemoryProfile {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    displayName: row.display_name,
    facts: parseJsonbArray(row.facts_json),
    runningJokes: parseJsonbArray(row.running_jokes_json),
    sentimentNotes: row.sentiment_notes ?? undefined,
    lastInteractionAt: row.last_interaction_at,
    optedOut: row.opted_out,
    consentAccepted: row.consent_accepted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSettings(row: GuildSettingsRow): GuildSettings {
  return {
    guildId: row.guild_id,
    mode: row.mode === "quiet" ? "quiet" : "active",
    maxResponsesPerMinute: row.max_responses_per_minute,
    minGapSeconds: row.min_gap_seconds,
    sttConfidenceThreshold: row.stt_confidence_threshold,
    allowAmbientBargeIn: row.allow_ambient_barge_in,
    voiceId: row.voice_id ?? undefined,
    consentChannelId: row.consent_channel_id ?? undefined,
    maxExplicitResponsesPerMinute: row.max_explicit_responses_per_minute ?? undefined,
    liveContextOverride: row.live_context_override ?? undefined,
    liveContextOverrideExpiresAt: row.live_context_override_expires_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToGuildMemory(row: GuildMemoryRow): GuildMemory {
  return {
    guildId: row.guild_id,
    runningJokes: parseJsonbArray(row.running_jokes_json),
    updatedAt: row.updated_at,
  };
}

/**
 * `node-postgres` parses `jsonb` columns into real JS values automatically
 * (registered default type parser), so this is normally a no-op pass
 * through — but defends against a raw string ever showing up (e.g. a
 * future manual `::text` cast in a query) instead of trusting the shape
 * silently.
 */
function parseJsonbArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") return JSON.parse(value);
  return [];
}

/**
 * Dedupe + cap to the newest `cap` entries. This is the enforcement point
 * for the JSON-column schema-lock decision (schema.ts): since facts/jokes
 * are stored as a whole-array JSON blob with no per-row deletion, this
 * truncation is what actually keeps the column bounded — without it,
 * "read/write whole list" storage would grow forever (brief section 5's
 * "periodic pruning" requirement). Ported verbatim from `sqliteStore.ts`,
 * generalized (guild-jokes round) to take an explicit `cap` instead of
 * hardcoding `MAX_FACTS_PER_PROFILE` so `appendGuildRunningJokes` can reuse
 * the same logic against `MAX_GUILD_RUNNING_JOKES` instead.
 */
function dedupeAppend(existing: string[], additions: string[], cap: number = MAX_FACTS_PER_PROFILE): string[] {
  const set = new Set(existing);
  for (const fact of additions) set.add(fact);
  const merged = Array.from(set);
  if (merged.length <= cap) return merged;
  return merged.slice(merged.length - cap);
}
