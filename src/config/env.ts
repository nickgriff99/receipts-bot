import "dotenv/config";
import { z } from "zod";
import { AppConfigSchema, type AppConfig } from "./types";
import { logger } from "../shared/logger";

const log = logger.child("config:env");

/**
 * Fail-fast env loader — `AppConfigSchema.parse(process.env)` validates
 * and coerces every required key at boot, instead of the previous
 * silent-empty-string-default behavior. A missing required key (Discord
 * token, Anthropic/Deepgram/ElevenLabs API keys, ElevenLabs voice id) now
 * crashes the process immediately with a readable list of what's missing,
 * rather than surfacing as a confusing 401/undefined deep inside a
 * Discord gateway callback at runtime.
 */
export function loadConfig(): AppConfig {
  const result = AppConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = formatZodIssues(result.error);
    log.error("invalid configuration — see .env.example for required keys", { issues });
    // Also plain console.error: this is a boot-time fatal before LOG_LEVEL
    // itself is even validated, so the structured `log.error` above may be
    // suppressed by whatever the (possibly-invalid) ambient LOG_LEVEL is.
    console.error(
      `\nInvalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\nSee .env.example for the full list of required keys.\n`,
    );
    process.exit(1);
  }
  return result.data;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
}
