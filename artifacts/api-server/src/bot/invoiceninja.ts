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
