// Direct client for WorshipTools Firestore & Firebase Auth API.
//
// Eliminates the need for an external proxy server (like Ichtus_apps) by:
// 1. Exchanging the Firebase Refresh Token for an ID token via Google SecureToken API.
// 2. Querying Google Cloud Firestore REST API directly for cuelists and song master data.
// 3. Parsing the cues, events, and songs into LibreTracks-compatible models.

import {
  WtApiError,
  type WTLibraryResult,
  type WTRosterResult,
  type WTTeamRoster,
  type WTRosterMember,
  type WTRosterFlatMember,
  type WTService,
  type WTServicesResult,
  type WTSetlistResult,
  type WTSong,
} from "./wtApi";

export type WTCredentials = {
  apiKey: string;
  accountId: string;
  refreshToken: string;
};

export const DEFAULT_WT_API_KEY =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_WT_API_KEY) || "";
export const DEFAULT_WT_ACCOUNT_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_WT_ACCOUNT_ID) || "";
export const DEFAULT_WT_REFRESH_TOKEN =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_WT_REFRESH_TOKEN) || "";

const STORAGE_ACCOUNT_ID_KEY = "lt-worshiptools-account-id";
const STORAGE_REFRESH_TOKEN_KEY = "lt-worshiptools-refresh-token";
const STORAGE_API_KEY_KEY = "lt-worshiptools-api-key";

export function getStoredWtCredentials(): WTCredentials {
  let accountId = DEFAULT_WT_ACCOUNT_ID;
  let refreshToken = DEFAULT_WT_REFRESH_TOKEN;
  let apiKey = DEFAULT_WT_API_KEY;

  try {
    const storedAccount = window.localStorage.getItem(STORAGE_ACCOUNT_ID_KEY);
    if (storedAccount && storedAccount.trim()) accountId = storedAccount.trim();

    const storedRefresh = window.localStorage.getItem(STORAGE_REFRESH_TOKEN_KEY);
    if (storedRefresh && storedRefresh.trim()) refreshToken = storedRefresh.trim();

    const storedApiKey = window.localStorage.getItem(STORAGE_API_KEY_KEY);
    if (storedApiKey && storedApiKey.trim()) apiKey = storedApiKey.trim();
  } catch {
    // localStorage unavailable
  }

  return { accountId, refreshToken, apiKey };
}

export function storeWtCredentials(creds: Partial<WTCredentials>): WTCredentials {
  const current = getStoredWtCredentials();
  const next: WTCredentials = {
    apiKey: creds.apiKey !== undefined ? creds.apiKey.trim() || DEFAULT_WT_API_KEY : current.apiKey,
    accountId: creds.accountId !== undefined ? creds.accountId.trim() || DEFAULT_WT_ACCOUNT_ID : current.accountId,
    refreshToken: creds.refreshToken !== undefined ? creds.refreshToken.trim() || DEFAULT_WT_REFRESH_TOKEN : current.refreshToken,
  };

  try {
    window.localStorage.setItem(STORAGE_ACCOUNT_ID_KEY, next.accountId);
    window.localStorage.setItem(STORAGE_REFRESH_TOKEN_KEY, next.refreshToken);
    window.localStorage.setItem(STORAGE_API_KEY_KEY, next.apiKey);
  } catch {
    // Best-effort persistence
  }

  return next;
}

// ── In-Memory Caches ──────────────────────────────────────────────────────────

const EXCLUDED_TYPE_IDS = new Set([
  "f30f3f88-1e83-4e1a-bc60-ef3974a071fb", // Ichtus Kids Blauw
]);

const DAGNAMEN = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
const MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

const CACHE_TTL_MS = 5 * 60 * 1000;
const SONG_CACHE_TTL_MS = 60 * 1000;

let tokenCache: { token: string | null; expiresAt: number } = {
  token: null,
  expiresAt: 0,
};

export const ROLE_MAP: Record<
  string,
  { role: string; team: string; teamOrder: number; roleOrder: number }
