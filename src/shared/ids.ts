import { randomUUID } from "node:crypto";

/**
 * Generates a unique id for internal objects (transcript segments, turn
 * candidates, usage log rows, etc). Uses Node's built-in crypto instead of
 * pulling `uuid` into every module — `uuid` dep is kept for anywhere Sam's
 * Zod schemas want a branded/validated UUID string type.
 */
export function newId(): string {
  return randomUUID();
}
