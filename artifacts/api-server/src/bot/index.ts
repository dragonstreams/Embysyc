import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { runTransfer } from "./transfer.js";
import { runReminderCommand, startReminderScheduler } from "./reminders.js";

const COMMAND_NAME = "emby-transfer";
const REMINDER_COMMAND_NAME = "reminder";

const reminderCommand = new SlashCommandBuilder()
  .setName(REMINDER_COMMAND_NAME)
  .setDescription("Send invoice reminders for invoices due tomorrow now (admin)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

const transferCommand = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription("Transfer Emby/Jellyfin favorites and/or watch status between two servers")
  .addStringOption((o) =>
    o
      .setName("what")
      .setDescription("What to transfer")
      .setRequired(true)
      .addChoices(
        { name: "Both favorites and watch status", value: "both" },
        { name: "Favorites only", value: "favorites" },
        { name: "Watch status only", value: "watched" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("source_url")
      .setDescription("Source server URL (e.g. http://192.168.1.10:8096)")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("source_username")
      .setDescription("Source: local username, or Emby Connect email if using Connect")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("source_password")
      .setDescription("Password on the source server")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("dest_url")
      .setDescription("Destination server URL (e.g. http://192.168.1.20:8096)")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("dest_username")
      .setDescription("Dest: local username, or Emby Connect email if using Connect")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("dest_password")
      .setDescription("Password on the destination server")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("source_login")
      .setDescription("How to sign in to the source server (default: local username/password)")
      .addChoices(
        { name: "Local username & password", value: "local" },
        { name: "Emby Connect (email)", value: "connect" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("dest_login")
      .setDescription("How to sign in to the destination server (default: local username/password)")
      .addChoices(
        { name: "Local username & password", value: "local" },
        { name: "Emby Connect (email)", value: "connect" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("source_type")
      .setDescription("Source server software (default: Emby)")
      .addChoices(
        { name: "Emby", value: "emby" },
        { name: "Jellyfin", value: "jellyfin" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("dest_type")
      .setDescription("Destination server software (default: Emby)")
      .addChoices(
        { name: "Emby", value: "emby" },
        { name: "Jellyfin", value: "jellyfin" }
      )
  );

export async function startBot(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) {
    logger.warn("DISCORD_TOKEN not set — Discord bot will not start");
    return;
  }

  logger.info("Starting Discord bot");

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot logged in");

    const rest = new REST().setToken(token);
    const guildId = process.env["DISCORD_GUILD_ID"]?.trim();
    const body = [transferCommand.toJSON(), reminderCommand.toJSON()];
    try {
      if (guildId) {
        await rest.put(
          Routes.applicationGuildCommands(readyClient.user.id, guildId),
          { body }
        );
        logger.info({ guildId }, "Registered guild slash commands (instant)");
      } else {
        await rest.put(Routes.applicationCommands(readyClient.user.id), {
          body,
        });
        logger.info(
          "Registered global slash commands (may take up to 1 hour to appear)"
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }

    startReminderScheduler(readyClient);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    logger.info(
      { command: interaction.commandName, user: interaction.user.tag },
      "Received slash command interaction"
    );

    if (interaction.commandName === COMMAND_NAME) {
      await runTransfer(interaction as ChatInputCommandInteraction).catch(
        (err) => {
          logger.error({ err }, "Unhandled error in transfer command");
        }
      );
      return;
    }

    if (interaction.commandName === REMINDER_COMMAND_NAME) {
      await runReminderCommand(
        interaction as ChatInputCommandInteraction
      ).catch((err) => {
        logger.error({ err }, "Unhandled error in reminder command");
      });
      return;
    }
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}
