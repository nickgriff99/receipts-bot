import type { SlashCommandDefinition } from "../types";

/**
 * `/setcontext` — Discord-side counterpart to the HTTP admin route
 * (`PUT /admin/guilds/:guildId/live-context`), for an operator who's
 * actually in the Discord server rather than scripting the admin API.
 * Both call the same `MemoryStore.setLiveContextOverride` — one write path,
 * two entrypoints, matching this project's precedent for `/mode` (slash
 * command) vs. the generic settings PATCH route both hitting
 * `setGuildSettings`. Gated on Manage Server, same as `/setconsentchannel`.
 *
 * `duration` only accepts `<number>m` or `<number>h` (e.g. `30m`, `2h`) —
 * deliberately not a bare number, so a typo-prone operator can't
 * accidentally set a 90-SECOND-shaped override thinking they typed minutes.
 * Omit it entirely to take `setLiveContextOverride`'s own default
 * (`LIVE_CONTEXT_OVERRIDE_DEFAULT_TTL_MS`, 2h). The hard cap
 * (`LIVE_CONTEXT_OVERRIDE_MAX_TTL_MS`, 12h) is enforced server-side inside
 * the store method regardless of what's requested here — this command does
 * NOT re-validate/re-cap it, same "don't duplicate the store's own logic"
 * reasoning as the HTTP route's `LiveContextSetSchema`.
 */
function parseDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)(m|h)$/i.exec(raw.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2].toLowerCase() === "h" ? 60 * 60 * 1000 : 60 * 1000;
  return amount * unitMs;
}

export const setContextCommand: SlashCommandDefinition = {
  name: "setcontext",
  description: "Temporarily steer the bot's tone/context (e.g. 'we're watching a movie right now').",
  options: [
    {
      name: "text",
      description: "What's going on right now — fed into the bot's prompt as high-priority context.",
      required: true,
    },
    {
      name: "duration",
      description: "How long it stays active, e.g. 30m or 2h. Defaults to 2h, capped at 12h.",
      required: false,
    },
  ],
  async execute(ctx) {
    if (!ctx.hasManageGuild) {
      await ctx.reply("You need the Manage Server permission to change this.");
      return;
    }
    const text = ctx.options.text;
    if (!text) {
      await ctx.reply("Usage: `/setcontext text:<what's going on> duration:<optional, e.g. 30m or 2h>`.");
      return;
    }
    const durationRaw = ctx.options.duration;
    const ttlMs = parseDurationMs(durationRaw);
    if (durationRaw && ttlMs === undefined) {
      await ctx.reply("Couldn't parse `duration` — use a number followed by `m` or `h`, e.g. `30m` or `2h`.");
      return;
    }
    await ctx.services.memory.setLiveContextOverride(ctx.guildId, text, ttlMs);
    await ctx.reply(`Live context set${durationRaw ? ` for ${durationRaw}` : " (default duration)"}: "${text}". Run \`/clearcontext\` to remove it early.`);
  },
};
