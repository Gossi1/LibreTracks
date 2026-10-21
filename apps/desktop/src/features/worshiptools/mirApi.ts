// Typed client for the local MIR analysis service (analysis-service/server.py).
//
// LibreTracks never runs the neural network itself: a small loopback HTTP
// service owns the `allin1` model and answers with section boundaries,
// downbeats and tempo. That keeps Python and torch out of the Tauri bundle.
//
//   GET  {base}/health      → is the model usable, and which one
//   POST {base}/analyze     → { path, useCache } → segments + downbeats + bpm
//   POST {base}/cache/clear → drop cached analyses
//
// Analysing a track on a CPU takes minutes, so `analyze` has no default
// timeout — callers pass an AbortSignal to cancel. Health checks stay short.

export const DEFAULT_MIR_SERVER_URL = "http://127.0.0.1:8799";

const STORAGE_KEY = "lt-mir-server-url";
const HEALTH_TIMEOUT_MS = 5_000;

export type MirSegment = {
  start: number;
  end: number;
  label: string;
};

export type MirAnalysis = {
  path: string;
  /** Tempo the model heard. Used when WorshipTools has no BPM for the song. */
  bpm: number | null;
  /** Beat 1 of every measure, in seconds — the preferred snap reference. */
  downbeats: number[];
  beats: number[];
  segments: MirSegment[];
  durationSeconds: number | null;
  model: string;
  analysisMillis: number;
  cached: boolean;
};

export type MirHealth = {
  available: boolean;
  detail: string;
  model: string;
  cache: { entries: number; bytes: number; path?: string };
  service: string;
  version: string;
};

export class MirApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirApiError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getStoredMirServerUrl(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim()) return normalizeBaseUrl(stored);
  } catch {
    // localStorage unavailable (private mode / tests) — fall back to default.
  }
  return DEFAULT_MIR_SERVER_URL;
}

export function storeMirServerUrl(url: string): string {
  const normalized = normalizeBaseUrl(url);
  try {
    window.localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // Persisting is best-effort; the value still applies for this session.
  }
  return normalized;
}

type WireResponse<T> = T & { success?: boolean; error?: string };

async function mirFetch<T>(
  path: string,
  options: {
    baseUrl?: string;
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<T> {
  const base = normalizeBaseUrl(options.baseUrl ?? getStoredMirServerUrl());
  const signal =
    options.signal ??
    (options.timeoutMs
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error; // caller cancelled — not a connectivity problem
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new MirApiError(
      `Could not reach the MIR analysis service at ${base} — ${reason}`,
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as WireResponse<T>;
      if (payload.error) detail = payload.error;
    } catch {
      // Non-JSON error body; keep the status code.
    }
    throw new MirApiError(detail);
  }

  const data = (await response.json()) as WireResponse<T>;
  if (data.success === false) {
    throw new MirApiError(data.error || "The analysis service reported an error");
  }
  return data;
}

/** Ask the service whether the model is installed and usable. */
export async function fetchMirHealth(baseUrl?: string): Promise<MirHealth> {
  return mirFetch<MirHealth>("/health", {
    baseUrl,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
}

export type AnalyzeOptions = {
  baseUrl?: string;
  /** Re-use a previous result for the same file+mtime. Defaults to true. */
  useCache?: boolean;
  /** Cancel a long CPU analysis. */
  signal?: AbortSignal;
};

/**
 * Run structure analysis on one reference track.
 *
 * Deliberately has no default timeout: CPU inference for a 4-minute song can
 * take minutes, and cutting it off would look like a broken model. Callers
 * cancel through `signal`.
 */
export async function analyzeReferenceAudio(
  path: string,
  options: AnalyzeOptions = {},
): Promise<MirAnalysis> {
  return mirFetch<MirAnalysis>("/analyze", {
    baseUrl: options.baseUrl,
    method: "POST",
    body: { path, useCache: options.useCache ?? true },
    signal: options.signal,
  });
}

/** Drop every cached analysis (used when a reference file was re-recorded). */
export async function clearMirCache(baseUrl?: string): Promise<number> {
  const result = await mirFetch<{ removed: number }>("/cache/clear", {
    baseUrl,
    method: "POST",
    body: {},
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  return result.removed ?? 0;
}
