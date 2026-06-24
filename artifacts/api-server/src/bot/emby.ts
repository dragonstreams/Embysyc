export interface EmbyAuth {
  userId: string;
  token: string;
  serverUrl: string;
}

export interface EmbyItem {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  SeasonName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProviderIds?: Record<string, string>;
  UserData?: {
    Played?: boolean;
    IsFavorite?: boolean;
    PlaybackPositionTicks?: number;
  };
}

export interface EmbyItemsResponse {
  Items: EmbyItem[];
  TotalRecordCount: number;
}

const EMBY_AUTH_HEADER = (token: string) =>
  `MediaBrowser Client="EmbyDiscordBot", Device="DiscordBot", DeviceId="emby-discord-bot", Version="1.0.0", Token="${token}"`;

const TIMEOUT_MS = 15_000;

function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export async function authenticate(
  serverUrl: string,
  username: string,
  password: string
): Promise<EmbyAuth> {
  const base = serverUrl.replace(/\/$/, "");

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${base}/Users/AuthenticateByName`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Emby-Authorization": `MediaBrowser Client="EmbyDiscordBot", Device="DiscordBot", DeviceId="emby-discord-bot", Version="1.0.0"`,
        },
        body: JSON.stringify({ Username: username, Pw: password }),
      }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Connection timed out after ${TIMEOUT_MS / 1000}s — is the server URL reachable?`);
    }
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Authentication failed (${res.status}): ${text || res.statusText}`
    );
  }

  const data = (await res.json()) as {
    User: { Id: string };
    AccessToken: string;
  };
  return { userId: data.User.Id, token: data.AccessToken, serverUrl: base };
}

const CONNECT_BASE = "https://connect.emby.media";
const CONNECT_APP = "EmbyDiscordBot/1.0.0";

interface ConnectServer {
  Url?: string;
  LocalAddress?: string;
  AccessKey?: string;
  Name?: string;
}

function hostKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`.toLowerCase();
  } catch {
    return url.replace(/\/$/, "").toLowerCase();
  }
}

/**
 * Authenticates via Emby Connect (cloud account email/username + password),
 * then exchanges the Connect token for a local access token on the target server.
 */
