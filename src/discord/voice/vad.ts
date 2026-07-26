import { logger } from "../../shared/logger";

const log = logger.child("voice:vad");

/**
 * Per-user VAD/silence segmentation stage — brief: "per-user VAD/silence-
 * segmentation -> streaming STT". This sits BETWEEN raw Opus receive/decode
 * (discord/voice/receiver.ts, still stubbed pending Merry's Discord wiring)
 * and the STT provider: it decides utterance boundaries from decoded PCM so
 * the STT session gets clean start/end-tagged chunks instead of a single
 * unbroken stream per user.
 *
 * This is pure signal processing (no Discord/SDK dependency), so it's
 * implemented for real rather than stubbed — a simple energy-threshold +
 * silence-hangover VAD is enough for v1. Swap for WebRTC VAD / Silero if
 * false-trigger rate on background noise becomes a problem in practice.
 */

export interface AudioFrame {
  userId: string;
  guildId: string;
  channelId: string;
  /** 16-bit PCM, mono, sampleRateHz (see options below). */
  pcm: Buffer;
  timestamp: number; // ms epoch when this frame was captured
}

export interface VoiceSegment {
  userId: string;
  guildId: string;
  channelId: string;
  pcm: Buffer; // concatenated PCM for the whole utterance
  startedAt: number;
  endedAt: number;
}

export interface VADOptions {
  sampleRateHz: number;
  /** RMS amplitude (0..32767 range for 16-bit PCM) above which a frame counts as "speech". */
  energyThreshold: number;
  /** How long silence must persist before an in-progress utterance is closed out, in ms. */
  silenceHangoverMs: number;
  /** Drop utterances shorter than this — filters out breath noise / mic clicks, in ms. */
  minUtteranceMs: number;
}

export const DEFAULT_VAD_OPTIONS: VADOptions = {
  sampleRateHz: 48_000,
  energyThreshold: 500,
  silenceHangoverMs: 600,
  minUtteranceMs: 200,
};

interface PerUserState {
  chunks: Buffer[];
  utteranceStartedAt: number | null;
  lastVoicedAt: number | null;
}

/**
 * Stateful segmenter, one instance per voice connection (guild), tracking
 * each speaking user's in-progress utterance independently so up to ~10
 * concurrent speakers (brief scale target) never bleed into each other's
 * segments.
 */
export class VADSegmenter {
  private readonly options: VADOptions;
  private readonly perUser = new Map<string, PerUserState>();

  constructor(options: Partial<VADOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  /**
   * Feed one decoded PCM frame. Returns a completed VoiceSegment if this
   * frame's silence closed out an in-progress utterance, otherwise
   * undefined (utterance still accumulating, or still silent).
   */
  pushFrame(frame: AudioFrame): VoiceSegment | undefined {
    const state = this.perUser.get(frame.userId) ?? { chunks: [], utteranceStartedAt: null, lastVoicedAt: null };
    this.perUser.set(frame.userId, state);

    const isSpeech = rms(frame.pcm) >= this.options.energyThreshold;

    if (isSpeech) {
      if (state.utteranceStartedAt === null) {
        state.utteranceStartedAt = frame.timestamp;
        state.chunks = [];
      }
      state.chunks.push(frame.pcm);
      state.lastVoicedAt = frame.timestamp;
      return undefined;
    }

    // Silence frame.
    if (state.utteranceStartedAt === null) return undefined; // nothing in progress
    const silenceDuration = frame.timestamp - (state.lastVoicedAt ?? frame.timestamp);
    if (silenceDuration < this.options.silenceHangoverMs) return undefined; // still within hangover

    const segment = this.closeUtterance(frame.userId, frame.guildId, frame.channelId, frame.timestamp);
    return segment;
  }

  /** Force-close an in-progress utterance (e.g. user leaves channel, or barge-in trigger needs the partial segment now). */
  flush(userId: string, guildId: string, channelId: string, atTimestamp: number): VoiceSegment | undefined {
    return this.closeUtterance(userId, guildId, channelId, atTimestamp);
  }

  private closeUtterance(userId: string, guildId: string, channelId: string, endedAt: number): VoiceSegment | undefined {
    const state = this.perUser.get(userId);
    if (!state || state.utteranceStartedAt === null) return undefined;

    const startedAt = state.utteranceStartedAt;
    const durationMs = endedAt - startedAt;
    const pcm = Buffer.concat(state.chunks);

    state.utteranceStartedAt = null;
    state.chunks = [];
    state.lastVoicedAt = null;

    if (durationMs < this.options.minUtteranceMs) {
      log.debug("dropped short utterance", { userId, durationMs });
      return undefined;
    }

    return { userId, guildId, channelId, pcm, startedAt, endedAt };
  }
}

/** Root-mean-square amplitude of a 16-bit little-endian PCM buffer. */
function rms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sumSquares = 0;
  const sampleCount = Math.floor(pcm.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}
