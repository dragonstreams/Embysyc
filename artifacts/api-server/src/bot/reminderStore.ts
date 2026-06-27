import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";

/**
 * Tracks which invoices have already had a reminder sent, keyed by the invoice's
 * due date. Persisted to disk so a restart on the same day doesn't re-DM users.
 */
const FILE = path.join(process.cwd(), ".data", "invoice-reminders.json");

type Store = Record<string, string[]>; // dueDate (YYYY-MM-DD) -> invoiceIds

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    // No file yet — start empty.
    cache = {};
    return cache;
  }
  try {
    cache = JSON.parse(raw) as Store;
  } catch (err) {
    // Corrupt file: back it up so we don't silently keep failing, then reset.
    logger.warn(
      { err },
      "Invoice reminder store is corrupt — backing up and resetting"
    );
    try {
      await fs.rename(FILE, `${FILE}.corrupt-${Date.now()}`);
    } catch (renameErr) {
      logger.warn({ err: renameErr }, "Could not back up corrupt reminder store");
    }
    cache = {};
  }
  return cache;
}

async function save(store: Store): Promise<void> {
  cache = store;
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    // Atomic write: write to a temp file then rename over the target.
    const tmp = `${FILE}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(store), "utf8");
    await fs.rename(tmp, FILE);
  } catch (err) {
    logger.warn({ err }, "Could not persist invoice reminder store");
  }
}

export async function hasReminded(
  dueDate: string,
  invoiceId: string
): Promise<boolean> {
  const store = await load();
  return store[dueDate]?.includes(invoiceId) ?? false;
}

export async function markReminded(
  dueDate: string,
  invoiceId: string
): Promise<void> {
  const store = await load();
  (store[dueDate] ??= []).push(invoiceId);
  await save(store);
}

/** Drops tracking entries for due dates strictly before `keepFrom` (YYYY-MM-DD). */
export async function pruneOldReminders(keepFrom: string): Promise<void> {
  const store = await load();
  let changed = false;
  for (const date of Object.keys(store)) {
    if (date < keepFrom) {
      delete store[date];
      changed = true;
    }
  }
  if (changed) await save(store);
}
