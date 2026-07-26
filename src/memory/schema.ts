/**
 * Locked PostgreSQL DDL (ported from the original SQLite lock by Gollum) —
 * matches the Zod schemas in `types.ts` exactly (`UserMemoryProfileSchema`,
 * `GuildSettingsSchema`, `UsageLogEntrySchema`, `ConversationLogEntrySchema`).
 * Table/column names, nullability, and enum CHECK constraints below are
 * final for v1, not a draft — same lock as the SQLite version, this is a
 * near-verbatim port, not a redesign.
 *
 * Schema-lock decision — JSON columns vs. normalized child tables (kept from
 * the SQLite version, still applies): `facts_json`/`running_jokes_json`
 * stay JSON-encoded columns (JSONB here — Postgres's native, indexable JSON
 * type; TEXT-with-JSON.parse was a SQLite-only limitation), NOT a
 * normalized `user_facts` child table. Reasoning: these lists are short,
 * always read/written as a whole per profile (no per-item query/filter
 * requirement in v1), and a child table would only pay for itself if we
 * later need per-fact timestamps or cross-user fact search — flagged as a
 * possible v2 migration, not needed now. The real risk of JSON-blob storage
 * (unbounded growth since there's no per-row deletion) is closed by
 * `MAX_FACTS_PER_PROFILE`/`MAX_RUNNING_JOKES_PER_PROFILE`
 * (config/constants.ts), enforced both in the Zod schema and in
 * `postgresStore.ts#dedupeAppend` (truncates to the newest N on every write).
 *
 * Type notes vs. the SQLite DDL (Postgres has native types SQLite doesn't):
 * - Timestamp columns (`*_at`, epoch milliseconds) are `BIGINT` instead of
 *   SQLite's untyped `INTEGER` — same semantics, just an actually-enforced
 *   width.
 * - `opted_out` / `is_final` are native `BOOLEAN` instead of SQLite's
 *   `INTEGER 0/1` — the Zod<->row mappers in `postgresStore.ts` read/write
 *   real booleans now, no `!!row.opted_out` coercion needed.
 * - `facts_json` / `running_jokes_json` are `JSONB` instead of `TEXT` — same
 *   column names (minimizes churn in `rowToProfile`/`rowToSettings`), but
 *   the driver hands back parsed JS values directly, no `JSON.parse` needed
 *   on read (still `JSON.stringify`... actually not even that — `pg` accepts
 *   JS arrays directly for jsonb params).
 * - `ON CONFLICT ... DO UPDATE` upsert syntax is identical to SQLite's —
 *   verbatim port for `user_profiles`/`guild_settings`.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profiles (
  guild_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  facts_json        JSONB NOT NULL DEFAULT '[]',
  running_jokes_json JSONB NOT NULL DEFAULT '[]',
  sentiment_notes   TEXT,
  last_interaction_at BIGINT NOT NULL,
  opted_out         BOOLEAN NOT NULL DEFAULT FALSE,
  consent_accepted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Live DB already has user_profiles from before consent_accepted existed —
-- CREATE TABLE IF NOT EXISTS above is a no-op against that existing table,
-- so the column needs a real ALTER too (Postgres supports IF NOT EXISTS on
-- ADD COLUMN natively, unlike SQLite). Flagged for Sam/Merry's opt-in-button
-- work — schema only, not wired to gating logic here.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS consent_accepted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id                   TEXT PRIMARY KEY,
  mode                       TEXT NOT NULL DEFAULT 'active' CHECK (mode IN ('active', 'quiet')),
  max_responses_per_minute   INTEGER NOT NULL,
  min_gap_seconds            INTEGER NOT NULL,
  stt_confidence_threshold   REAL NOT NULL,
  allow_ambient_barge_in     BOOLEAN NOT NULL DEFAULT FALSE,
  voice_id                   TEXT,
  consent_channel_id         TEXT,
  updated_at                 BIGINT NOT NULL
);

-- Same live-DB-already-exists situation as user_profiles above.
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS consent_channel_id TEXT;


-- Rolling raw transcript log. Text only — never raw audio (brief section 8).
-- Pruned via pruneOldLogs(); this is NOT the durable memory (that's user_profiles).
CREATE TABLE IF NOT EXISTS conversation_log (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  text          TEXT NOT NULL,
  is_final      BOOLEAN NOT NULL,
  confidence    REAL NOT NULL,
  started_at    BIGINT NOT NULL,
  ended_at      BIGINT NOT NULL,
  logged_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_log_guild_time ON conversation_log (guild_id, started_at);

-- Per-service usage, for the "$20-30/mo" cost audit requirement (brief section 7).
CREATE TABLE IF NOT EXISTS usage_log (
  id           TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  service      TEXT NOT NULL CHECK (service IN ('stt', 'llm', 'tts')),
  unit_type    TEXT NOT NULL CHECK (unit_type IN ('characters', 'tokens')),
  units        BIGINT NOT NULL,
  occurred_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_log_guild_time ON usage_log (guild_id, occurred_at);

-- Adaptive-cadence learning signal (social-presence round, frodo's
-- MemoryStore.recordTurnOutcome/getRecentEngagementStats -- see types.ts's
-- TurnOutcomeSchema doc comment for the exact landed/flopped definitions).
-- Promoted off frodo's temporary in-process ring buffer to real persistence
-- this round (Sam) so the signal survives a bot restart. The id BIGSERIAL
-- column is this table's own addition (not in the original ring-buffer
-- shape) -- needed as a stable per-row handle for the retention DELETE
-- below, since (guild_id, occurred_at) isn't guaranteed unique (two
-- outcomes can resolve in the same millisecond).
--
-- Retention: unlike conversation_log (unbounded, manual pruneOldLogs, no
-- auto cron — documented gap in ARCHITECTURE.md), this table is actively
-- capped at write time, same "cap enforced at the write site" philosophy as
-- MAX_FACTS_PER_PROFILE's dedupeAppend truncation — every
-- PostgresMemoryStore#recordTurnOutcome call deletes back down to the newest
-- MAX_ENGAGEMENT_OUTCOMES_PER_GUILD (config/constants.ts) rows for that
-- guild right after inserting. Chosen over a passive/manual prune because
-- this table, unlike conversation_log, has no reason to ever keep more than
-- the last N rows per guild — nothing here is an audit/compliance log.
CREATE TABLE IF NOT EXISTS turn_outcomes (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('landed', 'flopped')),
  occurred_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_outcomes_guild_time ON turn_outcomes (guild_id, occurred_at DESC);
`;
