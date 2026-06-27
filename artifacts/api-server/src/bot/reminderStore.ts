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
  try {
    const raw = await fs.readFile(FILE, "utf8");
    cache = JSON.parse(raw) as Store;
  } catch {
    cache = {};
  }
  return cache;
}

async function save(store: Store): Promise<void> {
  cache = store;
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(store), "utf8");
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
