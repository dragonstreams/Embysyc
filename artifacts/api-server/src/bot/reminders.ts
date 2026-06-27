import type { ChatInputCommandInteraction, Client } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { logger } from "../lib/logger.js";
import {
  getInvoiceNinjaConfig,
  listUnpaidInvoices,
  type InvoiceNinjaConfig,
  type NinjaInvoice,
} from "./invoiceninja.js";
import { hasReminded, markReminded, pruneOldReminders } from "./reminderStore.js";

export interface ReminderRunResult {
  configured: boolean;
  dueTomorrow: number;
  sent: number;
  alreadySent: number;
  noDiscordId: number;
  failed: number;
  errors: string[];
}

// ── Date/time helpers (timezone-aware calendar math) ────────────────────────

/** Returns the YYYY-MM-DD date `offsetDays` from today, in the given IANA tz. */
function dateStringInTz(tz: string, offsetDays = 0): string {
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // Anchor at noon UTC so adding days never crosses a DST boundary.
  const base = new Date(`${todayStr}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

/** Current hour (0–23) in the given IANA tz. */
function hourInTz(tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return parseInt(h, 10) % 24;
}

let tzValidated: string | null = null;

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getTz(): string {
  if (tzValidated) return tzValidated;
  const requested = process.env["REMINDER_TZ"]?.trim() || "UTC";
  if (isValidTz(requested)) {
    tzValidated = requested;
  } else {
    logger.warn({ requested }, "Invalid REMINDER_TZ — falling back to UTC");
    tzValidated = "UTC";
  }
  return tzValidated;
}

function getReminderHour(): number {
  const raw = Number(process.env["REMINDER_HOUR"]?.trim());
  if (!Number.isInteger(raw) || raw < 0 || raw > 23) return 9;
  return raw;
}

// ── Invoice filtering & resolution ──────────────────────────────────────────

function invoiceBalance(inv: NinjaInvoice): number {
  return typeof inv.balance === "number" ? inv.balance : Number(inv.balance ?? 0);
}

/** An invoice is remindable if it's sent/partial, has a balance, and is due on `targetDue`. */
function isRemindable(inv: NinjaInvoice, targetDue: string): boolean {
  if (inv.due_date !== targetDue) return false;
  const status = String(inv.status_id ?? "");
  if (status !== "2" && status !== "3") return false; // 2 = sent, 3 = partial
  return invoiceBalance(inv) > 0;
}

function getDiscordId(
  inv: NinjaInvoice,
  config: InvoiceNinjaConfig
): string | null {
  const raw = inv.client?.[config.discordField]?.trim();
  if (!raw) return null;
  return /^\d{17,20}$/.test(raw) ? raw : null;
}

function buildReminderEmbed(inv: NinjaInvoice): EmbedBuilder {
  const number = inv.number ?? inv.id;
  const link = inv.invitations?.find((i) => i.link)?.link;

  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle("🧾 Invoice Reminder")
    .setDescription(
      `Your invoice **#${number}** is due **tomorrow** (${inv.due_date}).`
    )
    .addFields(
      { name: "Amount due", value: invoiceBalance(inv).toFixed(2), inline: true },
      { name: "Due date", value: inv.due_date ?? "—", inline: true }
    )
    .setTimestamp();

  if (link) embed.addFields({ name: "View / Pay", value: link });
  return embed;
}

// ── Core job ────────────────────────────────────────────────────────────────

/**
 * Finds invoices due tomorrow, resolves each client's Discord ID from the
 * configured custom field, and DMs a reminder. Idempotent per due date — an
 * invoice already reminded for its due date is skipped.
 */
