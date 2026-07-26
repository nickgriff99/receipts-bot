/**
 * `GET /health` — public liveness/readiness probe. No auth (deliberately —
 * load balancers/orchestrators hit this before any credential exchange).
 *
 * Reflects real health, not just "process is alive": exercises a real
 * round-trip against Postgres via `checkDb`. Callers of `buildHealthRouter`
 * are expected to wire `checkDb` to something that actually touches the
 * pool (see `src/http/server.ts` for the wiring — it reuses
 * `MemoryStore#getUsageSince` against a guild id that will never exist as
 * a cheap, side-effect-free real query, rather than opening a second
 * `pg.Pool` just for a literal `SELECT 1`).
 */
import { Router } from "express";

export interface HealthCheckDeps {
  checkDb: () => Promise<boolean>;
  mode: string;
}

export function buildHealthRouter(deps: HealthCheckDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const dbOk = await deps.checkDb();
    const body = {
      status: dbOk ? "ok" : "degraded",
      uptime: process.uptime(),
      mode: deps.mode,
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  return router;
}
