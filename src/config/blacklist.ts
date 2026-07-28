/**
 * Deterministic, config-driven banned-phrase safety backstop (persona round,
 * task 2). Distinct from `llm/persona.ts`'s "never genuinely mean / never
 * target real sensitive traits" instruction — that's a PROMPT ask, which a
 * model can still fail to follow. This list is enforced in code
 * (`llm/sanitize.ts#sanitizeSpokenText`), checked against every final
 * response text regardless of which parse path produced it (see
 * `claudeProvider.ts#generateResponse`), so a bad completion is dropped
 * (never spoken) rather than merely discouraged.
 *
 * Match semantics: case-insensitive substring, whole-utterance drop on any
 * hit (not partial redaction) — see `sanitizeSpokenText`'s doc comment for
 * why a partial redaction is worse than silence here (what's left after
 * cutting one phrase out of a sentence can still read as endorsing/
 * completing it).
 *
 * v1 scope, deliberately small: a couple of unambiguous self-harm-adjacent
 * phrases as a real, functioning example of the backstop — NOT a general
 * slur/hate-speech list. Guessing at a "complete" list of slurs and shipping
 * it as code is worse than not shipping one: it reads as an authoritative
 * moderation policy the owner never actually reviewed, and an incomplete
 * guessed list gives false confidence. Extend this array with your own
 * guild's actual moderation terms; not DB-backed / not per-guild yet
 * (flagged in the round handoff as a natural follow-up once there's a real
 * admin surface to manage it through, same "config file now, admin UI
 * later" trajectory as everything else in this project's v1).
 */
export const DEFAULT_BLACKLIST: readonly string[] = ["kill yourself", "kys"];
