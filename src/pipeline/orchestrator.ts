import type { TranscriptSegment } from "../stt/types";
import type { LLMProvider, PersonaConfig } from "../llm/types";
import type { TTSProvider } from "../tts/types";
import type { MemoryStore } from "../memory/types";
import type { PlaybackController, PlaybackPriority } from "../discord/types";
import type { RateLimiter } from "./types";
import type { TriggerType, TurnCandidate } from "./types";
import { isExplicitTrigger } from "./types";
import { TurnTakingEngine } from "./turnTaking";
import { ContextAssembler } from "./contextAssembler";
import { BOT_SPEAKER_ID, CONTEXT_WINDOW_UTTERANCES, LATENCY_WARN_THRESHOLD_MS } from "../config/constants";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:orchestrator");

/**
 * Per-guild turn queue state (concurrency fix — bugs/nazgul round).
 *
 * `handleSegment` used to be called fire-and-forget (bootstrap.ts) with no
 * serialization at all: every final transcript segment from any speaker
 * spawned a fresh concurrent run of the expensive tail (turn-taking decide
 * -> Claude generateResponse -> TTS synth -> playback -> Claude
 * extractMemoryFacts). With 2+ people talking, segments arrive faster than
 * one turn drains, so in-flight turns piled up unbounded on the single
 * Node event loop -> latency climbed turn over turn (3s -> 59s observed),
 * Discord interaction acks missed their ~3s window, Deepgram sockets
 * dropped from starved keepalives.
 *
 * Fix: at most one turn's expensive tail in flight per guild. A segment
 * that arrives while a turn is running for that guild does not spawn a
 * concurrent run and is not queued unboundedly either — it replaces
 * whatever was previously pending (bounded depth 1). The conversation has
 * moved on by the time a stale pending turn would run, so processing it
 * would be wasted latency/cost for a turn no longer relevant — better to
 * only ever run the most recent segment next. Cheap bookkeeping (history
 * append, conversation log, STT usage log) still happens synchronously for
 * every segment in `handleSegment` itself, before enqueueing — only the
 * expensive decide/generate/speak tail is serialized+deduped.
 */
interface GuildTurnQueue {
  running: boolean;
  pending: { segment: TranscriptSegment; triggerType: TriggerType } | null;
}

export interface OrchestratorDeps {
  llm: LLMProvider;
  tts: TTSProvider;
  memory: MemoryStore;
  playback: PlaybackController;
  rateLimiter: RateLimiter;
  persona: PersonaConfig;
  voiceId: string;
}

/**
 * Top-level pipeline orchestrator — the single place that wires:
 *
 *   TranscriptSegment (in, from STT via discord/voice/receiver.ts)
 *     -> turn-taking decision (explicit trigger OR ambient cheap-gate)
 *     -> [rate limiter]
 *     -> context assembly (transcript window + per-user memory + persona)
 *     -> LLM full response
 *     -> TTS streaming synthesis
 *     -> playback (with barge-in priority)
 *     -> post-hoc memory-fact extraction -> Postgres profile update
 *
 * Every dependency is injected via `OrchestratorDeps` so Merry can swap in
 * real Deepgram/Anthropic/ElevenLabs/Discord implementations without
 * touching this control flow. Nothing in this file imports a concrete
 * provider — only the interfaces from stt/llm/tts/memory/discord's
 * types.ts files.
 */
