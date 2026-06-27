const DEFAULT_BASE = "https://invoicing.co";
const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;

export type CustomField =
  | "custom_value1"
  | "custom_value2"
  | "custom_value3"
  | "custom_value4";

const CUSTOM_FIELDS: CustomField[] = [
  "custom_value1",
  "custom_value2",
  "custom_value3",
  "custom_value4",
];

export interface InvoiceNinjaConfig {
  token: string;
  baseUrl: string;
  /** Which client custom field holds the recipient's Discord user ID. */
  discordField: CustomField;
}

/** Reads Invoice Ninja config from env, or null if the API token is missing. */
export function getInvoiceNinjaConfig(): InvoiceNinjaConfig | null {
  const token = process.env["INVOICE_NINJA_API_TOKEN"]?.trim();
  if (!token) return null;

  const baseUrl = (
    process.env["INVOICE_NINJA_URL"]?.trim() || DEFAULT_BASE
  ).replace(/\/$/, "");

  const requested = process.env["INVOICE_NINJA_DISCORD_FIELD"]?.trim();
  const discordField: CustomField =
    requested && (CUSTOM_FIELDS as string[]).includes(requested)
      ? (requested as CustomField)
      : "custom_value1";

  return { token, baseUrl, discordField };
}

export interface NinjaClient {
  id: string;
  name?: string;
  display_name?: string;
  custom_value1?: string;
  custom_value2?: string;
  custom_value3?: string;
  custom_value4?: string;
}

export interface NinjaInvoice {
  id: string;
  number?: string;
  due_date?: string;
  /** Numeric status as a string: 1 draft, 2 sent, 3 partial, 4 paid, 5 cancelled. */
  status_id?: string;
  balance?: number;
  amount?: number;
  client_id?: string;
  client?: NinjaClient;
  invitations?: { link?: string }[];
}

interface InvoiceListResponse {
  data: NinjaInvoice[];
  meta?: {
    pagination?: { current_page: number; total_pages: number };
  };
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

function getHeaders(config: InvoiceNinjaConfig): Record<string, string> {
  return {
    "X-API-TOKEN": config.token,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };
}

function errorFor(res: Response): string {
  if (res.status === 401 || res.status === 403) {
    return "Invoice Ninja rejected the API token (check INVOICE_NINJA_API_TOKEN)";
  }
  return `Invoice Ninja request failed (${res.status})`;
}

/** A human-readable label for a client (display name, falling back to name/id). */
export function clientLabel(client: NinjaClient): string {
  return (
    client.display_name?.trim() || client.name?.trim() || `Client ${client.id}`
  );
}

/**
 * Marker the bot prefixes onto the Discord ID it writes into the client custom
 * field. Only values carrying this marker are treated as "linked via the bot",
 * so a raw Discord ID typed into Invoice Ninja by hand is deliberately ignored.
 */
const LINK_PREFIX = "discord:";

/** Encodes a Discord user ID for storage in the client custom field. */
export function encodeDiscordLink(discordId: string): string {
  return `${LINK_PREFIX}${discordId}`;
}

/**
 * Decodes a stored custom-field value into a Discord user ID, but ONLY when it
 * carries the bot's link marker and is a valid Discord snowflake. Returns
 * undefined for unset fields, hand-typed values without the marker, or garbage.
 */
export function decodeDiscordLink(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v || !v.startsWith(LINK_PREFIX)) return undefined;
  const id = v.slice(LINK_PREFIX.length).trim();
  return /^\d{17,20}$/.test(id) ? id : undefined;
}

/**
 * Reads the bot-linked Discord user ID stored on a client, or undefined when
 * the client was not linked through the bot's `/reminder link` command.
 */
export function clientDiscordId(
  config: InvoiceNinjaConfig,
  client: NinjaClient
): string | undefined {
  return decodeDiscordLink(client[config.discordField]);
}

/**
 * Searches active clients by name/number for the link picker (max 25 results).
 * `timeoutMs` should be kept short (≈2.5s) when called from Discord autocomplete,
 * which must respond within Discord's ~3s interaction window.
 */
export async function searchClients(
  config: InvoiceNinjaConfig,
  query: string,
  timeoutMs?: number
): Promise<NinjaClient[]> {
  const params = new URLSearchParams({
    per_page: "25",
    sort: "name|asc",
    status: "active",
  });
  const q = query.trim();
  if (q) params.set("filter", q);

  const res = await fetchWithTimeout(
    `${config.baseUrl}/api/v1/clients?${params}`,
    { headers: getHeaders(config) },
    timeoutMs
  );
  if (!res.ok) throw new Error(errorFor(res));
  const body = (await res.json()) as { data?: NinjaClient[] };
  return body.data ?? [];
}

/** Fetches a single client by id, or null if it doesn't exist. */
export async function getClient(
  config: InvoiceNinjaConfig,
  id: string
): Promise<NinjaClient | null> {
  const res = await fetchWithTimeout(
    `${config.baseUrl}/api/v1/clients/${encodeURIComponent(id)}`,
    { headers: getHeaders(config) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(errorFor(res));
  const body = (await res.json()) as { data?: NinjaClient };
  return body.data ?? null;
}

/** Sets (or clears, when discordId is null) the client's Discord-ID custom field. */
export async function setClientDiscordId(
  config: InvoiceNinjaConfig,
  id: string,
  discordId: string | null
): Promise<NinjaClient> {
  const res = await fetchWithTimeout(
    `${config.baseUrl}/api/v1/clients/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { ...getHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify({
        [config.discordField]: discordId ? encodeDiscordLink(discordId) : "",
      }),
    }
  );
  if (!res.ok) throw new Error(errorFor(res));
  const body = (await res.json()) as { data?: NinjaClient };
  if (!body.data) {
    throw new Error("Invoice Ninja returned no client after update");
  }
  return body.data;
}

/**
 * Fetches all unpaid invoices (paginated), each with its client embedded so the
 * Discord-ID custom field is available without a second request.
 */
export async function listUnpaidInvoices(
  config: InvoiceNinjaConfig
): Promise<NinjaInvoice[]> {
  const all: NinjaInvoice[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      include: "client",
      client_status: "unpaid",
      per_page: String(PER_PAGE),
      page: String(page),
    });

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${config.baseUrl}/api/v1/invoices?${params}`,
        {
          headers: {
            "X-API-TOKEN": config.token,
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json",
          },
        }
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Timed out reaching Invoice Ninja after ${TIMEOUT_MS / 1000}s`
        );
      }
      throw new Error(
        `Network error reaching Invoice Ninja: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Invoice Ninja rejected the API token (check INVOICE_NINJA_API_TOKEN)"
      );
    }
    if (!res.ok) {
      throw new Error(`Invoice Ninja request failed (${res.status})`);
    }

    const body = (await res.json()) as InvoiceListResponse;
    all.push(...(body.data ?? []));

    const pagination = body.meta?.pagination;
    if (!pagination || pagination.current_page >= pagination.total_pages) break;
    page += 1;
  }

  return all;
}
