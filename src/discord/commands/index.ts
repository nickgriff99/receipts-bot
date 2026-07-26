import type { SlashCommandDefinition } from "../types";
import { joinCommand } from "./join";
import { leaveCommand } from "./leave";
import { modeCommand } from "./mode";
import { quietCommand } from "./quiet";
import { activeCommand } from "./active";
import { optoutCommand } from "./optout";
import { optinCommand } from "./optin";
import { setConsentChannelCommand } from "./setConsentChannel";

/**
 * Command registry — `discord/bootstrap.ts` hooks this up to discord.js's
 * `interactionCreate` dispatch + the Application Commands registration API
 * (guild-scoped for `DISCORD_DEV_GUILD_IDS` during dev, global otherwise).
 *
 * Both `/mode value:<active|quiet>` (one command, one option) and the
 * literal single-word `/quiet` / `/active` (brief's exact wording) are
 * registered — they call the same `MemoryStore.setGuildSettings` path, so
 * admins can use whichever they find more natural.
 */
export const COMMANDS: SlashCommandDefinition[] = [
  joinCommand,
  leaveCommand,
  modeCommand,
  quietCommand,
  activeCommand,
  optoutCommand,
  optinCommand,
  setConsentChannelCommand,
];
