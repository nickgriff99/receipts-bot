import type { LLMRequest, MemoryContextSlice, PersonaConfig } from "../llm/types";
import type { TranscriptSegment } from "../stt/types";
import type { MemoryStore } from "../memory/types";
import type { TurnCandidate } from "./types";
import { BOT_SPEAKER_ID, CONTEXT_WINDOW_UTTERANCES } from "../config/constants";
import { logger } from "../shared/logger";

const log = logger.child("pipeline:context-assembler");

/**
 * Builds the LLMRequest the response-generation call actually sees:
 * rolling transcript window + per-speaker memory context + persona +
 * why-this-turn-fired reason (brief: "context assembler (rolling
 * transcript buffer, last 10-20 utterances + relevant per-user memory +
 * persona system prompt)").
 *
 * Pure logic + a MemoryStore read, no external API calls — implemented for
 * real.
 */
export class ContextAssembler {
  constructor(private readonly memory: MemoryStore) {}

  async assemble(
    candidate: TurnCandidate,
    persona: PersonaConfig,
    triggerReason: string,
    fullHistory: TranscriptSegment[],
    /** Tone-variety mechanism (Merry) — oldest first, capped by orchestrator.ts's MAX_RECENT_TONES_PER_GUILD. Threaded straight onto the request, no transform needed here. */
    recentTones: string[] = [],
  ): Promise<LLMRequest> {
    const recentTranscript = fullHistory.slice(-CONTEXT_WINDOW_UTTERANCES);

    const speakerIds = Array.from(new Set(recentTranscript.map((s) => s.userId))).filter((id) => id !== BOT_SPEAKER_ID);
    const profiles = await Promise.all(speakerIds.map((userId) => this.memory.getProfile(candidate.guildId, userId)));
    const memoryContext: MemoryContextSlice[] = profiles
      .map((profile) => {
        if (!profile || profile.optedOut) return undefined;
        const slice: MemoryContextSlice = {
          userId: profile.userId,
          displayName: profile.displayName,
          facts: profile.facts,
          runningJokes: profile.runningJokes,
          sentimentNotes: profile.sentimentNotes,
          lastInteractionAt: profile.lastInteractionAt,
        };
        return slice;
      })
      .filter((slice): slice is MemoryContextSlice => slice !== undefined);

    // Guild-wide running jokes/lore (task 4) — collective, not per-speaker,
    // so this is one extra read, not folded into the per-speaker
    // `memoryContext` loop above.
    const guildMemory = await this.memory.getGuildMemory(candidate.guildId);

    // Live-steering admin injection (task 5) — TTL-filtered HERE (not left
    // to the LLM prompt to judge staleness) so a forgotten override reliably
    // stops being surfaced once expired, without needing a background sweep
    // to clear the DB row. See GuildSettings.liveContextOverrideExpiresAt's
    // doc comment (memory/types.ts).
    const guildSettings = await this.memory.getGuildSettings(candidate.guildId);
    const overrideStillLive =
      !!guildSettings.liveContextOverride && !!guildSettings.liveContextOverrideExpiresAt && Date.now() < guildSettings.liveContextOverrideExpiresAt;
    const liveContextOverride = overrideStillLive ? guildSettings.liveContextOverride : undefined;

    // Observability (merry, task 5): an operator watching logs after a tone
    // shift needs to be able to tell WHY — both "an override is live and
    // just got fed into this turn's prompt" and "an override exists in the
    // DB but expired, so it's being silently ignored" (the confusing case —
    // without this line, a stale override just looks like the feature
    // doing nothing, with no signal pointing at the actual cause).
    if (guildSettings.liveContextOverride) {
      if (overrideStillLive) {
        log.debug("live-context override applied to this turn", { guildId: candidate.guildId });
      } else {
        log.info("live-context override present but expired — ignored for this turn", {
          guildId: candidate.guildId,
          expiredAt: guildSettings.liveContextOverrideExpiresAt,
        });
      }
    }

    return {
      guildId: candidate.guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript,
      memoryContext,
      triggerReason,
      recentTones,
      guildRunningJokes: guildMemory.runningJokes,
      liveContextOverride,
    };
  }
}
