import { z } from "zod";

/**
 * STT module boundary.
 *
 * `TranscriptSegment` is the single most-shared shape in the whole
 * pipeline — it flows STT -> turn-taking -> context assembler ->
 * (persisted, trimmed) conversation_log. Locked as a Zod schema (Sam) since
 * it crosses a DB persistence boundary as well as an in-process one; both
 * `postgresStore.ts` row mapping and any future provider adapter should
 * validate against this schema rather than trusting a plain cast.
 */

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1), // voice channel id (paired text channel resolved by discord/ layer)
  userId: z.string().min(1),
  displayName: z.string().min(1),
  text: z.string(), // allowed empty (partials can arrive empty before first word lands)
  isFinal: z.boolean(), // false = partial/interim transcript, true = endpointed final
  confidence: z.number().min(0).max(1), // provider-reported
  startedAt: z.number().int().nonnegative(), // ms epoch, utterance start
  endedAt: z.number().int().nonnegative(), // ms epoch, utterance end (== startedAt for partials)
  language: z.string().min(2).optional(),
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/** Per-user, per-voice-connection streaming session handle. */
export interface STTSession {
  /** Push a raw PCM (or provider-native encoding) audio chunk for this user. */
  sendAudio(chunk: Buffer): void;
  /** Flush and cleanly end the session (e.g. user left channel, bot /leave). */
  finish(): Promise<void>;
}

export interface STTSessionOptions {
  guildId: string;
  channelId: string;
  userId: string;
  displayName: string;
  /** PCM sample rate fed in by the VAD/decoder stage — Discord voice receive decodes to 48kHz by default. */
  sampleRateHz: number;
  /** Channel count of the PCM fed in (Discord voice receive is stereo by default; providers often want mono). */
  channels: number;
  onSegment: (segment: TranscriptSegment) => void;
  onError: (err: Error) => void;
  /** Segments below this confidence are dropped by the provider before onSegment fires (brief section 2). */
  confidenceThreshold: number;
}

/**
 * Every STT backend (Deepgram now, AssemblyAI later) implements this so the
 * rest of the pipeline never imports a provider SDK directly.
 */
export interface STTProvider {
  readonly name: string;
  startSession(options: STTSessionOptions): STTSession;
}
