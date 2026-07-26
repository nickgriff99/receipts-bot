import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Message,
  type TextChannel,
  type VoiceBasedChannel,
} from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";
import type { AppConfig } from "../config/types";
import type { MemoryStore } from "../memory/types";
import type { PersonaConfig } from "../llm/types";
import type { STTProvider, STTSession } from "../stt/types";
import type { TranscriptSegment } from "../stt/types";
import type { TriggerType } from "../pipeline/types";
import type { PipelineOrchestrator } from "../pipeline/orchestrator";
import type { AudioFrame } from "./voice/vad";
import { VADSegmenter } from "./voice/vad";
import { VoiceConnectionManager } from "./voice/connectionManager";
import { VoiceReceiverManager, OPUS_STREAM_FORMAT } from "./voice/receiver";
import { DiscordPlaybackController } from "./voice/player";
import { COMMANDS } from "./commands/index";
import type { BotRuntimeServices, SlashCommandHandlerContext } from "./types";
import { loginDiscordClient } from "./client";
import { newId } from "../shared/ids";
import { logger } from "../shared/logger";

const log = logger.child("discord:bootstrap");

/** Stable customId for the consent-notice accept button — no guild/user encoding needed, `interaction.guildId`/`interaction.user.id` come off the button interaction itself. */
const CONSENT_ACCEPT_BUTTON_ID = "consent_accept";

export interface BootstrapDeps {
  client: Client;
  config: AppConfig;
  memory: MemoryStore;
  stt: STTProvider;
  orchestrator: PipelineOrchestrator;
  persona: PersonaConfig;
  /** Shared with `PipelineOrchestrator` (via `OrchestratorDeps.playback`) — both must operate on the same controller instance. */
  playback: DiscordPlaybackController;
}

interface GuildRuntimeState {
  connection: VoiceConnection;
  voiceChannelId: string;
  textChannelId?: string;
  vad: VADSegmenter;
  sttSessions: Map<string, STTSession>;
  /** Users whose STT session is being created (display-name resolution in flight) — guards against a second speaking-start racing in and starting a duplicate session for the same user. */
  pendingSttUsers: Set<string>;
  speakingListener: (userId: string) => void;
}

/**
 * Ties every remaining stub together: Discord login, slash command
 * registration + dispatch, voice join/leave (`/join`/`/leave` + optional
 * auto-join-on-user-entry), per-user Opus receive -> VAD -> persistent
 * Deepgram STT session -> `PipelineOrchestrator.handleSegment`, explicit
 * text-channel triggers (@mention / reply), and the compliance consent
 * notice on join.
 *
 * This is the single place that turns the structurally-correct-but-inert
 * scaffold (client.ts, commands/*.ts, voice/*.ts, pipeline/orchestrator.ts)
 * into a running bot — everything here is real wiring, not stubs.
 */
export class DiscordBotRuntime {
  private readonly guildStates = new Map<string, GuildRuntimeState>();
  private readonly voiceSessions: VoiceConnectionManager;
  private readonly receiver = new VoiceReceiverManager();
  private readonly playback: DiscordPlaybackController;
  private readonly services: BotRuntimeServices;

  constructor(private readonly deps: BootstrapDeps) {
    this.playback = deps.playback;
    this.voiceSessions = new VoiceConnectionManager((guildId) => {
      const guild = this.deps.client.guilds.cache.get(guildId);
      if (!guild) throw new Error(`Cannot resolve voice adapter — guild ${guildId} not cached`);
      return guild.voiceAdapterCreator;
    });

    this.services = {
      memory: this.deps.memory,
      startVoicePipeline: (guildId, channelId) => this.startVoicePipeline(guildId, channelId),
      stopVoicePipeline: (guildId) => this.stopVoicePipeline(guildId),
    };
  }

  async start(): Promise<void> {
    this.attachListeners();
    await loginDiscordClient(this.deps.client, this.deps.config.discord.botToken);
    await this.registerCommands();
    log.info("discord bot runtime started");
  }

  async shutdown(): Promise<void> {
    for (const guildId of [...this.guildStates.keys()]) {
      this.stopVoicePipeline(guildId);
    }
    this.deps.client.destroy();
  }

  // ---------------------------------------------------------------------
  // Slash command registration + dispatch
  // ---------------------------------------------------------------------

