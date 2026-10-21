// Stage-session builder: turns a WorshipTools service into a LibreTracks
// session that is ready to play on stage.
//
//   Phase 1  filter the setlist down to musical items, keep title/key/BPM/meter
//   Phase 2  (analysis already done — MirAnalysis is an input here)
//   Phase 3  snap every section boundary onto the bar grid
//   Phase 4  lay the songs on the timeline, write tempo/meter markers, create
//            section markers (which drive the built-in voice guide), then mute
//            the scratch reference tracks
//
// The planner is deliberately pure so all of the interesting decisions — what
// counts as a song, where tempo comes from, where each song starts, which bar
// every section lands on — are unit-testable without Tauri. `buildStageSession`
// is a thin applier over the existing desktop API.

import {
  isSectionLabel,
  labelSectionNames,
  mirLabelToMarkerKind,
  parseMeter,
  quantizeSegments,
  snapSecondsToBar,
  type Meter,
  type QuantizedSection,
} from "@libretracks/shared/barGrid";
import type { MarkerKind, SongRegionSummary, SongView, TrackSummary } from "@libretracks/shared/models";
import {
  commitTrackMixChange,
  createAudioTracksWithClips,
  createSectionMarker,
  getSongView,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
  updateSongRegionKey,
} from "@libretracks/shared/desktopApi";

import { markerKindVariants } from "../transport/markerKinds";
import type { MirAnalysis } from "./mirApi";
import type { WTSong } from "./wtApi";

/** Suffix on every scratch track we create, so cleanup can find them again. */
export const REFERENCE_TRACK_SUFFIX = " (ref)";

/**
 * Titles that are part of the service but not songs.
 *
 * The WorshipTools setlist is an ordered list of *cues* — prayers, the sermon,
 * welcome and announcements sit between the songs. Both English and Dutch are
 * covered because the Ichtus service runs in Dutch.
 *
 * Matching is intentionally conservative: an unknown title is treated as a
 * song, because dropping a real song costs far more than keeping a stray cue.
 */