> = {
  "cbb79b68-2e6f-46e4-9d32-917a71d8236e": { role: "Tech Director", team: "Tech Team", teamOrder: 1, roleOrder: 1 },
  "bfd25f3f-ef53-4a7b-813a-fdede2b1f0b8": { role: "Audio", team: "Tech Team", teamOrder: 1, roleOrder: 2 },
  "63354086-2a9d-451f-ab86-75d0f67f68ae": { role: "Beamer", team: "Tech Team", teamOrder: 1, roleOrder: 3 },
  "412d2989-bd3a-4988-8d09-3f7fd4367843": { role: "Stream", team: "Tech Team", teamOrder: 1, roleOrder: 4 },
  "7c7461bd-bfd0-4215-a180-e376ffb8d1b0": { role: "Lighting", team: "Tech Team", teamOrder: 1, roleOrder: 5 },
  "d7b38845-2e13-4a56-86e6-69c49ff4c6f3": { role: "In-Ear Mixer", team: "Tech Team", teamOrder: 1, roleOrder: 6 },
  "84a10f22-52ef-43cc-9025-f3a3ccc2ac85": { role: "Backstage Assistant", team: "Tech Team", teamOrder: 1, roleOrder: 7 },
  "da8c7f47-c974-41ee-ab2a-3809f8f5d26e": { role: "Worship Leader", team: "Worship Team", teamOrder: 2, roleOrder: 1 },
  "9ccf7768-505d-4612-b058-0c6b5a773b4e": { role: "Vocalist", team: "Worship Team", teamOrder: 2, roleOrder: 2 },
  "18645fa3-d48a-4c48-b51a-afd3652f3927": { role: "Piano", team: "Worship Team", teamOrder: 2, roleOrder: 3 },
  "dd360357-71f6-4892-8405-5d748080c6fd": { role: "Keys", team: "Worship Team", teamOrder: 2, roleOrder: 4 },
  "5799674f-da38-4b6a-9825-32e41d2c8755": { role: "Guitar", team: "Worship Team", teamOrder: 2, roleOrder: 5 },
  "ab4bc739-d984-45af-929a-53a2673876a7": { role: "Electric Guitar", team: "Worship Team", teamOrder: 2, roleOrder: 6 },
  "ecf3052e-115b-40e0-a247-6b9772722296": { role: "Bass Guitar", team: "Worship Team", teamOrder: 2, roleOrder: 7 },
  "5530795a-bd30-454e-99fe-a5073c93b620": { role: "Drums", team: "Worship Team", teamOrder: 2, roleOrder: 8 },
  "36b4098b-096e-4e94-ad3e-f51b35a8e670": { role: "Saxophone", team: "Worship Team", teamOrder: 2, roleOrder: 9 },
};

export const DEFAULT_PEOPLE_CACHE: Record<string, string> = {};

let peopleCache: Record<string, string> = { ...DEFAULT_PEOPLE_CACHE };

let servicesCache: WTServicesResult & { fetchedAt: number } | null = null;
let servicesFetchPromise: Promise<WTServicesResult> | null = null;

const fullDocCache = new Map<string, any>();
const songDocCache = new Map<string, { doc: any; timestamp: number }>();

let songLibraryCache: WTLibraryResult & { fetchedAt: number } | null = null;

export function setPeopleCache(cache: Record<string, string>): void {
  peopleCache = { ...cache };
}

export function clearDirectCaches(): void {
  tokenCache = { token: null, expiresAt: 0 };
  servicesCache = null;
  servicesFetchPromise = null;
  fullDocCache.clear();
  songDocCache.clear();
  songLibraryCache = null;
  peopleCache = { ...DEFAULT_PEOPLE_CACHE };
}

// ── Authentication ────────────────────────────────────────────────────────────