export class PipelineOrchestrator {
  private readonly turnTaking: TurnTakingEngine;
  private readonly contextAssembler: ContextAssembler;
  private readonly historyByGuild = new Map<string, TranscriptSegment[]>();
  private readonly turnQueueByGuild = new Map<string, GuildTurnQueue>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.turnTaking = new TurnTakingEngine(deps.llm, deps.rateLimiter, deps.memory);
    this.contextAssembler = new ContextAssembler(deps.memory);
  }

  /**
   * Entry point called once per FINAL transcript segment (partials are not
   * turn-taking candidates, though they may still be worth logging/showing
   * live elsewhere — that's discord/voice/receiver.ts's call, not this
   * method's). `triggerType` is decided upstream by whatever detected the
   * segment (explicit mention/reply/name-match text scan, or the natural-
   * pause ambient detector).
   */
  async handleSegment(segment: TranscriptSegment, triggerType: TriggerType): Promise<void> {
    // Safety-net check, mirroring the existing isOptedOut belt-and-braces
    // pattern below (see discord/commands/optout.ts's doc comment — STT/
    // turn-taking layers both check deliberately). Both current callers
    // (discord/bootstrap.ts's handleMessageCreate and handleTranscriptSegment)
    // already gate on hasAcceptedConsent before ever reaching here, so this
    // should never trip in the current call graph — it's here so a future
    // caller of handleSegment can't accidentally skip the consent gate.
    if (!(await this.deps.memory.hasAcceptedConsent(segment.guildId, segment.userId))) {
      log.debug("dropping segment from user who has not accepted consent", { guildId: segment.guildId, userId: segment.userId });
      return;
    }
    if (await this.deps.memory.isOptedOut(segment.guildId, segment.userId)) {
      log.debug("dropping segment from opted-out user", { guildId: segment.guildId, userId: segment.userId });
      return;
    }

    this.appendHistory(segment);
    await this.deps.memory.appendConversationLog({ ...segment, loggedAt: Date.now() });

    // STT usage audit trail (brief section 7). Deepgram actually bills by
    // audio-duration, not characters — this logs transcript character
    // count as an auditable activity proxy (the thing the SDK response
    // actually exposes per segment), not a literal dollar-cost mirror.
    // Flagged here rather than silently presented as exact.
    if (segment.isFinal && segment.text.length > 0) {
      await this.deps.memory.logUsage({
        guildId: segment.guildId,
        service: "stt",
        unitType: "characters",
        units: segment.text.length,
        occurredAt: Date.now(),
      });
    }

    // Expensive tail (turn-taking decision -> Claude -> TTS -> playback ->
    // memory extraction) is serialized per guild — see GuildTurnQueue doc
    // comment above. Not awaited here: callers (bootstrap.ts) only need the
    // cheap bookkeeping above to have happened before this method resolves,
    // same as before this fix (they never relied on `handleSegment`'s
    // promise resolving only once the bot finished speaking).
    this.enqueueTurn(segment, triggerType);
  }

  /**
   * Runs the given segment's turn immediately if none is in flight for its
   * guild, else stashes it as the (sole) pending turn for that guild,
   * dropping/replacing whatever was pending before.
   */
  private enqueueTurn(segment: TranscriptSegment, triggerType: TriggerType): void {
    const guildId = segment.guildId;
    let queue = this.turnQueueByGuild.get(guildId);
    if (!queue) {
      queue = { running: false, pending: null };
      this.turnQueueByGuild.set(guildId, queue);
    }

    if (queue.running) {
      // An already-queued explicit mention outranks an incoming ambient
      // segment — don't let it get silently clobbered before drain gets to
      // it (bugs/nazgul round: explicit name/pronoun mentions were being
      // dropped by the very next unrelated segment, well before
      // turnTaking.decide() ever saw them). Ambient-vs-ambient and
      // mention-vs-mention (or mention superseding a pending ambient) keep
      // the existing newest-wins behavior — only pending-mention vs.
      // incoming-ambient is special-cased.
      if (queue.pending && isExplicitTrigger(queue.pending.triggerType) && !isExplicitTrigger(triggerType)) {
        log.debug("rejecting incoming ambient segment — explicit mention already queued", { guildId });
        return;
      }
      if (queue.pending) {
        log.debug("dropping stale queued turn — superseded by newer segment", { guildId });
      }
      queue.pending = { segment, triggerType };
      return;
    }

    queue.running = true;
    void this.drainTurnQueue(guildId, queue, segment, triggerType);
  }

  /**
   * Runs turns for a guild one at a time until its pending slot is empty.
   * Errors from an individual turn are logged and do not stop the drain
   * (mirrors the `.catch()` logging bootstrap.ts used to do around the old
   * fire-and-forget `handleSegment` call).
   */
  private async drainTurnQueue(
    guildId: string,
    queue: GuildTurnQueue,
    firstSegment: TranscriptSegment,
    firstTriggerType: TriggerType,
  ): Promise<void> {
    let segment = firstSegment;
    let triggerType = firstTriggerType;
    for (;;) {
      try {
        await this.runTurn(segment, triggerType);
      } catch (err) {
        log.error("turn processing failed", {
          guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!queue.pending) break;
      ({ segment, triggerType } = queue.pending);
      queue.pending = null;
    }
    queue.running = false;
  }

  private async runTurn(segment: TranscriptSegment, triggerType: TriggerType): Promise<void> {
    const candidate: TurnCandidate = {
      guildId: segment.guildId,
      channelId: segment.channelId,
      triggerType,
      triggeringUserId: segment.userId,
      segments: this.historyFor(segment.guildId),
      detectedAt: Date.now(),
    };

    const decision = await this.turnTaking.decide(candidate, this.deps.persona);
    log.info("turn decision", {
      guildId: segment.guildId,
      triggerType,
      shouldRespond: decision.shouldRespond,
      reason: decision.reason,
    });

    if (!decision.shouldRespond) return;

    this.deps.rateLimiter.recordResponse(segment.guildId);

    const request = await this.contextAssembler.assemble(candidate, this.deps.persona, decision.reason, this.historyFor(segment.guildId));
    const response = await this.deps.llm.generateResponse(request);
    await this.deps.memory.logUsage({
      guildId: segment.guildId,
      service: "llm",
      unitType: "tokens",
      units: response.usage.inputTokens + response.usage.outputTokens,
      occurredAt: Date.now(),
    });

    // Empty text is a genuine "nothing to say" outcome (persona/parseLLMReply
    // fallback both allow it deliberately, see llm/types.ts) — skip TTS/
    // playback rather than synthesizing/playing a blank clip, but still run
    // memory extraction since the human side of the exchange still happened.
    if (response.text.trim().length === 0) {
      log.debug("empty LLM response — skipping TTS/playback", { guildId: segment.guildId });
      await this.extractAndPersistMemory(segment, candidate, response.text);
      return;
    }

    // Thread the bot's own reply back into transcript history so later turns
    // (ambient cheap-gate + generation) can see what it already said, avoid
    // repeating itself, and notice when the conversation has moved on.
    this.appendBotReply(segment, response.text);

    const speechEndAt = segment.endedAt;
    const priority: PlaybackPriority = isExplicitTrigger(triggerType) ? "explicit" : "ambient";

    await this.deps.memory.logUsage({
      guildId: segment.guildId,
      service: "tts",
      unitType: "characters",
      units: response.text.length,
      occurredAt: Date.now(),
    });

    const latencyMs = Date.now() - speechEndAt;
    if (latencyMs > LATENCY_WARN_THRESHOLD_MS) {
      log.warn("speech-end -> bot-starts-speaking latency exceeded threshold", {
        guildId: segment.guildId,
        latencyMs,
        thresholdMs: LATENCY_WARN_THRESHOLD_MS,
      });
    }

    try {
      const ttsStream = this.deps.tts.synthesizeStream({
        text: response.text,
        tone: response.tone,
        voiceId: this.deps.voiceId,
      });
      await this.deps.playback.play(segment.guildId, ttsStream, { priority });
    } catch (err) {
      log.error("TTS/playback failed — continuing without spoken reply", {
        guildId: segment.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this.extractAndPersistMemory(segment, candidate, response.text);
  }

  private async extractAndPersistMemory(segment: TranscriptSegment, candidate: TurnCandidate, botReplyText: string): Promise<void> {
    const existingProfile = await this.deps.memory.getProfile(segment.guildId, segment.userId);
    const extraction = await this.deps.llm.extractMemoryFacts({
      guildId: segment.guildId,
      userId: segment.userId,
      displayName: segment.displayName,
      exchange: candidate.segments,
      botReplyText,
      existingFacts: existingProfile?.facts ?? [],
    });
    await this.deps.memory.logUsage({
      guildId: segment.guildId,
      service: "llm",
      unitType: "tokens",
      units: extraction.usage.inputTokens + extraction.usage.outputTokens,
      occurredAt: Date.now(),
    });

    if (extraction.newFacts.length === 0 && !extraction.sentimentNotes) return;

    if (extraction.newFacts.length > 0) {
      await this.deps.memory.appendFacts(segment.guildId, segment.userId, extraction.newFacts);
    }
    if (extraction.sentimentNotes) {
      const profile = await this.deps.memory.getProfile(segment.guildId, segment.userId);
      if (profile) {
        await this.deps.memory.upsertProfile({ ...profile, sentimentNotes: extraction.sentimentNotes, updatedAt: Date.now() });
      }
    }
  }

  /**
   * Record the bot's own spoken reply into the guild transcript history as a
   * synthetic segment attributed to the persona name. `formatTranscript`
   * renders it as `<persona name>: <reply>` in the window the cheap-gate and
   * generator see next turn, giving the bot awareness of what it already said.
   * Uses the BOT_SPEAKER_ID sentinel so context assembly skips a profile
   * lookup for it (see contextAssembler).
   */
  private appendBotReply(trigger: TranscriptSegment, text: string): void {
    const now = Date.now();
    this.appendHistory({
      id: `bot-${now}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: trigger.guildId,
      channelId: trigger.channelId,
      userId: BOT_SPEAKER_ID,
      displayName: this.deps.persona.name,
      text,
      isFinal: true,
      confidence: 1,
      startedAt: now,
      endedAt: now,
    });
  }

  private appendHistory(segment: TranscriptSegment): void {
    const history = this.historyByGuild.get(segment.guildId) ?? [];
    history.push(segment);
    // Cap in-memory window generously beyond CONTEXT_WINDOW_UTTERANCES so
    // the ambient cheap-gate and full generation see slightly different
    // slice sizes if ever needed, without re-querying Postgres on every turn.
    const cap = CONTEXT_WINDOW_UTTERANCES * 4;
    if (history.length > cap) history.splice(0, history.length - cap);
    this.historyByGuild.set(segment.guildId, history);
  }

  private historyFor(guildId: string): TranscriptSegment[] {
    return this.historyByGuild.get(guildId) ?? [];
  }
}
