import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { runTransfer } from "./transfer.js";

const COMMAND_NAME = "emby-transfer";

const transferCommand = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription("Transfer Emby favorites and/or watch status between two servers")
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
      .setDescription("Source Emby server URL (e.g. http://192.168.1.10:8096)")
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
      .setDescription("Password on the source Emby server")
      .setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("dest_url")
      .setDescription("Destination Emby server URL (e.g. http://192.168.1.20:8096)")
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
      .setDescription("Password on the destination Emby server")
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
    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: [transferCommand.toJSON()],
      });
      logger.info("Registered global slash commands");
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== COMMAND_NAME) return;

    await runTransfer(interaction as ChatInputCommandInteraction).catch((err) => {
      logger.error({ err }, "Unhandled error in transfer command");
    });
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}
