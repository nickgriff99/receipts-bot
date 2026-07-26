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
import { CONTEXT_WINDOW_UTTERANCES, LATENCY_WARN_THRESHOLD_MS } from "../config/constants";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:orchestrator");

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
