/**
 * TTS module boundary.
 *
 * `synthesizeStream` returns an AsyncIterable<Buffer> of raw audio chunks
 * so the discord/voice/player.ts stage can pipe them straight into an
 * @discordjs/voice AudioResource without buffering the whole utterance —
 * required for the "must stream into playback, not wait for full file"
 * requirement (brief section 6) and for barge-in to be able to cut off
 * mid-stream cleanly.
 */

export interface TTSRequest {
  text: string;
  /** Optional emotion/delivery tag from the LLM response, if the provider/voice settings can use it. */
  tone?: string;
  voiceId: string;
}

export interface TTSProvider {
  readonly name: string;
  /**
   * Stream synthesized audio for the given text. Implementations should
   * respect an AbortSignal so playback/barge-in can cut generation short,
   * not just playback.
   */
  synthesizeStream(request: TTSRequest, signal?: AbortSignal): AsyncIterable<Buffer>;
}
