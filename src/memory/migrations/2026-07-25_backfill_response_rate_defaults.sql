-- PROPOSED — NOT APPLIED. Owner must confirm before running against live DB.
--
-- Context: DEFAULT_MAX_RESPONSES_PER_MINUTE 5->8 and DEFAULT_MIN_GAP_SECONDS
-- 10->6 env defaults only affect brand-new guild_settings rows (see
-- postgresStore.ts#getGuildSettings — on cache miss it INSERTs the
-- code-level `defaults` object as literal column values, not NULL; the
-- guild_settings DDL in schema.ts has NO `DEFAULT` clause on these two
-- columns, so Postgres never re-derives them). Existing guild rows already
-- have 5/10 hard-written and will NOT pick up the new env defaults.
--
-- This backfill only touches rows still sitting at the OLD default pair
-- (5 AND 10 together) — a guild that has ever been intentionally moved to
-- a *different* custom pair is left alone. There is currently no slash
-- command that lets an admin set these two columns (checked
-- src/discord/commands/*.ts: join, leave, quiet, active, mode, optin,
-- optout, setConsentChannel — none touch max_responses_per_minute /
-- min_gap_seconds), so today every row at 5/10 got there via the
-- code-level fallback, never a deliberate admin choice.
--
-- Run manually (e.g. `psql $DATABASE_URL -f this_file.sql`) — NOT wired
-- into schema.ts's SCHEMA_SQL (that string re-runs on every process boot;
-- splicing an UPDATE in there would make this a standing trap that could
-- silently re-stomp a future admin's deliberate 5/10 choice if a
-- rate-config command is ever added later).

UPDATE guild_settings
SET max_responses_per_minute = 8,
    min_gap_seconds = 6,
    updated_at = EXTRACT(EPOCH FROM now())::bigint * 1000
WHERE max_responses_per_minute = 5
  AND min_gap_seconds = 10;