export async function runReminderJob(client: Client): Promise<ReminderRunResult> {
  const config = getInvoiceNinjaConfig();
  const result: ReminderRunResult = {
    configured: Boolean(config),
    dueTomorrow: 0,
    sent: 0,
    alreadySent: 0,
    noDiscordId: 0,
    failed: 0,
    errors: [],
  };
  if (!config) return result;

  const tz = getTz();
  const tomorrow = dateStringInTz(tz, 1);
  const today = dateStringInTz(tz, 0);

  let invoices: NinjaInvoice[];
  try {
    invoices = await listUnpaidInvoices(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    logger.error({ err }, "Failed to fetch invoices from Invoice Ninja");
    return result;
  }

  const due = invoices.filter((inv) => isRemindable(inv, tomorrow));
  result.dueTomorrow = due.length;

  for (const inv of due) {
    const discordId = getDiscordId(inv, config);
    if (!discordId) {
      result.noDiscordId++;
      continue;
    }
    if (await hasReminded(tomorrow, inv.id)) {
      result.alreadySent++;
      continue;
    }
    try {
      const user = await client.users.fetch(discordId);
      await user.send({ embeds: [buildReminderEmbed(inv)] });
      await markReminded(tomorrow, inv.id);
      result.sent++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Invoice #${inv.number ?? inv.id}: ${msg}`);
      logger.warn(
        { err, invoiceId: inv.id, discordId },
        "Failed to DM invoice reminder"
      );
    }
  }

  await pruneOldReminders(today);
  return result;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Runs the reminder job once on startup (so restarts never miss the window —
 * sends are deduped), then once a day at REMINDER_HOUR in REMINDER_TZ.
 */
export function startReminderScheduler(client: Client): void {
  if (!getInvoiceNinjaConfig()) {
    logger.warn(
      "INVOICE_NINJA_API_TOKEN not set — invoice reminder scheduler disabled"
    );
    return;
  }

  const tz = getTz();
  const hour = getReminderHour();
  logger.info({ tz, hour }, "Invoice reminder scheduler started");

  let startupDone = false;
  let lastRunDate: string | null = null;

  const tick = async (): Promise<void> => {
    const today = dateStringInTz(tz, 0);
    const shouldRun =
      !startupDone || (hourInTz(tz) === hour && lastRunDate !== today);
    if (!shouldRun) return;

    startupDone = true;
    lastRunDate = today;
    try {
      const res = await runReminderJob(client);
      logger.info({ res }, "Invoice reminder job completed");
    } catch (err) {
      logger.error({ err }, "Invoice reminder job failed");
    }
  };

  void tick();
  setInterval(() => void tick(), 60 * 60 * 1000);
}

// ── Manual /reminder command (admin) ────────────────────────────────────────

function summaryEmbed(res: ReminderRunResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(res.failed > 0 ? 0xf39c12 : 0x2ecc71)
    .setTitle("🧾 Invoice Reminders Sent")
    .setTimestamp()
    .addFields(
      { name: "Due tomorrow", value: String(res.dueTomorrow), inline: true },
      { name: "✅ Sent", value: String(res.sent), inline: true },
      { name: "↩️ Already sent", value: String(res.alreadySent), inline: true },
      {
        name: "❔ No Discord ID",
        value: String(res.noDiscordId),
        inline: true,
      },
      { name: "❌ Failed", value: String(res.failed), inline: true }
    );

  if (res.noDiscordId > 0) {
    embed.setFooter({
      text: "Clients without a Discord ID in the configured custom field were skipped.",
    });
  }
  if (res.errors.length > 0) {
    embed.addFields({
      name: "Errors",
      value: "```\n" + res.errors.slice(0, 8).join("\n").slice(0, 1000) + "\n```",
    });
  }
  return embed;
}

export async function runReminderCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!getInvoiceNinjaConfig()) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("❌ Invoice Ninja not configured")
          .setDescription(
            "Set the `INVOICE_NINJA_API_TOKEN` secret to enable invoice reminders."
          ),
      ],
    });
    return;
  }

  try {
    const res = await runReminderJob(interaction.client);
    await interaction.editReply({ embeds: [summaryEmbed(res)] });
  } catch (err) {
    logger.error({ err }, "Manual /reminder command failed");
    const message = err instanceof Error ? err.message : String(err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("❌ Reminder run failed")
          .setDescription(message.slice(0, 4000)),
      ],
    });
  }
}