const NON_MUSICAL_TITLE_PATTERNS: readonly RegExp[] = [
  /\b(prayer|prayers|sermon|homily|welcome|greeting|offering|offertory|announcement|announcements|communion|lord'?s supper|baptism|testimony|scripture|reading|responsive reading|video|countdown|bumper|prelude|postlude|benediction|opening|closing)\b/i,
  /\b(gebed|preek|welkom|mededelingen|mededeling|collecte|avondmaal|doop|getuigenis|schriftlezing|lezing|voorbede|opening|slot|inzegening|kas|kinderMoment)\b/i,
];

/** Phase 1.2 — skip non-musical elements, keep everything else. */
export function isMusicalSong(song: Pick<WTSong, "title">): boolean {
  const title = song.title.trim();
  if (!title) return false;
  return !NON_MUSICAL_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export function filterMusicalSongs(songs: readonly WTSong[]): WTSong[] {
  return songs.filter(isMusicalSong);
}

export type StageSongInput = {
  title: string;
  /** Target key from WorshipTools ("D", "G") or null when unknown. */
  key: string | null;
  /** Target tempo from WorshipTools; null when the cue carries none. */
  bpm: number | null;
  /** "4/4", "6/8", … */
  meter: string;
  /** 1-based setlist position, preserved from the service. */
  position: number;
  /** Absolute path of the reference scratch audio, if one was chosen. */
  referencePath: string | null;
};

export type PlannedSection = {
  /** Display name, e.g. "Verse 2". Matches what the UI's own marker menu
   * writes: name is always `label` plus the variant, if any. */
  name: string;
  kind: MarkerKind;
  /** Numbered voice-guide variant (`Verse 2` → 2), null for the base clip.
   * The engine picks the spoken clip from this, not from `name`. */
  variant: number | null;
  /** Absolute timeline position (song offset + snapped in-song position). */
  seconds: number;
  bar: number;
  source: "downbeat" | "grid";
};

export type PlannedSong = {
  title: string;
  position: number;
  key: string | null;
  meter: Meter;
  meterString: string;
  bpm: number | null;
  tempoSource: "worshiptools" | "analysis" | "none";
  referencePath: string;
  /** Absolute timeline start of this song. */
  offsetSeconds: number;
  durationSeconds: number;
  sections: PlannedSection[];
  /** True when sections exist but could not be placed (no usable tempo). */
  sectionsSkipped: boolean;
};

export type StageSessionPlan = {
  songs: PlannedSong[];
  totalDurationSeconds: number;
  /** Songs left out, with the reason shown to the user. */
  skipped: { title: string; reason: string }[];
  /** Non-al fatal notes (e.g. a song with no tempo at all). */
  warnings: string[];
};

type PlanArgs = {
  songs: readonly StageSongInput[];
  /** Analysis results keyed by reference audio path. */
  analyses: Readonly<Record<string, MirAnalysis>>;
  /** Gap left between songs, in seconds. */
  gapSeconds?: number;
};

/**
 * Phase 1 + Phase 3: lay the setlist out on one timeline and snap every song's
 * section boundaries to its bar grid.
 *
 * Songs run back to back in setlist order; each one re-bases the tempo and
 * meter at its own offset, so every song starts on beat 1 of bar 1 no matter
 * how long the previous one was.
 */
export function planStageSession({ songs, analyses, gapSeconds = 0 }: PlanArgs): StageSessionPlan {
  const planned: PlannedSong[] = [];
  const skipped: { title: string; reason: string }[] = [];
  const warnings: string[] = [];
  let offset = 0;

  for (const song of songs) {
    const title = song.title.trim() || "Untitled";

    if (!song.referencePath) {
      skipped.push({ title, reason: "no-reference" });
      continue;
    }
    const analysis = analyses[song.referencePath];
    if (!analysis) {
      skipped.push({ title, reason: "not-analyzed" });
      continue;
    }

    const duration = resolveDuration(analysis);
    if (duration <= 0) {
      skipped.push({ title, reason: "no-duration" });
      continue;
    }

    const meterString = song.meter?.trim() || "4/4";
    const meter = parseMeter(meterString);

    // Phase 1 wins over Phase 2: WorshipTools carries the *target* tempo for
    // the service, which is what the band agreed on. The model's tempo is only
    // a fallback for songs nobody filled in.
    const wtBpm = isUsableBpm(song.bpm) ? Math.round(song.bpm as number) : null;
    const analyzedBpm = isUsableBpm(analysis.bpm) ? Math.round(analysis.bpm as number) : null;
    const bpm = wtBpm ?? analyzedBpm;
    const tempoSource: PlannedSong["tempoSource"] = wtBpm
      ? "worshiptools"
      : analyzedBpm
        ? "analysis"
        : "none";

    if (tempoSource === "none") {
      warnings.push(`${title}: no tempo from WorshipTools or the analysis — metronome keeps its default.`);
    }

    const hasSections = analysis.segments.some((segment) => isSectionLabel(segment.label));
    const sections = bpm ? quantizeAndName(analysis, bpm, meter, offset) : [];
    const sectionsSkipped = hasSections && sections.length === 0;
    if (sectionsSkipped) {
      warnings.push(`${title}: section markers skipped — snapping needs a tempo.`);
    }

    planned.push({
      title,
      position: song.position,
      key: normalizeKey(song.key),
      meter,
      meterString,
      bpm,
      tempoSource,
      referencePath: song.referencePath,
      offsetSeconds: offset,
      durationSeconds: duration,
      sections,
      sectionsSkipped,
    });

    offset += duration + Math.max(0, gapSeconds);
  }

  return {
    songs: planned,
    totalDurationSeconds: offset,
    skipped,
    warnings,
  };
}

/** Phases 2+3 for one song: raw segments → named, bar-aligned sections. */
function quantizeAndName(
  analysis: MirAnalysis,
  bpm: number,
  meter: Meter,
  offsetSeconds: number,
): PlannedSection[] {
  const quantized: QuantizedSection[] = quantizeSegments(analysis.segments, {
    bpm,
    meter,
    downbeats: analysis.downbeats,
    originSeconds: 0,
  });

  const names = labelSectionNames(quantized.map((section) => section.label));

  return quantized.map((section, index) => {
    const kind = mirLabelToMarkerKind(section.label);
    return {
      name: names[index],
      kind,
      variant: variantFor(kind, names[index]),
      seconds: roundSeconds(offsetSeconds + section.seconds),
      bar: section.bar,
      source: section.source,
    };
  });
}

/**
 * Trailing number of a numbered section name ("Verse 2" → 2), but only when
 * the bundled voice pack actually has that recording. A song with seven
 * verses still gets all seven markers; the seventh simply falls back to the
 * base "Verse" clip instead of pointing at a file that does not exist.
 */
function variantFor(kind: MarkerKind, name: string): number | null {
  const match = /\s(\d+)$/.exec(name);
  if (!match) return null;
  const number = Number(match[1]);
  const available = markerKindVariants(kind);
  return available.includes(number) ? number : null;
}

/**
 * Length of a song for layout purposes: what the model measured, else the end
 * of its last segment (models sometimes omit duration but always bracket the
 * track), else 0 — in which case the song is skipped rather than given an
 * arbitrary length that would put the next song on top of it.
 */
function resolveDuration(analysis: MirAnalysis): number {
  if (isPositiveNumber(analysis.durationSeconds)) {
    return roundSeconds(analysis.durationSeconds);
  }
  const lastBoundary = analysis.segments.reduce(
    (latest, segment) => Math.max(latest, Number(segment.end) || 0),
    0,
  );
  return lastBoundary > 0 ? roundSeconds(lastBoundary) : 0;
}

function isUsableBpm(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed === "—" || trimmed === "-" || trimmed === "?") return null;
  return trimmed;
}

function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Phase 4 — write the plan into the open session
// ---------------------------------------------------------------------------

export type StageProgress = {
  phase: "clips" | "grid" | "markers" | "cleanup";
  /** 1-based index of the song being processed, when the phase is per song. */
  current: number;
  total: number;
  label: string;
};

export type StageBuildResult = {
  songsBuilt: number;
  markersCreated: number;
  referenceTracksMuted: number;
  keysApplied: number;
  skipped: { title: string; reason: string }[];
  warnings: string[];
};

/**
 * Apply a plan to the currently open session.
 *
 * Deliberately does NOT create or replace the session: clobbering whatever the
 * user is working on without asking is not acceptable, so the workflow is
 * "File → New, then Build". If any step fails the whole build stops and the
 * message names the song and step, because a half-written timeline is easier
 * to undo than to reason about.
 */
export async function buildStageSession(
  plan: StageSessionPlan,
  onProgress?: (progress: StageProgress) => void,
): Promise<StageBuildResult> {
  const result: StageBuildResult = {
    songsBuilt: 0,
    markersCreated: 0,
    referenceTracksMuted: 0,
    keysApplied: 0,
    skipped: plan.skipped,
    warnings: [...plan.warnings],
  };

  if (plan.songs.length === 0) {
    return result;
  }

  const total = plan.songs.length;

  // 1. All reference clips in one backend update — one rebuild instead of one
  //    per song, which is what makes a 10-song service feel instant.
  onProgress?.({ phase: "clips", current: 1, total, label: "clips" });
  try {
    await createAudioTracksWithClips(
      plan.songs.map((song) => ({
        trackName: `${song.position}. ${song.title}${REFERENCE_TRACK_SUFFIX}`,
        filePath: song.referencePath,
        timelineStartSeconds: song.offsetSeconds,
      })),
    );
  } catch (error) {
    throw contextualise(error, "adding reference tracks");
  }

  // 2. Tempo + meter at every song start, so each song owns its own grid.
  for (let index = 0; index < plan.songs.length; index += 1) {
    const song = plan.songs[index];
    onProgress?.({
      phase: "grid",
      current: index + 1,
      total,
      label: song.title,
    });
    try {
      if (song.bpm !== null) {
        await upsertSongTempoMarker(song.offsetSeconds, song.bpm);
      }
      await upsertSongTimeSignatureMarker(song.offsetSeconds, song.meterString);
    } catch (error) {
      throw contextualise(error, `setting tempo/meter for "${song.title}"`);
    }
  }

  // 3. Section markers. Each one names a section, and the engine turns that
  //    kind into the pre-recorded "Chorus … two, three, four" count-in that
  //    lands in the bar before the section — Phase 4.2 comes free.
  for (let index = 0; index < plan.songs.length; index += 1) {
    const song = plan.songs[index];
    onProgress?.({
      phase: "markers",
      current: index + 1,
      total,
      label: song.title,
    });
    for (const section of song.sections) {
      try {
        await createSectionMarker(section.seconds, {
          kind: section.kind,
          variant: section.variant,
          name: section.name,
        });
        result.markersCreated += 1;
      } catch (error) {
        throw contextualise(
          error,
          `creating the "${section.name}" marker for "${song.title}"`,
        );
      }
    }
    result.songsBuilt += 1;
  }

  // 4. Scratch-track disposal + per-song keys need the final track/region ids,
  //    so read the session back once rather than after every mutation.
  onProgress?.({ phase: "cleanup", current: total, total, label: "cleanup" });
  let view: SongView | null;
  try {
    view = await getSongView({ includeWaveforms: false });
  } catch (error) {
    throw contextualise(error, "reading the session back");
  }
  if (!view) {
    result.warnings.push("Could not read the session back — reference tracks may still be audible.");
    return result;
  }

  for (const track of referenceTracks(view.tracks)) {
    try {
      // Mute rather than delete: the scratch audio stays available for a
      // reference listen, but nothing bleeds into the live mix.
      await commitTrackMixChange({ trackId: track.id, muted: true });
      result.referenceTracksMuted += 1;
    } catch (error) {
      throw contextualise(error, `muting the reference track "${track.name}"`);
    }
  }

  for (const song of plan.songs) {
    if (!song.key) continue;
    const region = regionCovering(view.regions, song.offsetSeconds);
    if (!region) continue;
    try {
      await updateSongRegionKey(region.id, song.key);
      result.keysApplied += 1;
    } catch (error) {
      throw contextualise(error, `setting the key of "${song.title}"`);
    }
  }

  return result;
}

function referenceTracks(tracks: readonly TrackSummary[]): TrackSummary[] {
  return tracks.filter((track) => track.name.endsWith(REFERENCE_TRACK_SUFFIX));
}

function regionCovering(
  regions: readonly SongRegionSummary[],
  atSeconds: number,
): SongRegionSummary | null {
  const covering = regions.find(
    (region) => atSeconds >= region.startSeconds && atSeconds < region.endSeconds,
  );
  if (covering) return covering;
  // A song sitting past the last region still needs somewhere to put its key;
  // fall back to the closest region that starts at or before it.
  return (
    regions
      .filter((region) => region.startSeconds <= atSeconds)
      .sort((a, b) => b.startSeconds - a.startSeconds)[0] ?? null
  );
}

function contextualise(error: unknown, step: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Stage build failed while ${step}: ${message}`);
  wrapped.cause = error;
  return wrapped;
}

/**
 * Which bar a raw timestamp sits in — exported because the plan summary shows
 * "Chorus → bar 13" next to the raw 39.8s, which is the whole point of Phase 3.
 */
export function describeSnap(
  rawSeconds: number,
  bpm: number,
  meter: Meter,
  downbeats?: readonly number[],
): { rawSeconds: number; bar: number; snappedSeconds: number } {
  const snapped = snapSecondsToBar(rawSeconds, { bpm, meter, downbeats });
  return {
    rawSeconds,
    bar: snapped.bar,
    snappedSeconds: snapped.seconds,
  };
}

