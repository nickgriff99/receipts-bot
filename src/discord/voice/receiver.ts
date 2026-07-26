import type { VoiceConnection } from "@discordjs/voice";
import { EndBehaviorType } from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import type { Readable } from "node:stream";
import { logger } from "../../shared/logger";
import type { AudioFrame } from "./vad";

const log = logger.child("voice:receiver");

/** Discord's voice receive format is fixed: 48kHz, stereo, 20ms (960-sample) Opus frames. */
const OPUS_SAMPLE_RATE_HZ = 48_000;
const OPUS_CHANNELS = 2;
/** How long a per-user Opus receive stream waits in silence before auto-ending — re-subscribed on their next speaking-start event. */
const SILENCE_END_MS = 500;

/**
 * Per-user Opus receive + decode — brief section 1: "Per-user audio
 * streams kept separate end to end (never mixed before STT)".
 *
 * One `OpusEncoder` decoder instance per user (kept alive across multiple
 * utterances/subscriptions, torn down on `unsubscribeUser`) so decoder
 * state never bleeds across the up-to-~10 concurrent speakers this needs
 * to support (brief scale target).
 */
export class VoiceReceiverManager {
  private readonly decoders = new Map<string, OpusEncoder>();
  private readonly opusStreams = new Map<string, Readable>();

  /**
   * Subscribe to one user's Opus audio for as long as they keep speaking
   * with short pauses (`EndBehaviorType.AfterSilence` re-arms automatically
   * up to `SILENCE_END_MS` of quiet before the underlying stream ends —
   * callers should re-subscribe on the next `receiver.speaking` 'start'
   * event for that user, see `discord/bootstrap.ts`).
   */
  subscribeUser(
    connection: VoiceConnection,
    guildId: string,
    channelId: string,
    userId: string,
    onFrame: (frame: AudioFrame) => void,
  ): void {
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    this.opusStreams.set(userId, opusStream);

    let decoder = this.decoders.get(userId);
    if (!decoder) {
      decoder = new OpusEncoder(OPUS_SAMPLE_RATE_HZ, OPUS_CHANNELS);
      this.decoders.set(userId, decoder);
    }
    const activeDecoder = decoder;

    opusStream.on("data", (opusPacket: Buffer) => {
      try {
        const pcm = activeDecoder.decode(opusPacket);
        onFrame({ userId, guildId, channelId, pcm, timestamp: Date.now() });
      } catch (err) {
        log.debug("failed to decode opus packet", {
          guildId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    opusStream.on("error", (err) => {
      log.warn("opus receive stream error", { guildId, userId, error: err.message });
    });
  }

  unsubscribeUser(userId: string): void {
    const opusStream = this.opusStreams.get(userId);
    if (opusStream && !opusStream.destroyed) {
      opusStream.destroy();
    }
    this.opusStreams.delete(userId);
    this.decoders.delete(userId);
  }
}

export const OPUS_STREAM_FORMAT = { sampleRateHz: OPUS_SAMPLE_RATE_HZ, channels: OPUS_CHANNELS };
