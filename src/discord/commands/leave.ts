import type { SlashCommandDefinition } from "../types";

/** `/leave` — brief section 1. Tears down the guild's voice connection and receive/STT sessions. */
export const leaveCommand: SlashCommandDefinition = {
  name: "leave",
  description: "Have the bot leave its current voice channel.",
  async execute(ctx) {
    ctx.services.stopVoicePipeline(ctx.guildId);
    await ctx.reply("Left the voice channel.");
  },
};
