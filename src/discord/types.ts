import type { VoiceConnection } from "@discordjs/voice";
import type { MemoryStore } from "../memory/types";

/**
 * Discord module boundary.
 *
 * These interfaces exist so the pipeline orchestrator (src/pipeline) can
 * depend on `VoiceSessionManager` / `PlaybackController` shapes without
 * importing discord.js/@discordjs/voice directly — Merry wires the real
 * implementations against these without re-architecting the orchestrator.
 */

export interface VoiceSessionManager {
  /** Join (or move to) a voice channel for a guild. Idempotent if already connected there. */
  join(guildId: string, channelId: string): Promise<VoiceConnection>;
  /** Leave the current voice channel for a guild, if connected. */
  leave(guildId: string): void;
  isConnected(guildId: string): boolean;
  getConnection(guildId: string): VoiceConnection | undefined;
}

export type PlaybackPriority = "ambient" | "explicit";

export interface PlaybackController {
  /**
   * Play a streamed audio chunk sequence into a guild's voice connection.
   * If something is already playing and the new request is `explicit`
   * priority, implementations MUST stop the current playback first
   * (barge-in) rather than queueing — see ARCHITECTURE.md.
   */
  play(guildId: string, audio: AsyncIterable<Buffer>, opts: { priority: PlaybackPriority }): Promise<void>;
  /** Immediately stop whatever is currently playing for a guild (barge-in). */
  interrupt(guildId: string): void;
  isSpeaking(guildId: string): boolean;
}

/**
 * Shared runtime services command handlers need beyond their own
 * interaction context — injected by `discord/bootstrap.ts` at dispatch
 * time so command modules (`discord/commands/*.ts`) stay free of direct
 * discord.js/@discordjs/voice imports, matching the rest of this module
 * boundary's "commands depend on interfaces, bootstrap wires the real
 * thing" pattern.
 */
export interface BotRuntimeServices {
  memory: MemoryStore;
  /** Join the invoking user's current voice channel and start the full receive->STT->pipeline chain for that guild. */
  startVoicePipeline(guildId: string, channelId: string): Promise<void>;
  /** Leave the guild's voice channel and tear down its receive/STT sessions. */
  stopVoicePipeline(guildId: string): void;
}

export interface SlashCommandOptionChoice {
  name: string;
  value: string;
}

export interface SlashCommandOptionDefinition {
  name: string;
  description: string;
  required?: boolean;
  choices?: SlashCommandOptionChoice[];
  /** Discord option type to register. Defaults to `"string"` if omitted — existing commands don't need changes. `"channel"` restricts picking to real guild text channels. */
  type?: "string" | "channel";
}

export interface SlashCommandHandlerContext {
  guildId: string;
  userId: string;
  channelId: string;
  /** The invoking member's current voice channel id, if they're in one. */
  voiceChannelId?: string;
  /** Whether the invoking member has the Manage Server permission — commands that change guild-wide settings should gate on this. */
  hasManageGuild: boolean;
  /** Parsed slash command option values, keyed by option name (see `SlashCommandDefinition.options`). */
  options: Record<string, string | undefined>;
  services: BotRuntimeServices;
  reply(content: string): Promise<void>;
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
  /** Application command options to register with Discord (choices etc) — omit for a no-argument command. */
  options?: SlashCommandOptionDefinition[];
  execute(ctx: SlashCommandHandlerContext): Promise<void>;
}
