import type { MarkerKind } from "@libretracks/shared/models";
import { createSectionMarker } from "../transport/desktopApi";

export interface RehearseStatus {
  hasToken: boolean;
  lastTrackId: string | null;
}

export interface RehearseParsedMarker {
  name: string;
  kind: string;
  variant?: number | null;
  startSeconds: number;
  startBeat: number;
  endBeat: number;
  startMeasure: number;
  durationMeasures: number;
}

export interface RehearseSongResult {
  trackId: string;
  title: string;
  timeSignature: string;
  bpm?: number | null;
  beatsPerBar: number;
  markers: RehearseParsedMarker[];
  csv: string;
}

export interface RehearseSearchItem {
  rehearseSongId: string;
  title: string;
  artistName?: string | null;
  bpm?: number | null;
  timeSignature?: string | null;
  ccliSongNumber?: string | null;
  albumArtwork?: string | null;
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Open the embedded CCLI Rehearse / WorshipTools Planning window with automated auth token capture. */
export async function openRehearseWindow(url?: string): Promise<void> {
  return invokeTauri<void>("open_rehearse_window", { url: url || null });
}

/** Save or override the active Rehearse bearer token manually or via interceptor. */
export async function saveRehearseToken(token: string): Promise<void> {
  return invokeTauri<void>("save_rehearse_token", { token });
}

/** Store the last captured or selected Rehearse track ID. */
export async function setLastRehearseTrackId(trackId: string): Promise<void> {
  return invokeTauri<void>("set_last_rehearse_track_id", { trackId });
}

/** Check if a valid token is in memory and retrieve the last captured track ID. */
export async function getRehearseStatus(): Promise<RehearseStatus> {
  try {
    return await invokeTauri<RehearseStatus>("get_rehearse_status");
  } catch {
    return { hasToken: false, lastTrackId: null };
  }
}

/** Fetch song section markers from Rehearse API and parse into structured markers + CSV. */
export async function fetchRehearseSong(
  trackId: string,
  customToken?: string,
): Promise<RehearseSongResult> {
  return invokeTauri<RehearseSongResult>("fetch_rehearse_song", {
    trackId,
    customToken: customToken?.trim() ? customToken.trim() : null,
  });
}

/** Export song section markers as CSV string. */
export async function exportSongMarkers(trackId: string): Promise<string> {
  return invokeTauri<string>("export_song_markers", { trackId });
}

/** Search public CCLI Rehearse song database (no authentication required). */
export async function searchRehearseSongs(query: string): Promise<RehearseSearchItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return invokeTauri<RehearseSearchItem[]>("search_rehearse_songs", { query: trimmed });
}

/** Listen for captured Rehearse tokens emitted from the webview interceptor. */
export async function listenRehearseToken(
  callback: (token: string) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>("rehearse-token-captured", (event) => {
      callback(event.payload);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

/** Listen for captured Rehearse track IDs emitted from the webview interceptor. */
export async function listenRehearseTrack(
  callback: (trackId: string) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>("rehearse-track-captured", (event) => {
      callback(event.payload);
    });
    return unlisten;
  } catch {
    return () => {};
  }
}

/** Apply parsed Rehearse section markers directly to the active LibreTracks timeline. */
export async function applyRehearseMarkersToTimeline(
  songResult: RehearseSongResult,
  offsetSeconds = 0,
): Promise<{ createdCount: number }> {
  let createdCount = 0;
  for (const marker of songResult.markers) {
    const targetSeconds = Math.max(0, marker.startSeconds + offsetSeconds);
    await createSectionMarker(targetSeconds, {
      kind: marker.kind as MarkerKind,
      variant: marker.variant ?? null,
      name: marker.name,
    });
    createdCount += 1;
  }
  return { createdCount };
}

/** Trigger browser/desktop file download for a CSV string. */
export function downloadCsvFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.setAttribute("download", filename.endsWith(".csv") ? filename : `${filename}.csv`);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
