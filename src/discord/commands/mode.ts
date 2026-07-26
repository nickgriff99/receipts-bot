import type { SlashCommandDefinition } from "../types";

/**
 * `/mode` — brief locked decision: default mode is active, but a server
 * admin can override per-guild to `/quiet`-equivalent behavior via
 * `value:quiet` (and back via `value:active`). Gated on Manage Server
 * permission. Wired to `MemoryStore.setGuildSettings`.
 */
export const modeCommand: SlashCommandDefinition = {
  name: "mode",
  description: "Set the bot to 'active' (ambient co-host) or 'quiet' (only responds when addressed).",
  options: [
    {
      name: "value",
      description: "active or quiet",
      required: true,
      choices: [
        { name: "active", value: "active" },
        { name: "quiet", value: "quiet" },
      ],
    },
  ],
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    const value = ctx.options.value;
    if (value !== "active" && value !== "quiet") {
      await ctx.reply("Usage: `/mode value:active` or `/mode value:quiet`.");
      return;
    }
    await ctx.services.memory.setGuildSettings(ctx.guildId, { mode: value });
    await ctx.reply(`Mode set to **${value}**.`);
  },
};