  private async registerCommands(): Promise<void> {
    const rest = new REST().setToken(this.deps.config.discord.botToken);
    const body = COMMANDS.map((cmd) => {
      const builder = new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description);
      for (const opt of cmd.options ?? []) {
        if (opt.type === "channel") {
          builder.addChannelOption((option) => {
            option
              .setName(opt.name)
              .setDescription(opt.description)
              .setRequired(!!opt.required)
              .addChannelTypes(ChannelType.GuildText);
            return option;
          });
        } else {
          builder.addStringOption((option) => {
            option.setName(opt.name).setDescription(opt.description).setRequired(!!opt.required);
            if (opt.choices && opt.choices.length > 0) {
              option.addChoices(...opt.choices.map((c) => ({ name: c.name, value: c.value })));
            }
            return option;
          });
        }
      }
      return builder.toJSON();
    });

    const devGuildIds = this.deps.config.discord.devGuildIds;
    try {
      if (devGuildIds.length > 0) {
        for (const guildId of devGuildIds) {
          await rest.put(Routes.applicationGuildCommands(this.deps.config.discord.applicationId, guildId), { body });
        }
        log.info("registered guild-scoped slash commands", { guildIds: devGuildIds, count: body.length });
      } else {
        await rest.put(Routes.applicationCommands(this.deps.config.discord.applicationId), { body });
        log.info("registered global slash commands", { count: body.length });
      }
    } catch (err) {
      log.error("slash command registration failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private attachListeners(): void {
    this.deps.client.on(Events.ClientReady, (client) => {
      log.info("discord client ready", { user: client.user.tag });
    });

    this.deps.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.dispatchCommand(interaction).catch((err) => {
          log.error("command dispatch failed", {
            command: interaction.commandName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      if (interaction.isButton() && interaction.customId === CONSENT_ACCEPT_BUTTON_ID) {
        void this.handleConsentAccept(interaction).catch((err) => {
          log.error("consent accept handling failed", {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });

    this.deps.client.on(Events.MessageCreate, (message) => {
      void this.handleMessageCreate(message).catch((err) => {
        log.error("explicit text-trigger handling failed", { error: err instanceof Error ? err.message : String(err) });
      });
    });

    this.deps.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (!this.deps.config.defaults.autoJoinOnUserEntry) return;
      if (newState.member?.user.bot) return;
      if (!newState.channelId || newState.channelId === oldState.channelId) return; // only fresh channel-joins
      if (this.guildStates.has(newState.guild.id)) return; // already connected somewhere in this guild
      void this.startVoicePipeline(newState.guild.id, newState.channelId).catch((err) => {
        log.error("auto-join failed", { guildId: newState.guild.id, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  private async dispatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
      return;
    }

    const command = COMMANDS.find((c) => c.name === interaction.commandName);
    if (!command) {
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
      return;
    }

    const guild = interaction.guild ?? (await this.deps.client.guilds.fetch(interaction.guildId));
    const member = guild.members.cache.get(interaction.user.id) ?? (await guild.members.fetch(interaction.user.id).catch(() => undefined));

    const options: Record<string, string | undefined> = {};
    for (const optDef of command.options ?? []) {
      options[optDef.name] =
        optDef.type === "channel"
          ? (interaction.options.getChannel(optDef.name)?.id ?? undefined)
          : (interaction.options.getString(optDef.name) ?? undefined);
    }

    const ctx: SlashCommandHandlerContext = {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      voiceChannelId: member?.voice.channelId ?? undefined,
      hasManageGuild: member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false,
      options,
      services: this.services,
      reply: async (content: string) => {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(content);
        } else {
          await interaction.reply(content);
        }
      },
    };

    await command.execute(ctx);
  }

  /**
   * Consent-notice "Accept" button click. Ephemeral reply only — the
   * original notice message stays untouched (other, not-yet-accepted users
   * in the same channel still need to see and click it). Gates whether
   * pipeline/STT starts listening to this user at all; `/optout` remains
   * the separate secondary lever for someone who already accepted but
   * changes their mind (Merry wires the actual `consentAccepted` gate).
   */
  private async handleConsentAccept(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This only works in a server.", ephemeral: true });
      return;
    }

    await this.deps.memory.setConsentAccepted(interaction.guildId, interaction.user.id, true);
    await interaction.reply({
      content: "You're all set — I'll start listening and responding to you in voice now.",
      ephemeral: true,
    });
  }

  // ---------------------------------------------------------------------
  // Explicit text-channel triggers (@mention / reply) — brief section 3
  // ---------------------------------------------------------------------

  private async handleMessageCreate(message: Message): Promise<void> {
    if (message.author.bot || !message.guildId) return;

    const state = this.guildStates.get(message.guildId);
    if (!state || message.channelId !== state.textChannelId) return; // only the paired text channel

    if (!(await this.deps.memory.hasAcceptedConsent(message.guildId, message.author.id))) return; // never accepted — not processed at all
    if (await this.deps.memory.isOptedOut(message.guildId, message.author.id)) return; // accepted, then later excluded

    const botUserId = this.deps.client.user?.id;
    const isMention = !!botUserId && message.mentions.users.has(botUserId);

    let isReply = false;
    if (!isMention && message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => undefined);
      isReply = referenced?.author.id === botUserId;
    }
    if (!isMention && !isReply) return;

    const triggerType: TriggerType = isMention ? "explicit_mention" : "explicit_reply";
    const text = botUserId ? message.content.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "").trim() : message.content.trim();
    if (text.length === 0) return;

    const now = Date.now();
    const segment: TranscriptSegment = {
      id: newId(),
      guildId: message.guildId,
      channelId: state.voiceChannelId,
      userId: message.author.id,
      displayName: message.member?.displayName ?? message.author.username,
      text,
      isFinal: true,
      confidence: 1,
      startedAt: now,
      endedAt: now,
    };

    await this.deps.orchestrator.handleSegment(segment, triggerType);
  }

  // ---------------------------------------------------------------------
  // Voice pipeline (join/leave, receive -> VAD -> STT -> orchestrator)
  // ---------------------------------------------------------------------

  private async startVoicePipeline(guildId: string, channelId: string): Promise<void> {
    const existing = this.guildStates.get(guildId);
    if (existing?.voiceChannelId === channelId) return; // already connected there
    if (existing) this.stopVoicePipeline(guildId); // switching channels — tear down first

    const connection = await this.voiceSessions.join(guildId, channelId);
    this.playback.attach(guildId, connection);

    const guild = await this.deps.client.guilds.fetch(guildId);
    const voiceChannel = guild.channels.cache.get(channelId);
    const guildSettings = await this.deps.memory.getGuildSettings(guildId);
    const textChannelId = await this.resolveTextChannelId(
      guild,
      voiceChannel && voiceChannel.isVoiceBased() ? voiceChannel : undefined,
      guildSettings.consentChannelId,
    );

    const speakingListener = (userId: string) => this.handleUserSpeakingStart(guildId, userId);

    const state: GuildRuntimeState = {
      connection,
      voiceChannelId: channelId,
      textChannelId,
      vad: new VADSegmenter(),
      sttSessions: new Map(),
      pendingSttUsers: new Set(),
      speakingListener,
    };
    this.guildStates.set(guildId, state);

    connection.receiver.speaking.on("start", speakingListener);

    if (textChannelId) {
      await this.postConsentNotice(guild, textChannelId).catch((err) => {
        log.warn("failed to post consent notice", { guildId, error: err instanceof Error ? err.message : String(err) });
      });
    } else {
      log.warn("no sendable text channel found — skipping consent notice", { guildId });
    }

    log.info("voice pipeline started", { guildId, channelId, textChannelId });
  }

  private stopVoicePipeline(guildId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    state.connection.receiver.speaking.off("start", state.speakingListener);

    for (const [userId, session] of state.sttSessions) {
      void session.finish().catch(() => {});
      this.receiver.unsubscribeUser(userId);
    }
    state.sttSessions.clear();

    this.playback.interrupt(guildId);
    this.voiceSessions.leave(guildId);
    this.guildStates.delete(guildId);
    log.info("voice pipeline stopped", { guildId });
  }

  private handleUserSpeakingStart(guildId: string, userId: string): void {
    const state = this.guildStates.get(guildId);
    if (!state) return;
    if (userId === this.deps.client.user?.id) return; // defensive — bot never subscribes to itself

    const existingSession = state.sttSessions.get(userId);
    if (existingSession) {
      this.subscribeAudioForUser(guildId, state, userId, existingSession);
      return;
    }

    if (state.pendingSttUsers.has(userId)) return; // already resolving for this user, second event raced in

    // Guard set synchronously, before any `await`, so a second speaking-start
    // event racing in on the same tick can't slip past this check while the
    // opted-out lookup / display-name resolution below are in flight (both
    // are now real async I/O — Postgres + Discord REST — not synchronous
    // calls like the old better-sqlite3-backed check was).
    state.pendingSttUsers.add(userId);
    void this.startSttSessionForUser(guildId, userId).catch((err) => {
      state.pendingSttUsers.delete(userId);
      log.error("failed to start STT session", { guildId, userId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  private async startSttSessionForUser(guildId: string, userId: string): Promise<void> {
    const state = this.guildStates.get(guildId);
    if (!state) return;

    // Consent gate first — a user who has never clicked Accept must not have
    // an STT session started at all, so no audio for them is ever subscribed
    // or sent to Deepgram (no capture, no spend). Checked before opted-out
    // since opted-out only makes sense for a user who accepted at some point.
    if (!(await this.deps.memory.hasAcceptedConsent(guildId, userId))) {
      state.pendingSttUsers.delete(userId);
      log.debug("skipping audio subscription — consent not yet accepted", { guildId, userId });
      return;
    }

    if (await this.deps.memory.isOptedOut(guildId, userId)) {
      state.pendingSttUsers.delete(userId);
      log.debug("skipping audio subscription for opted-out user", { guildId, userId });
      return;
    }

    // Display name resolution: cache hit is instant; cache miss falls back to
    // a single-user REST fetch (`guild.members.fetch(userId)`, which — unlike
    // a bare no-argument `guild.members.fetch()` — does NOT require the
    // privileged GUILD_MEMBERS intent) so users who were already in the
    // voice channel before the bot joined (the common case a pure
    // `.cache.get` lookup would silently mis-tag as their raw Discord ID
    // forever) still get tagged correctly. This costs one REST round-trip
    // (~tens of ms) exactly once per (guild, user) per bot session, not per
    // utterance — subsequent speaking-start events reuse the cached session.
    const displayName = await this.resolveDisplayName(guildId, userId);
    state.pendingSttUsers.delete(userId);
    if (!this.guildStates.has(guildId)) return; // pipeline torn down while resolving
    if (state.sttSessions.has(userId)) return; // defensive — shouldn't happen given the pending-guard above

    const confidenceThreshold = (await this.deps.memory.getGuildSettings(guildId)).sttConfidenceThreshold;
    const session = this.deps.stt.startSession({
      guildId,
      channelId: state.voiceChannelId,
      userId,
      displayName,
      sampleRateHz: OPUS_STREAM_FORMAT.sampleRateHz,
      channels: OPUS_STREAM_FORMAT.channels,
      confidenceThreshold,
      onSegment: (segment) => this.handleTranscriptSegment(segment),
      onError: (err) => {
        log.error("STT session error", { guildId, userId, error: err.message });
      },
    });
    state.sttSessions.set(userId, session);
    this.subscribeAudioForUser(guildId, state, userId, session);
  }

  private subscribeAudioForUser(guildId: string, state: GuildRuntimeState, userId: string, session: STTSession): void {
    this.receiver.subscribeUser(state.connection, guildId, state.voiceChannelId, userId, (frame: AudioFrame) => {
      // VAD segmentation feeds our own utterance-boundary bookkeeping (brief:
      // "feed into the existing VAD segmenter") — Deepgram's own endpointing
      // (`endpointing: 300` in deepgramProvider.ts) drives the actual
      // is_final/partial transcript boundaries for low-latency streaming, so
      // the VAD segment close here is observability/logging, not a gate on
      // what audio reaches Deepgram (gating on it would mean buffering a
      // whole utterance before sending anything, killing partial-transcript
      // latency — see ARCHITECTURE.md's "need partial + final transcripts,
      // low latency" requirement).
      const closedSegment = state.vad.pushFrame(frame);
      if (closedSegment) {
        log.debug("VAD utterance boundary", {
          guildId,
          userId,
          durationMs: closedSegment.endedAt - closedSegment.startedAt,
        });
      }
      session.sendAudio(frame.pcm);
    });
  }

  private handleTranscriptSegment(segment: TranscriptSegment): void {
    if (!segment.isFinal) {
      log.debug("partial transcript", { guildId: segment.guildId, userId: segment.userId, text: segment.text });
      return;
    }
    if (segment.text.trim().length === 0) return;

    const triggerType: TriggerType = mentionsPersonaName(segment.text, this.deps.persona.name) ? "explicit_name" : "ambient_pause";
    void this.deps.orchestrator.handleSegment(segment, triggerType).catch((err) => {
      log.error("orchestrator.handleSegment failed", {
        guildId: segment.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Cache-first, single-user-REST-fallback display name lookup. A plain
   * `guild.members.cache.get(userId)` (no fallback) silently returns
   * `undefined` for anyone the client hasn't observed a gateway event for
   * yet — e.g. a user who was already sitting in the voice channel before
   * `/join` ran — which would otherwise tag every one of their transcript
   * segments with their raw Discord ID instead of a real display name.
   * `guild.members.fetch(userId)` (single-member overload) is a REST call,
   * NOT the no-argument "request full member list" gateway path, so it does
   * not require the privileged `GUILD_MEMBERS` intent.
   */
  private async resolveDisplayName(guildId: string, userId: string): Promise<string> {
    const guild = this.deps.client.guilds.cache.get(guildId);
    if (!guild) return userId;

    const cached = guild.members.cache.get(userId);
    if (cached) return cached.displayName;

    const fetched = await guild.members.fetch(userId).catch(() => undefined);
    return fetched?.displayName ?? userId;
  }

  // ---------------------------------------------------------------------
  // Compliance: paired text channel resolution + consent notice
  // ---------------------------------------------------------------------

  /**
   * `consentChannelId` (from `GuildSettings`, set via `/setconsentchannel`)
   * is checked first — an admin's explicit pin overrides auto-detection.
   * Still re-verified for send permission here since the bot's access to
   * that channel may have changed since it was pinned; falls through to the
   * existing same-name/system/first-sendable chain if unset or no longer
   * sendable, rather than silently going quiet.
   */
  private async resolveTextChannelId(guild: Guild, voiceChannel?: VoiceBasedChannel, consentChannelId?: string): Promise<string | undefined> {
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => undefined));
    if (!me) return undefined;

    const canSend = (channel: TextChannel): boolean => channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ?? false;

    if (consentChannelId) {
      const pinned = guild.channels.cache.get(consentChannelId);
      if (pinned && pinned.type === ChannelType.GuildText && canSend(pinned)) return pinned.id;
    }

    if (voiceChannel) {
      const sameName = guild.channels.cache.find(
        (c): c is TextChannel => c.type === ChannelType.GuildText && c.name === voiceChannel.name && canSend(c),
      );
      if (sameName) return sameName.id;
    }

    if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel.id;

    const firstSendable = guild.channels.cache.find((c): c is TextChannel => c.type === ChannelType.GuildText && canSend(c));
    return firstSendable?.id;
  }

  private async postConsentNotice(guild: Guild, textChannelId: string): Promise<void> {
    const channel = await guild.channels.fetch(textChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const acceptButton = new ButtonBuilder()
      .setCustomId(CONSENT_ACCEPT_BUTTON_ID)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success);
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(acceptButton);

    await (channel as TextChannel).send({
      content:
        "I'm in the voice channel now, but I won't transcribe or respond to you until you click **Accept** below. " +
        "Once accepted, your voice is transcribed in real time and used to generate responses and build per-user " +
        "memory (facts, running jokes, rapport notes). Raw audio is never stored — only text transcripts and " +
        "derived memory, which get pruned over time. Already accepted and want out later? Run `/optout` to exclude " +
        "yourself, or `/optin` to rejoin. Recording/transcription consent is this server's responsibility under " +
        "your jurisdiction and Discord's ToS.",
      components: [actionRow],
    });
  }
}

/** Case-insensitive, word-boundary match of the persona's configured name in a transcript utterance. */
function mentionsPersonaName(text: string, personaName: string): boolean {
  const escaped = personaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(text);
}