export async function authenticateConnect(
  serverUrl: string,
  emailOrUsername: string,
  password: string
): Promise<EmbyAuth> {
  const base = serverUrl.replace(/\/$/, "");

  // 1. Authenticate against the Emby Connect cloud service.
  let authRes: Response;
  try {
    authRes = await fetchWithTimeout(`${CONNECT_BASE}/service/user/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Application": CONNECT_APP,
      },
      body: new URLSearchParams({ nameOrEmail: emailOrUsername, rawpw: password }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Timed out reaching Emby Connect (connect.emby.media)");
    }
    throw new Error(`Network error reaching Emby Connect: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!authRes.ok) {
    throw new Error(
      `Emby Connect sign-in failed (${authRes.status}) — check the email/username and password`
    );
  }

  const connect = (await authRes.json()) as {
    AccessToken?: string;
    User?: { Id?: string };
  };
  const connectUserId = connect.User?.Id;
  const connectToken = connect.AccessToken;
  if (!connectUserId || !connectToken) {
    throw new Error("Unexpected response from Emby Connect during sign-in");
  }

  // 2. List servers linked to this Connect account.
  let serversRes: Response;
  try {
    serversRes = await fetchWithTimeout(
      `${CONNECT_BASE}/service/servers?userId=${encodeURIComponent(connectUserId)}`,
      {
        headers: {
          "X-Application": CONNECT_APP,
          "X-Connect-UserToken": connectToken,
        },
      }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Timed out listing servers from Emby Connect");
    }
    throw new Error(`Network error listing Connect servers: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!serversRes.ok) {
    throw new Error(`Failed to list Emby Connect servers (${serversRes.status})`);
  }

  const servers = (await serversRes.json()) as ConnectServer[];
  if (!servers.length) {
    throw new Error("This Emby Connect account has no linked servers");
  }

  // 3. Match the requested server by host, or fall back to the only linked one.
  const wantHost = hostKey(base);
  const target =
    servers.find(
      (s) =>
        (s.Url && hostKey(s.Url) === wantHost) ||
        (s.LocalAddress && hostKey(s.LocalAddress) === wantHost)
    ) ?? (servers.length === 1 ? servers[0] : undefined);

  if (!target) {
    const names = servers.map((s) => s.Name || s.Url || "unknown").join(", ");
    throw new Error(
      `Couldn't match "${base}" to a server on this Connect account. Linked servers: ${names}`
    );
  }
  if (!target.AccessKey) {
    throw new Error("Matched Connect server is missing an access key");
  }

  // 4. Exchange the Connect identity for a local server access token.
  let exchangeRes: Response;
  try {
    exchangeRes = await fetchWithTimeout(
      `${base}/Connect/Exchange?ConnectUserId=${encodeURIComponent(connectUserId)}&format=json`,
      { headers: { "X-Emby-Token": target.AccessKey } }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out exchanging Connect token with ${base}`);
    }
    throw new Error(`Network error during Connect exchange: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!exchangeRes.ok) {
    throw new Error(
      `Connect token exchange failed (${exchangeRes.status}) — is Emby Connect enabled on this server?`
    );
  }

  const exchanged = (await exchangeRes.json()) as {
    LocalUserId?: string;
    AccessToken?: string;
  };
  if (!exchanged.LocalUserId || !exchanged.AccessToken) {
    throw new Error("Connect exchange returned no local access token for this server");
  }
  return { userId: exchanged.LocalUserId, token: exchanged.AccessToken, serverUrl: base };
}

export async function getItems(
  auth: EmbyAuth,
  options: {
    isFavorite?: boolean;
    isPlayed?: boolean;
    types?: string[];
    startIndex?: number;
    limit?: number;
  }
): Promise<EmbyItemsResponse> {
  const params = new URLSearchParams({
    Recursive: "true",
    Fields: "ProviderIds,ParentIndexNumber,IndexNumber,SeriesName,UserData",
    Limit: String(options.limit ?? 500),
    StartIndex: String(options.startIndex ?? 0),
  });

  if (options.isFavorite) params.set("Filters", "IsFavorite");
  if (options.isPlayed) params.set("IsPlayed", "true");
  if (options.types?.length)
    params.set("IncludeItemTypes", options.types.join(","));

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${auth.serverUrl}/Users/${auth.userId}/Items?${params}`,
      { headers: { "X-Emby-Authorization": EMBY_AUTH_HEADER(auth.token) } },
      30_000 // larger page fetches can take longer
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Timed out fetching items from Emby — the server may be overloaded");
    }
    throw new Error(`Network error fetching items: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new Error(`Failed to fetch items (${res.status})`);
  return res.json() as Promise<EmbyItemsResponse>;
}

export async function getAllItems(
  auth: EmbyAuth,
  options: { isFavorite?: boolean; isPlayed?: boolean; types?: string[] }
): Promise<EmbyItem[]> {
  const pageSize = 500;
  let startIndex = 0;
  const all: EmbyItem[] = [];

  while (true) {
    const page = await getItems(auth, { ...options, startIndex, limit: pageSize });
    all.push(...page.Items);
    if (all.length >= page.TotalRecordCount) break;
    startIndex += pageSize;
  }

  return all;
}

async function embyFetch(url: string, auth: EmbyAuth, init: RequestInit = {}): Promise<Response | null> {
  try {
    const res = await fetchWithTimeout(url, {
      ...init,
      headers: {
        "X-Emby-Authorization": EMBY_AUTH_HEADER(auth.token),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

export async function searchItem(
  auth: EmbyAuth,
  name: string,
  type: string
): Promise<EmbyItem | null> {
  const params = new URLSearchParams({
    SearchTerm: name,
    IncludeItemTypes: type,
    Recursive: "true",
    Limit: "5",
    Fields: "ProviderIds,ParentIndexNumber,IndexNumber,SeriesName",
  });

  const res = await embyFetch(
    `${auth.serverUrl}/Users/${auth.userId}/Items?${params}`,
    auth
  );
  if (!res) return null;

  const data = (await res.json()) as EmbyItemsResponse;
  return (
    data.Items.find((i) => i.Name.toLowerCase() === name.toLowerCase()) ??
    data.Items[0] ??
    null
  );
}

export async function searchEpisode(
  auth: EmbyAuth,
  seriesName: string,
  seasonNumber: number,
  episodeNumber: number
): Promise<EmbyItem | null> {
  const params = new URLSearchParams({
    SearchTerm: seriesName,
    IncludeItemTypes: "Episode",
    Recursive: "true",
    Limit: "500",
    Fields: "ProviderIds,ParentIndexNumber,IndexNumber,SeriesName",
  });

  const res = await embyFetch(
    `${auth.serverUrl}/Users/${auth.userId}/Items?${params}`,
    auth
  );
  if (!res) return null;

  const data = (await res.json()) as EmbyItemsResponse;
  return (
    data.Items.find(
      (i) =>
        i.SeriesName?.toLowerCase() === seriesName.toLowerCase() &&
        i.ParentIndexNumber === seasonNumber &&
        i.IndexNumber === episodeNumber
    ) ?? null
  );
}

export async function findMatchingItem(
  destAuth: EmbyAuth,
  srcItem: EmbyItem
): Promise<EmbyItem | null> {
  if (srcItem.Type === "Episode") {
    if (
      srcItem.SeriesName &&
      srcItem.ParentIndexNumber != null &&
      srcItem.IndexNumber != null
    ) {
      return searchEpisode(
        destAuth,
        srcItem.SeriesName,
        srcItem.ParentIndexNumber,
        srcItem.IndexNumber
      );
    }
    return null;
  }
  return searchItem(destAuth, srcItem.Name, srcItem.Type);
}

export async function markFavorite(
  auth: EmbyAuth,
  itemId: string
): Promise<boolean> {
  const res = await embyFetch(
    `${auth.serverUrl}/Users/${auth.userId}/FavoriteItems/${itemId}`,
    auth,
    { method: "POST" }
  );
  return res !== null;
}

export async function markPlayed(
  auth: EmbyAuth,
  itemId: string
): Promise<boolean> {
  const res = await embyFetch(
    `${auth.serverUrl}/Users/${auth.userId}/PlayedItems/${itemId}`,
    auth,
    { method: "POST" }
  );
  return res !== null;
}
