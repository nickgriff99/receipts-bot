import type { SlashCommandDefinition } from "../types";

/**
 * `/join` — brief section 1. Joins the invoking member's current voice
 * channel and starts the full per-user receive -> VAD -> STT -> pipeline
 * chain for the guild (wired by `discord/bootstrap.ts`'s
 * `startVoicePipeline`).
 */
export const joinCommand: SlashCommandDefinition = {
  name: "join",
  description: "Have the bot join your current voice channel.",
  async execute(ctx) {
    if (!ctx.voiceChannelId) {
      await ctx.reply("Hop into a voice channel first, then run `/join` again.");
      return;
    }
    try {
      await ctx.services.startVoicePipeline(ctx.guildId, ctx.voiceChannelId);
    } catch (err) {
      await ctx.reply(`Couldn't join that channel: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await ctx.reply("Joined — listening now. Voice is transcribed and used for responses + memory (see the consent notice above).");
  },
};
