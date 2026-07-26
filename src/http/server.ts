/**
 * HTTP module boundary — small Express app running in-process alongside
 * the Discord bot (same process, not a separate deploy). Two surfaces:
 * `/health` (public liveness/readiness) and `/admin/*` (operator routes,
 * auth stubbed for Boromir — see `routes/admin.ts`).
 *
 * `buildHttpApp` wires routes to their dependencies (currently just
 * `memory`); `startHttpServer` binds a port and returns the `http.Server`
 * handle so `src/index.ts#shutdown` can close it cleanly alongside
 * `memory.close()`.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "http";
import type { MemoryStore } from "../memory/types";
import { logger } from "../shared/logger";
import { buildHealthRouter } from "./routes/health";
import { buildAdminRouter } from "./routes/admin";

const log = logger.child("http:server");

/**
 * Sentinel guild id for the health-check query — guaranteed not to match a
 * real guild, so `getUsageSince` returns an empty/zeroed result with no
 * side effects. Deliberately reuses the existing `MemoryStore` interface
 * (a real network round-trip against `usage_log`, indexed on
 * `(guild_id, occurred_at)` — see memory/schema.ts — so it's cheap) instead
 * of opening a second `pg.Pool` just to run a literal `SELECT 1`.
 */
const HEALTH_CHECK_GUILD_ID = "__http_health_check__";

export interface HttpAppDeps {
  memory: MemoryStore;
  /** e.g. `config.defaults.mode` — surfaced in `/health` for quick eyeballing. */
  mode: string;
  /** `config.http.adminApiToken` — threaded to `/admin/*` auth, see routes/admin.ts. */
  adminApiToken: string;
}

export function buildHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.use(express.json());
  // express.json() throws a SyntaxError on malformed bodies — surface as a
  // clean 400 instead of Express's default HTML error page / a 500.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    next(err);
  });

  const checkDb = async (): Promise<boolean> => {
    try {
      await deps.memory.getUsageSince(HEALTH_CHECK_GUILD_ID, Date.now());
      return true;
    } catch (err) {
      log.warn("db health check failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  app.use("/health", buildHealthRouter({ checkDb, mode: deps.mode }));
  app.use("/admin", buildAdminRouter({ memory: deps.memory, adminApiToken: deps.adminApiToken }));

  // Fallback error handler so an unexpected throw never leaks a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error("unhandled http error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

export function startHttpServer(app: Express, port: number): Server {
  const server = app.listen(port, () => {
    log.info("http server listening", { port });
  });
  return server;
}
