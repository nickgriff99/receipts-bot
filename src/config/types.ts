import { z } from "zod";
import {
  FALLBACK_MAX_RESPONSES_PER_MINUTE,
  FALLBACK_MIN_GAP_SECONDS,
  FALLBACK_STT_CONFIDENCE_THRESHOLD,
  FALLBACK_ALLOW_AMBIENT_BARGE_IN,
  FALLBACK_AUTO_JOIN_ON_USER_ENTRY,
} from "./constants";

/**
 * Config module boundary.
 *
 * `AppConfig` is the process-wide env-derived config (loaded once at
 * startup, effectively immutable) — validated by `AppConfigSchema.parse`
 * directly against `process.env` for fail-fast boot errors (env.ts).
 * `GuildSettings` (memory/types.ts) is the per-guild, DB-backed,
 * admin-mutable config (via /quiet, /active, future settings commands) —
 * a DIFFERENT contract with its own schema, validating rows read from /
 * written to PostgreSQL.
 */

export const BotModeSchema = z.enum(["active", "quiet"]);
export type BotMode = z.infer<typeof BotModeSchema>;

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/**
 * A boolean env flag is a raw string like "true"/"false"/"1"/"0" or unset —
 * NOT z.coerce.boolean(), which coerces any non-empty string (including the
 * literal string "false") to `true`. That footgun would silently invert the
 * `allowAmbientBargeIn` barge-in-safety default, so it gets an explicit
 * preprocess step instead.
 */
function boolEnvFlag(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return value; // let z.boolean() reject anything unrecognized
  }, z.boolean());
}

/**
 * Flat schema over `process.env` (every value is `string | undefined`
 * before Zod coercion/defaults run), transformed into the nested
 * `AppConfig` shape the rest of the app consumes. Locked defaults below
 * bake in the stakeholder decisions from the brief: model
 * `claude-haiku-4-5-20251001`, default mode `active` (ambient), and
 * conservative rate-limit defaults sized for the ~$20-30/mo budget
 * ceiling (max 5 responses/min per guild, 10s min gap) — all still
 * overridable via env for a given deployment.
 */
export const AppConfigSchema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
    DISCORD_APPLICATION_ID: z.string().min(1, "DISCORD_APPLICATION_ID is required"),
    DISCORD_DEV_GUILD_IDS: z.string().optional().default(""),

    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),

    DEEPGRAM_API_KEY: z.string().min(1, "DEEPGRAM_API_KEY is required"),

    ELEVENLABS_API_KEY: z.string().min(1, "ELEVENLABS_API_KEY is required"),
    ELEVENLABS_VOICE_ID: z.string().min(1, "ELEVENLABS_VOICE_ID is required"),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    /** Port for the in-process Express admin/health HTTP server (src/http/server.ts). */
    HTTP_PORT: z.coerce.number().int().positive().max(65535).default(3000),

    /**
     * Shared-secret bearer token gating `/admin/*` (src/http/routes/admin.ts).
     * No per-user accounts exist in this bot, so a single strong static
     * token compared with `crypto.timingSafeEqual` is the right scope here
     * — not a placeholder to relax later, an actual random 32+ char secret
     * the operator generates (e.g. `openssl rand -hex 32`).
     */
    ADMIN_API_TOKEN: z.string().min(32, "ADMIN_API_TOKEN must be at least 32 characters"),

    DEFAULT_MODE: BotModeSchema.default("active"),
    // Budget ceiling ~$20-30/mo (brief): these are the conservative
    // defaults that make ambient/active mode affordable — the cheap-gate
    // is the primary cost lever, this rate limiter is the hard backstop.
    DEFAULT_MAX_RESPONSES_PER_MINUTE: z.coerce.number().int().positive().default(FALLBACK_MAX_RESPONSES_PER_MINUTE),
    DEFAULT_MIN_GAP_SECONDS: z.coerce.number().int().nonnegative().default(FALLBACK_MIN_GAP_SECONDS),
    DEFAULT_STT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(FALLBACK_STT_CONFIDENCE_THRESHOLD),
    DEFAULT_ALLOW_AMBIENT_BARGE_IN: boolEnvFlag(FALLBACK_ALLOW_AMBIENT_BARGE_IN),
    /**
     * ADDITIVE (Merry, wiring round): brief section 1 asks for "configurable
     * auto-join-on-user-entry" but no config knob existed for it yet. This
     * is process-wide only (not a per-guild `guild_settings` column, to
     * avoid touching Sam's locked DDL/CHECK constraints for a v1-scope
     * feature) — flagged here rather than silently deciding a per-guild
     * override wasn't needed; revisit as a `guild_settings` migration if
     * per-guild control is actually requested.
     */
    DEFAULT_AUTO_JOIN_ON_USER_ENTRY: boolEnvFlag(FALLBACK_AUTO_JOIN_ON_USER_ENTRY),

    LOG_LEVEL: LogLevelSchema.default("info"),
  })
  .transform((env) => ({
    discord: {
      botToken: env.DISCORD_BOT_TOKEN,
      applicationId: env.DISCORD_APPLICATION_ID,
      devGuildIds: env.DISCORD_DEV_GUILD_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL, // expected: "claude-haiku-4-5-20251001"
    },
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY,
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY,
      defaultVoiceId: env.ELEVENLABS_VOICE_ID,
    },
    storage: {
      databaseUrl: env.DATABASE_URL,
    },
    http: {
      port: env.HTTP_PORT,
      adminApiToken: env.ADMIN_API_TOKEN,
    },
    defaults: {
      mode: env.DEFAULT_MODE,
      maxResponsesPerMinute: env.DEFAULT_MAX_RESPONSES_PER_MINUTE,
      minGapSeconds: env.DEFAULT_MIN_GAP_SECONDS,
      sttConfidenceThreshold: env.DEFAULT_STT_CONFIDENCE_THRESHOLD,
      allowAmbientBargeIn: env.DEFAULT_ALLOW_AMBIENT_BARGE_IN,
      autoJoinOnUserEntry: env.DEFAULT_AUTO_JOIN_ON_USER_ENTRY,
    },
    logLevel: env.LOG_LEVEL,
  }));

export type AppConfig = z.infer<typeof AppConfigSchema>;