export async function getAccessToken(force = false, creds?: WTCredentials): Promise<string> {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const effectiveCreds = creds ?? getStoredWtCredentials();
  if (!effectiveCreds.refreshToken || !effectiveCreds.apiKey) {
    throw new WtApiError("WorshipTools credentials missing. Check Account ID and Refresh Token.");
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }

    try {
      const response = await fetch(
        `https://securetoken.googleapis.com/v1/token?key=${effectiveCreds.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: effectiveCreds.refreshToken,
          }).toString(),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new WtApiError(
          `Authentication failed (HTTP ${response.status}). Refresh token expired? ${text.slice(0, 160)}`,
        );
        if (DEFAULT_WT_REFRESH_TOKEN && effectiveCreds.refreshToken !== DEFAULT_WT_REFRESH_TOKEN) {
          console.warn("WorshipTools stored refresh token failed, reverting to default active token");
          effectiveCreds.refreshToken = DEFAULT_WT_REFRESH_TOKEN;
          storeWtCredentials({ refreshToken: DEFAULT_WT_REFRESH_TOKEN });
        }
        continue;
      }

      const data = await response.json();
      if (!data.id_token) {
        lastError = new WtApiError("Authentication response missing id_token");
        continue;
      }

      const expiresIn = parseInt(data.expires_in, 10) || 3600;
      const token = data.id_token as string;
      tokenCache = {
        token,
        expiresAt: Date.now() + expiresIn * 1000,
      };

      if (data.refresh_token && data.refresh_token !== effectiveCreds.refreshToken) {
        storeWtCredentials({ refreshToken: data.refresh_token });
      }

      return token;
    } catch (error) {
      lastError = error instanceof Error ? error : new WtApiError(String(error));
    }
  }

  throw lastError ?? new WtApiError("Failed to obtain authentication token.");
}

// ── Firestore Helper Functions ───────────────────────────────────────────────

const vStr = (obj: any, key: string, dflt = ""): string =>
  obj && obj[key] && obj[key].stringValue !== undefined ? obj[key].stringValue : dflt;

const vMapFields = (obj: any, key: string): any =>
  (obj && obj[key] && obj[key].mapValue && obj[key].mapValue.fields) || {};

const vArrValues = (obj: any, key: string): any[] =>
  (obj && obj[key] && obj[key].arrayValue && obj[key].arrayValue.values) || [];

function parseIso(val: string | null | undefined): Date | null {
  if (!val) return null;
  let clean = String(val).replace("Z", "");
  if (clean.includes(".")) clean = clean.split(".")[0];
  const dt = new Date(clean);
  return isNaN(dt.getTime()) ? null : dt;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatDutch(dt: Date | null): string {
  if (!dt) return "Geen datum";
  const dag = DAGNAMEN[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
  const maand = MAANDEN[dt.getMonth()];
  return `${dag} ${pad2(dt.getDate())} ${maand} ${dt.getFullYear()} - ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function formatRehearsal(dt: Date): string {
  const dag = DAGNAMEN[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
  return `${dag} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function toClientService(s: { id: string; name: string; mainDt: Date; rehearsals: Date[]; cuesCount: number }, now: Date): WTService {
  return {
    id: s.id,
    name: s.name,
    datetime: s.mainDt.toISOString(),
    displayDate: formatDutch(s.mainDt),
    time: `${pad2(s.mainDt.getHours())}:${pad2(s.mainDt.getMinutes())}`,
    isToday: s.mainDt.toDateString() === now.toDateString(),
    isPast: s.mainDt < now,
    cuesCount: s.cuesCount,
    rehearsals: s.rehearsals.map(formatRehearsal),
  };
}

function parseEvent(doc: any): { id: string; name: string; mainDt: Date; rehearsals: Date[]; cuesCount: number; doc: any } | null {
  const fields = doc.fields || {};
  const docId = (doc.name || "").split("/").pop();

  const serviceObj = vMapFields(fields, "service");
  const dataObj = vMapFields(fields, "data");

  const serviceTypeId = vStr(serviceObj, "type");
  if (EXCLUDED_TYPE_IDS.has(serviceTypeId)) return null;

  const eventName =
    vStr(serviceObj, "name") ||
    vStr(fields, "name") ||
    vStr(dataObj, "cuelist_title") ||
    "Kerkdienst";

  const timesArray = vArrValues(serviceObj, "times");
  const parsedSlots: { dt: Date; isRehearsal: boolean }[] = [];

  for (const item of timesArray) {
    const f = (item && item.mapValue && item.mapValue.fields) || {};
    const dt = parseIso(vStr(f, "time"));
    if (dt) {
      const slotType = vStr(f, "type");
      parsedSlots.push({ dt, isRehearsal: slotType.toLowerCase() === "rehearsal" });
    }
  }

  let mainDt: Date | null = null;
  let rehearsals: Date[] = [];

  if (parsedSlots.length > 0) {
    const mainEvent = [...parsedSlots].reverse().find((s) => !s.isRehearsal) || parsedSlots[parsedSlots.length - 1];
    mainDt = mainEvent.dt;
    rehearsals = parsedSlots.filter((s) => s !== mainEvent).map((s) => s.dt);
  } else {
    const altDateStr =
      vStr(vMapFields(dataObj, "cuelist_options"), "date") ||
      vStr(fields, "post") ||
      doc.createTime;
    mainDt = parseIso(altDateStr);
  }

  if (!mainDt) return null;

  const cues = vArrValues(dataObj, "cues");

  return {
    id: docId,
    name: eventName,
    mainDt,
    rehearsals,
    cuesCount: cues.length,
    doc,
  };
}

function cuelistsBaseUrl(accountId: string): string {
  return `https://firestore.googleapis.com/v1/projects/worship-extreme-datastore/databases/(default)/documents/accounts/${encodeURIComponent(accountId)}/cuelists`;
}

function songsBaseUrl(accountId: string): string {
  return `https://firestore.googleapis.com/v1/projects/worship-extreme-datastore/databases/(default)/documents/accounts/${encodeURIComponent(accountId)}/songs`;
}

async function fetchCuelistDocuments(accessToken: string, accountId: string): Promise<any[]> {
  const docs: any[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < 5; page++) {
    let url = `${cuelistsBaseUrl(accountId)}?pageSize=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401 || response.status === 403) {
      throw new WtApiError(`Firestore permission denied (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new WtApiError(`Firestore error HTTP ${response.status}`);
    }

    const data = await response.json();
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return docs;
}

async function fetchSingleCuelist(accessToken: string, accountId: string, id: string): Promise<any | null> {
  const url = `${cuelistsBaseUrl(accountId)}/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new WtApiError(`Firestore permission denied (HTTP ${response.status})`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new WtApiError(`Firestore error HTTP ${response.status}`);
  return response.json();
}

async function fetchSongDocument(
  accessToken: string,
  accountId: string,
  songId: string,
  force = false,
): Promise<any | null> {
  if (!songId) return null;
  const cached = songDocCache.get(songId);
  if (!force && cached && Date.now() - cached.timestamp < SONG_CACHE_TTL_MS) {
    return cached.doc;
  }

  const url = `${songsBaseUrl(accountId)}/${encodeURIComponent(songId)}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const doc = await response.json();
    songDocCache.set(songId, { doc, timestamp: Date.now() });
    return doc;
  } catch {
    return null;
  }
}

async function extractSongs(
  doc: any,
  accessToken: string,
  accountId: string,
  force = false,
): Promise<WTSong[]> {
  const dataObj = vMapFields(doc.fields || {}, "data");
  const cues = vArrValues(dataObj, "cues");
  const songMeta = vMapFields(dataObj, "songMeta");

  const songDocs = await Promise.all(
    cues.map((cue: any) => {
      const f = (cue && cue.mapValue && cue.mapValue.fields) || {};
      const songId = f.cue_foreground?.mapValue?.fields?.text?.stringValue;
      return songId ? fetchSongDocument(accessToken, accountId, songId, force) : Promise.resolve(null);
    }),
  );

  return cues.map((cue: any, i: number) => {
    const f = (cue && cue.mapValue && cue.mapValue.fields) || {};
    const cueId = vStr(f, "cue_id");
    const title = vStr(f, "displayName") || "Naamloos";
    const meta = (songMeta[cueId] && songMeta[cueId].mapValue && songMeta[cueId].mapValue.fields) || {};
    const songDoc = songDocs[i];
    const sData = (songDoc && songDoc.fields && songDoc.fields.data && songDoc.fields.data.mapValue && songDoc.fields.data.mapValue.fields) || {};

    const metaKey = vStr(meta, "key");
    const sKey = vStr(sData, "defaultKey");
    const key = (metaKey && metaKey !== "—" && metaKey !== "-") ? metaKey : (sKey || metaKey || "—");

    const rawTempo =
      (meta.tempo && (meta.tempo.integerValue || meta.tempo.stringValue)) ||
      (sData.tempo && (sData.tempo.integerValue || sData.tempo.stringValue)) ||
      (sData.bpm && (sData.bpm.integerValue || sData.bpm.stringValue)) ||
      null;
    const bpm = rawTempo ? parseInt(rawTempo, 10) : null;

    const meter = vStr(meta, "meter") || vStr(sData, "timeSignature") || "4/4";

    return {
      position: i + 1,
      cueId,
      songId: f.cue_foreground?.mapValue?.fields?.text?.stringValue || null,
      title,
      key,
      bpm,
      meter,
    };
  });
}

function toClientSong(doc: any): WTSong {
  const fields = doc.fields || {};
  const sData = vMapFields(fields, "data");
  const rawTempo =
    (sData.tempo && (sData.tempo.integerValue || sData.tempo.stringValue)) ||
    (sData.bpm && (sData.bpm.integerValue || sData.bpm.stringValue)) ||
    null;
  return {
    songId: (doc.name || "").split("/").pop(),
    title: vStr(fields, "name"),
    key: vStr(sData, "defaultKey") || "—",
    bpm: rawTempo ? parseInt(rawTempo, 10) : null,
    meter: vStr(sData, "timeSignature") || "4/4",
  };
}

// ── Public Direct API Methods ─────────────────────────────────────────────────

export async function directFetchServices(force = false, creds?: WTCredentials): Promise<WTServicesResult> {
  if (!force && servicesCache && Date.now() - servicesCache.fetchedAt < CACHE_TTL_MS) {
    return servicesCache;
  }
  if (!force && servicesFetchPromise) return servicesFetchPromise;

  const effectiveCreds = creds ?? getStoredWtCredentials();

  servicesFetchPromise = (async () => {
    let token = await getAccessToken(force, effectiveCreds);
    let docs: any[];

    try {
      docs = await fetchCuelistDocuments(token, effectiveCreds.accountId);
    } catch (error) {
      if (error instanceof WtApiError && error.message.includes("permission denied")) {
        token = await getAccessToken(true, effectiveCreds);
        docs = await fetchCuelistDocuments(token, effectiveCreds.accountId);
      } else {
        throw error;
      }
    }

    const now = new Date();
    const parsed = docs.map(parseEvent).filter((s): s is NonNullable<typeof s> => s !== null);

    const upcoming = parsed
      .filter((s) => s.mainDt >= now)
      .sort((a, b) => a.mainDt.getTime() - b.mainDt.getTime())
      .slice(0, 10);

    const past = parsed
      .filter((s) => s.mainDt < now)
      .sort((a, b) => b.mainDt.getTime() - a.mainDt.getTime())
      .slice(0, 4);

    fullDocCache.clear();
    for (const s of parsed) {
      fullDocCache.set(s.id, s.doc);
    }

    servicesCache = {
      upcoming: upcoming.map((s) => toClientService(s, now)),
      past: past.map((s) => toClientService(s, now)),
      count: upcoming.length + past.length,
      fetchedAt: Date.now(),
    };

    return servicesCache;
  })().finally(() => {
    servicesFetchPromise = null;
  });

  return servicesFetchPromise;
}

export async function directFetchSetlist(
  serviceId: string,
  force = false,
  creds?: WTCredentials,
): Promise<WTSetlistResult> {
  const effectiveCreds = creds ?? getStoredWtCredentials();
  let doc = fullDocCache.get(serviceId);

  let token = await getAccessToken(false, effectiveCreds);

  if (force || !doc) {
    try {
      doc = await fetchSingleCuelist(token, effectiveCreds.accountId, serviceId);
    } catch (error) {
      if (error instanceof WtApiError && error.message.includes("permission denied")) {
        token = await getAccessToken(true, effectiveCreds);
        doc = await fetchSingleCuelist(token, effectiveCreds.accountId, serviceId);
      } else {
        throw error;
      }
    }
    if (!doc) throw new WtApiError("Service not found");
    fullDocCache.set(serviceId, doc);
  }

  const parsed = parseEvent(doc);
  const songs = await extractSongs(doc, token, effectiveCreds.accountId, force);
  const now = new Date();

  return {
    service: parsed
      ? toClientService(parsed, now)
      : { id: serviceId, name: "Onbekende dienst", displayDate: "Geen datum" },
    songs,
    count: songs.length,
  };
}

export async function directFetchLibrary(force = false, creds?: WTCredentials): Promise<WTLibraryResult> {
  if (!force && songLibraryCache && Date.now() - songLibraryCache.fetchedAt < CACHE_TTL_MS) {
    return songLibraryCache;
  }

  const effectiveCreds = creds ?? getStoredWtCredentials();
  let token = await getAccessToken(force, effectiveCreds);

  const docs: any[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < 20; page++) {
    let url = `${songsBaseUrl(effectiveCreds.accountId)}?pageSize=500`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken(token)}` },
    });

    if (response.status === 401 || response.status === 403) {
      token = await getAccessToken(true, effectiveCreds);
      const retry = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!retry.ok) throw new WtApiError(`Firestore error HTTP ${retry.status}`);
      const data = await retry.json();
      docs.push(...(data.documents || []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
      continue;
    }

    if (!response.ok) throw new WtApiError(`Firestore error HTTP ${response.status}`);
    const data = await response.json();
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  const songs = docs.map(toClientSong);
  songLibraryCache = {
    songs,
    count: songs.length,
    updatedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
  };

  return songLibraryCache;
}

function normalizeStatus(raw: string): "accepted" | "declined" | "pending" {
  const lower = raw.trim().toLowerCase();
  if (lower === "accepted") return "accepted";
  if (lower === "declined") return "declined";
  return "pending";
}

export function buildRoster(peopleDocs: any[]): WTTeamRoster[] {
  const teamsMap = new Map<string, WTTeamRoster>();

  for (const doc of peopleDocs) {
    const f = (doc && doc.fields) || {};
    const userId = vStr(f, "user");
    const roleId = vStr(f, "role");
    const status = normalizeStatus(vStr(f, "status", "pending"));

    const rInfo = ROLE_MAP[roleId];
    if (!rInfo) continue; // Unknown roles silently skipped per §5.4

    const fallbackName =
      userId.length >= 8
        ? `Onbekend (${userId.slice(0, 8)})`
        : `Onbekend (${userId})`;
    const name = peopleCache[userId] || fallbackName;

    if (!teamsMap.has(rInfo.team)) {
      teamsMap.set(rInfo.team, {
        name: rInfo.team,
        order: rInfo.teamOrder,
        accepted: 0,
        declined: 0,
        pending: 0,
        members: [],
      });
    }

    const team = teamsMap.get(rInfo.team)!;
    if (status === "accepted") team.accepted += 1;
    else if (status === "declined") team.declined += 1;
    else team.pending += 1;

    team.members.push({
      role: rInfo.role,
      roleOrder: rInfo.roleOrder,
      name,
      status,
      userId,
    });
  }

  const sortedTeams = Array.from(teamsMap.values()).sort(
    (a, b) => a.order - b.order,
  );
  for (const t of sortedTeams) {
    t.members.sort((a, b) => {
      if (a.roleOrder !== b.roleOrder) return a.roleOrder - b.roleOrder;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }
  return sortedTeams;
}

export async function directFetchRoster(
  serviceId: string,
  force = false,
  creds?: WTCredentials,
): Promise<WTRosterResult> {
  const effectiveCreds = creds ?? getStoredWtCredentials();
  let token = await getAccessToken(force, effectiveCreds);

  let cuelistDoc = fullDocCache.get(serviceId);
  if (!cuelistDoc) {
    cuelistDoc = await fetchSingleCuelist(token, effectiveCreds.accountId, serviceId);
    if (cuelistDoc) fullDocCache.set(serviceId, cuelistDoc);
  }

  const now = new Date();
  const parsed = cuelistDoc ? parseEvent(cuelistDoc) : null;
  const serviceInfo = parsed
    ? toClientService(parsed, now)
    : { id: serviceId, name: "Onbekende dienst", displayDate: "Geen datum" };

  const url = `${cuelistsBaseUrl(effectiveCreds.accountId)}/${encodeURIComponent(serviceId)}/people?pageSize=300`;
  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    token = await getAccessToken(true, effectiveCreds);
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  let peopleDocs: any[] = [];
  if (response.ok) {
    const data = await response.json();
    peopleDocs = data.documents || [];
  } else if (response.status !== 404) {
    throw new WtApiError(`Firestore error HTTP ${response.status}`);
  }

  const teams = buildRoster(peopleDocs);

  // Flat roster excludes declined members per spec §6.1
  const roster: WTRosterFlatMember[] = [];
  let declinedCount = 0;
  for (const team of teams) {
    for (const m of team.members) {
      if (m.status !== "declined") {
        roster.push({
          name: m.name,
          role: m.role,
          status: m.status,
          team: team.name,
          userId: m.userId,
        });
      } else {
        declinedCount += 1;
      }
    }
  }

  const acceptedCount = roster.filter((r) => r.status === "accepted").length;
  const pendingCount = roster.filter((r) => r.status === "pending").length;

  return {
    service: {
      id: serviceInfo.id,
      name: serviceInfo.name,
      displayDate: serviceInfo.displayDate,
    },
    teams,
    roster,
    counts: {
      total: roster.length + declinedCount,
      accepted: acceptedCount,
      pending: pendingCount,
      declined: declinedCount,
    },
  };
}

function accessToken(token: string): string {
  return token;
}
