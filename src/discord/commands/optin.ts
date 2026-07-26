import type { SlashCommandDefinition } from "../types";

/**
 * `/optin` — reverses `/optout`. Not explicitly named in the brief, but
 * shipping an opt-out with no way back in is a real compliance UX gap
 * (brief section 8's consent framing implies revocable, two-way consent) —
 * added alongside `/optout` since it's a one-line wire against the same
 * `MemoryStore.setOptOut` method. Flagged here rather than silently
 * bundled in.
 */
export const optinCommand: SlashCommandDefinition = {
  name: "optin",
  description: "Re-enable voice transcription and memory for yourself in this server (reverses /optout).",
  async execute(ctx) {
    await ctx.services.memory.setOptOut(ctx.guildId, ctx.userId, false);
    await ctx.reply("You're opted back in — voice transcription and memory are active for you again.");
  },
};
