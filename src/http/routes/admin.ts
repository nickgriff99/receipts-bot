/**
 * `/admin/*` — guild settings + usage inspection for operators.
 *
 * Auth: single shared-secret bearer token (`ADMIN_API_TOKEN`, config/types.ts)
 * compared in constant time. No per-user accounts exist in this bot, so a
 * static operator token is the right scope — not a session/JWT scheme.
 * Every route in this router passes through `requireAdminAuth`
 * (`router.use(requireAdminAuth(deps.adminApiToken))`) before reaching a
 * handler — fails closed: any header shape other than an exact
 * `Authorization: Bearer <token>` match is rejected.
 */
import { timingSafeEqual } from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { GuildSettingsSchema, type MemoryStore } from "../../memory/types";
import { logger } from "../../shared/logger";

const log = logger.child("http:admin");

export interface AdminRouterDeps {
  memory: MemoryStore;
  /** Shared-secret admin token (config.http.adminApiToken) — never logged. */
  adminApiToken: string;
}

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time compare of the bearer token against the expected secret.
 * `timingSafeEqual` throws on mismatched buffer lengths, so the length
 * check has to happen first — that leaks only the *length* of the
 * attacker-supplied token, never anything about the secret's content or
 * how many bytes matched, so it isn't a meaningful timing oracle here.
 */
function isValidBearerToken(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = header.slice(BEARER_PREFIX.length);
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.byteLength !== expectedBuf.byteLength) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Factory (not a bare middleware) so the expected token is threaded in via
 * `buildAdminRouter(deps)` like the rest of this file's dependencies,
 * rather than read from `process.env` directly inside the route module.
 * Missing/malformed auth -> generic 401, no detail on what was wrong
 * (no "token too short" / "prefix missing" distinction) so a caller can't
 * probe the expected shape of a valid credential.
 */
function requireAdminAuth(adminApiToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isValidBearerToken(req.headers.authorization, adminApiToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/**
 * Reuses the locked `GuildSettingsSchema` (memory/types.ts) rather than
 * hand-rolling new validation — `guildId` comes from the URL param, not
 * the body, and `updatedAt` is server-assigned, so both are stripped
 * before taking `.partial()` (a PUT here is a patch, any subset of the
 * remaining fields is valid).
 */
const GuildSettingsPatchSchema = GuildSettingsSchema.omit({
  guildId: true,
  updatedAt: true,
}).partial();

/** `?since=<unix ms>` — coerced + validated, default: last 24h. Never trusted raw. */
const UsageQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `express-serve-static-core`'s `ParamsDictionary` types every param as
 * `string | string[]` (to account for routes with repeated param names /
 * wildcards) — none of these routes have that, so a single `:guildId`
 * segment is always a plain string at runtime. This narrows the type
 * without a blind `as string` cast at every call site.
 */
function singleParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "");
}

/** Match the `env.ts#formatZodIssues` style: `path: message` strings. */
function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
}

export function buildAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  router.use(requireAdminAuth(deps.adminApiToken));

  router.get("/guilds/:guildId/settings", async (req: Request, res: Response) => {
    const guildId = singleParam(req.params.guildId);
    try {
      const settings = await deps.memory.getGuildSettings(guildId);
      res.json(settings);
    } catch (err) {
      log.error("failed to load guild settings", { guildId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  router.put("/guilds/:guildId/settings", async (req: Request, res: Response) => {
    const guildId = singleParam(req.params.guildId);
    const parsed = GuildSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: formatZodIssues(parsed.error) });
      return;
    }
    try {
      await deps.memory.setGuildSettings(guildId, parsed.data);
      const updated = await deps.memory.getGuildSettings(guildId);
      res.json(updated);
    } catch (err) {
      log.error("failed to update guild settings", { guildId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  router.get("/guilds/:guildId/usage", async (req: Request, res: Response) => {
    const guildId = singleParam(req.params.guildId);
    const parsedQuery = UsageQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: "invalid_query", issues: formatZodIssues(parsedQuery.error) });
      return;
    }
    const since = parsedQuery.data.since ?? Date.now() - ONE_DAY_MS;
    try {
      const usage = await deps.memory.getUsageSince(guildId, since);
      res.json({ guildId, since, usage });
    } catch (err) {
      log.error("failed to load usage", { guildId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "internal_error" });
    }
  });

  return router;
}
