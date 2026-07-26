import type { LLMRequest, MemoryContextSlice, PersonaConfig } from "../llm/types";
import type { TranscriptSegment } from "../stt/types";
import type { MemoryStore } from "../memory/types";
import type { TurnCandidate } from "./types";
import { CONTEXT_WINDOW_UTTERANCES } from "../config/constants";

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

  async assemble(candidate: TurnCandidate, persona: PersonaConfig, triggerReason: string, fullHistory: TranscriptSegment[]): Promise<LLMRequest> {
    const recentTranscript = fullHistory.slice(-CONTEXT_WINDOW_UTTERANCES);

    const speakerIds = Array.from(new Set(recentTranscript.map((s) => s.userId)));
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

    return {
      guildId: candidate.guildId,
      channelId: candidate.channelId,
      persona,
      recentTranscript,
      memoryContext,
      triggerReason,
    };
  }
}
