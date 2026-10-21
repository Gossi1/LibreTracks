// Client for WorshipTools Services API.
//
// Supports two connection modes:
// 1. "direct" (Default): LibreTracks connects directly to WorshipTools' Firebase Auth & Firestore REST API
//    without requiring an external server.
// 2. "server": Connects to the local/remote Ichtus server proxy (http://127.0.0.1:8080).

import {
  directFetchLibrary,
  directFetchRoster,
  directFetchServices,
  directFetchSetlist,
  getStoredWtCredentials,
  storeWtCredentials,
  setPeopleCache,
  type WTCredentials,
} from "./wtDirect";

export {
  getStoredWtCredentials,
  storeWtCredentials,
  setPeopleCache,
  type WTCredentials,
  directFetchLibrary,
  directFetchRoster,
  directFetchServices,
  directFetchSetlist,
};

export const DEFAULT_WT_SERVER_URL = "http://127.0.0.1:8080";

export type WTConnectionMode = "direct" | "server";
export const DEFAULT_WT_CONNECTION_MODE: WTConnectionMode = "direct";

const MODE_STORAGE_KEY = "lt-worshiptools-connection-mode";
const URL_STORAGE_KEY = "lt-worshiptools-server-url";
const REQUEST_TIMEOUT_MS = 15_000;

export type WTService = {
  id: string;
  name: string;
  datetime: string;
  displayDate: string;
  time: string;
  isToday: boolean;
  isPast: boolean;
  cuesCount: number;
  rehearsals: string[];
};

export type WTSong = {
  /**
   * Library song id. The setlist payload does NOT carry it — it only emits
   * `cueId` and `position` — so treat this as optional and never use it as a
   * per-row identity for setlist items.
   */
  songId?: string | null;
  title: string;
  key: string;
  bpm: number | null;
  meter: string;
  /** Unique per cue in a setlist; absent from the library payload. */
  cueId?: string | null;
  /** 1-based position within the service; absent from the library payload. */
  position?: number | null;
};

export type WTServicesResult = {
  upcoming: WTService[];
  past: WTService[];
  count: number;
};

export type WTSetlistResult = {
  service: Pick<WTService, "id" | "name" | "displayDate">;
  songs: WTSong[];
  count: number;
};

export type WTLibraryResult = {
  songs: WTSong[];
  count: number;
  updatedAt?: string;
};

export type WTRosterMember = {
  role: string;
  roleOrder: number;
  name: string;
  status: "accepted" | "declined" | "pending";
  userId: string;
};

export type WTRosterFlatMember = {
  name: string;
  role: string;
  status: "accepted" | "declined" | "pending";
  team: string;
  userId: string;
};

export type WTTeamRoster = {
  name: string;
  order: number;
  accepted: number;
  declined: number;
  pending: number;
  members: WTRosterMember[];
};

export type WTRosterCounts = {
  total: number;
  accepted: number;
  pending: number;
  declined: number;
};

export type WTRosterResult = {
  service: Pick<WTService, "id" | "name" | "displayDate">;
  teams: WTTeamRoster[];
  roster: WTRosterFlatMember[];
  counts: WTRosterCounts;
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getStoredWtConnectionMode(): WTConnectionMode {
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === "direct" || stored === "server") return stored;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WT_CONNECTION_MODE;
}

export function storeWtConnectionMode(mode: WTConnectionMode): WTConnectionMode {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort
  }
  return mode;
}

export function getStoredWtServerUrl(): string {
  try {
    const stored = window.localStorage.getItem(URL_STORAGE_KEY);
    if (stored && stored.trim()) return normalizeBaseUrl(stored);
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WT_SERVER_URL;
}

export function storeWtServerUrl(url: string): string {
  const normalized = normalizeBaseUrl(url);
  try {
    window.localStorage.setItem(URL_STORAGE_KEY, normalized);
  } catch {
    // Persisting is best-effort
  }
  return normalized;
}

export class WtApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WtApiError";
  }
}

async function wtGet<T>(path: string, baseUrl?: string): Promise<T> {
  const base = normalizeBaseUrl(baseUrl ?? getStoredWtServerUrl());
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WtApiError(`Could not reach the Ichtus server (${base}): ${reason}`);
  }
  if (!response.ok) {
    throw new WtApiError(`Ichtus server responded with HTTP ${response.status}`);
  }
  const data = (await response.json()) as T & { success?: boolean; error?: string };
  if (data.success === false) {
    throw new WtApiError(data.error || "The Ichtus server reported an error");
  }
  return data;
}

function forceParam(force: boolean, name: "refresh" | "live"): string {
  return force ? `?${name}=1` : "";
}

export async function fetchWtServices(
  force = false,
  baseUrlOrMode?: string,
): Promise<WTServicesResult> {
  const isDirect =
    baseUrlOrMode === "direct" ||
    (!baseUrlOrMode && getStoredWtConnectionMode() === "direct");

  if (isDirect) {
    return directFetchServices(force);
  }

  const data = await wtGet<WTServicesResult>(
    `/api/worshiptools-services/services${forceParam(force, "refresh")}`,
    baseUrlOrMode,
  );
  return {
    upcoming: data.upcoming ?? [],
    past: data.past ?? [],
    count: data.count ?? 0,
  };
}

export async function fetchWtSetlist(
  serviceId: string,
  force = false,
  baseUrlOrMode?: string,
): Promise<WTSetlistResult> {
  const isDirect =
    baseUrlOrMode === "direct" ||
    (!baseUrlOrMode && getStoredWtConnectionMode() === "direct");

  if (isDirect) {
    return directFetchSetlist(serviceId, force);
  }

  const encoded = encodeURIComponent(serviceId);
  const data = await wtGet<WTSetlistResult>(
    `/api/worshiptools-services/services/${encoded}/setlist${forceParam(force, "live")}`,
    baseUrlOrMode,
  );
  return {
    service: data.service,
    songs: data.songs ?? [],
    count: data.count ?? data.songs?.length ?? 0,
  };
}

export async function fetchWtLibrary(
  force = false,
  baseUrlOrMode?: string,
): Promise<WTLibraryResult> {
  const isDirect =
    baseUrlOrMode === "direct" ||
    (!baseUrlOrMode && getStoredWtConnectionMode() === "direct");

  if (isDirect) {
    return directFetchLibrary(force);
  }

  const data = await wtGet<WTLibraryResult>(
    `/api/worshiptools-services/library${forceParam(force, "refresh")}`,
    baseUrlOrMode,
  );
  return {
    songs: data.songs ?? [],
    count: data.count ?? data.songs?.length ?? 0,
    updatedAt: data.updatedAt,
  };
}

export async function fetchWtRoster(
  serviceId: string,
  force = false,
  baseUrlOrMode?: string,
): Promise<WTRosterResult> {
  const isDirect =
    baseUrlOrMode === "direct" ||
    (!baseUrlOrMode && getStoredWtConnectionMode() === "direct");

  if (isDirect) {
    return directFetchRoster(serviceId, force);
  }

  const encoded = encodeURIComponent(serviceId);
  const data = await wtGet<WTRosterResult>(
    `/api/worshiptools-services/services/${encoded}/roster${forceParam(force, "refresh")}`,
    baseUrlOrMode,
  );
  return {
    service: data.service,
    teams: data.teams ?? [],
    roster: data.roster ?? [],
    counts: data.counts ?? {
      total: data.roster?.length ?? 0,
      accepted: data.roster?.filter((r) => r.status === "accepted").length ?? 0,
      pending: data.roster?.filter((r) => r.status === "pending").length ?? 0,
      declined: 0,
    },
  };
}
