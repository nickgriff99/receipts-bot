/**
 * REMOVED — this project migrated its memory/persistence layer from
 * `better-sqlite3` to PostgreSQL (`pg`). See `postgresStore.ts` for the
 * replacement (`PostgresMemoryStore implements MemoryStore`) and
 * `schema.ts` for the ported DDL.
 *
 * This file is intentionally left as an empty tombstone rather than
 * deleted — the sandbox this migration was authored in does not permit
 * file deletion (`rm`/`del` denied). No code in this repo imports from
 * this file anymore (`memory/index.ts` now re-exports `postgresStore`
 * instead); the `better-sqlite3` / `@types/better-sqlite3` dependencies
 * have been removed from `package.json`, so this file must not contain
 * any code that imports them, or `npm install`/`tsc` would fail.
 *
 * Safe to actually delete this file by hand (`git rm src/memory/sqliteStore.ts`)
 * whenever convenient — nothing in the codebase depends on it.
 */
export {};
