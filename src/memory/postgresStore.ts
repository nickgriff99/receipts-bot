import { Pool, types } from "pg";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";
import { MAX_FACTS_PER_PROFILE, MAX_ENGAGEMENT_OUTCOMES_PER_GUILD } from "../config/constants";
import { SCHEMA_SQL } from "./schema";
import type {
  MemoryStore,
  UserMemoryProfile,
  GuildSettings,
  ConversationLogEntry,
  UsageLogEntry,
  UsageService,
  TurnOutcome,
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
      updatedAt: Date.now(),
    };

    await this.pool.query(
      `INSERT INTO guild_settings
        (guild_id, mode, max_responses_per_minute, min_gap_seconds, stt_confidence_threshold, allow_ambient_barge_in, voice_id, consent_channel_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (guild_id) DO UPDATE SET
         mode = excluded.mode,
         max_responses_per_minute = excluded.max_responses_per_minute,
         min_gap_seconds = excluded.min_gap_seconds,
         stt_confidence_threshold = excluded.stt_confidence_threshold,
         allow_ambient_barge_in = excluded.allow_ambient_barge_in,
         voice_id = excluded.voice_id,
         consent_channel_id = excluded.consent_channel_id,
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
        merged.updatedAt,
      ],
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
    const usage: Record<UsageService, number> = { stt: 0, llm: 0, tts: 0 };
    for (const row of result.rows) usage[row.service] = Number(row.total);
    return usage;
  }

  async recordTurnOutcome(guildId: string, outcome: TurnOutcome, occurredAt: number): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO turn_outcomes (guild_id, outcome, occurred_at) VALUES ($1, $2, $3)`,
      [guildId, outcome, occurredAt],
    );
    // Retention: cap enforced at the write site (see schema.ts's turn_outcomes
    // comment) — keep only the newest MAX_ENGAGEMENT_OUTCOMES_PER_GUILD rows
    // for this guild, same semantics as frodo's original in-process ring
    // buffer, just ported to a real DELETE instead of an array splice.
    await this.pool.query(
      `DELETE FROM turn_outcomes
       WHERE guild_id = $1
         AND id NOT IN (
           SELECT id FROM turn_outcomes WHERE guild_id = $1 ORDER BY occurred_at DESC LIMIT $2
         )`,
      [guildId, MAX_ENGAGEMENT_OUTCOMES_PER_GUILD],
    );
  }

  async getRecentEngagementStats(guildId: string): Promise<{ landed: number; flopped: number }> {
    await this.ready;
    // LIMIT here is defense-in-depth, not the primary bound (recordTurnOutcome's
    // DELETE already keeps this table at <= MAX_ENGAGEMENT_OUTCOMES_PER_GUILD
    // rows per guild) — cheap insurance against reading a stale/over-grown
    // set if a prune ever fails to run.
    const result = await this.pool.query<{ outcome: TurnOutcome }>(
      `SELECT outcome FROM turn_outcomes WHERE guild_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
      [guildId, MAX_ENGAGEMENT_OUTCOMES_PER_GUILD],
    );
    let landed = 0;
    let flopped = 0;
    for (const row of result.rows) {
      if (row.outcome === "landed") landed++;
      else flopped++;
    }
    return { landed, flopped };
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
 * Dedupe + cap to the newest `MAX_FACTS_PER_PROFILE` entries. This is the
 * enforcement point for the JSON-column schema-lock decision (schema.ts):
 * since facts are stored as a whole-array JSON blob with no per-row
 * deletion, this truncation is what actually keeps the column bounded —
 * without it, "read/write whole list" storage would grow forever (brief
 * section 5's "periodic pruning" requirement). Ported verbatim from
 * `sqliteStore.ts`.
 */
function dedupeAppend(existing: string[], additions: string[]): string[] {
  const set = new Set(existing);
  for (const fact of additions) set.add(fact);
  const merged = Array.from(set);
  if (merged.length <= MAX_FACTS_PER_PROFILE) return merged;
  return merged.slice(merged.length - MAX_FACTS_PER_PROFILE);
}
