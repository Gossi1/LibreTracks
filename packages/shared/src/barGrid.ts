// Bar-grid quantization for the WorshipTools → LibreTracks stage workflow.
//
// A MIR model (allin1) reports section boundaries as continuous seconds. Live
// performance needs them on the musical grid, so every boundary is snapped to a
// downbeat before it becomes a section marker:
//
//   Bar Duration (seconds) = (60 / BPM) × Beats per Bar
//   Target Bar             = round(Timestamp / Bar Duration) + 1
//
// At 75 BPM in 4/4 that is (60/75) × 4 = 3.2s per bar, so a raw boundary at
// 39.8s lands on bar 13 (beat 1 at 38.4s).
//
// When the analysis also reports detected downbeats we snap to those instead:
// they are the model's actual read of the groove and survive rubato, tempo
// drift and MP3 decoder offsets that the fixed-grid formula cannot.

import type { MarkerKind } from "./models";

export type Meter = {
  /** Beats per bar, e.g. 4 in 4/4 and 6 in 6/8. */
  numerator: number;
  /** Note value one beat represents, e.g. 4 in 4/4 and 8 in 6/8. */
  denominator: number;
};

export const DEFAULT_METER: Meter = { numerator: 4, denominator: 4 };

/**
 * Parse a "4/4" style signature. Unparseable or out-of-range input falls back
 * to `fallback` rather than throwing: a WorshipTools song with a missing meter
 * must still build a session.
 */
export function parseMeter(
  meter: string | null | undefined,
  fallback: Meter = DEFAULT_METER,
): Meter {
  const match = /^(\d{1,2})\s*\/\s*(1|2|4|8|16|32)$/.exec(String(meter ?? "").trim());
  if (!match) return { ...fallback };
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || numerator < 1 || numerator > 32) {
    return { ...fallback };
  }
  return { numerator, denominator };
}

/**
 * Duration of one beat in seconds. BPM counts quarter notes, so a beat of note
 * value `denominator` lasts `4 / denominator` quarters.
 */
export function beatDurationSeconds(bpm: number, meter: Meter = DEFAULT_METER): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  return (60 / bpm) * (4 / meter.denominator);
}

/** Duration of one bar (measure) in seconds. */
export function barDurationSeconds(bpm: number, meter: Meter = DEFAULT_METER): number {
  return beatDurationSeconds(bpm, meter) * meter.numerator;
}

/** 1-based bar number the timestamp falls in, before any snapping. */
export function barIndexAt(timestampSeconds: number, barDuration: number): number {
  if (!(barDuration > 0)) return 1;
  return Math.floor(Math.max(0, timestampSeconds) / barDuration) + 1;
}

export type SnapResult = {
  /** The snapped timeline position, in seconds. */
  seconds: number;
  /** 1-based bar (measure) the boundary now starts on. */
  bar: number;
  /** Which reference was used, so callers can report grid confidence. */
  source: "downbeat" | "grid";
};

/**
 * Snap a raw timestamp to the nearest downbeat.
 *
 * Pass `downbeats` (absolute seconds, ascending, as emitted by allin1) to snap
 * against the model's detected grid; omit them to snap against the regular
 * grid derived from BPM and meter.
 */
export function snapSecondsToBar(
  timestampSeconds: number,
  options: {
    bpm: number;
    meter?: Meter;
    /** Downbeat positions in seconds. Empty or missing means "use the grid". */
    downbeats?: readonly number[];
    /** Timeline position of beat 1 of bar 1. Defaults to 0. */
    originSeconds?: number;
  },
): SnapResult {
  const meter = options.meter ?? DEFAULT_METER;
  const origin = options.originSeconds ?? 0;
  const timestamp = Math.max(0, timestampSeconds);

  const downbeats = options.downbeats;
  if (downbeats && downbeats.length > 0) {
    const nearest = nearestValue(downbeats, timestamp);
    if (nearest !== null) {
      return {
        seconds: nearest,
        bar: barIndexAt(nearest - origin, barDurationSeconds(options.bpm, meter)),
        source: "downbeat",
      };
    }
  }

  const barDuration = barDurationSeconds(options.bpm, meter);
  if (!(barDuration > 0)) {
    return { seconds: timestamp, bar: 1, source: "grid" };
  }
  // round(t / bar) + 1 → the bar whose downbeat the timestamp is closest to.
  const bar = Math.round((timestamp - origin) / barDuration) + 1;
  return {
    seconds: roundGridSeconds(origin + (bar - 1) * barDuration),
    bar,
    source: "grid",
  };
}

/**
 * `(60 / 75) * 4` is not exactly 3.2 in IEEE-754, so `12 * barDuration`
 * comes out as 38.400000000000006. Microsecond precision is far finer than
 * any timeline or marker needs, so snap grid positions to it: markers compare
 * equal, sort correctly, and never carry float dust into a saved session.
 */
function roundGridSeconds(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

/**
 * allin1 brackets the track with degenerate `start`/`end` stubs (often a few
 * hundred milliseconds long) that are boundaries, not sections. They become
 * markers otherwise, so drop them before quantizing.
 */
const NON_SECTION_LABELS = new Set(["start", "end"]);

export function isSectionLabel(label: string): boolean {
  return label.trim().length > 0 && !NON_SECTION_LABELS.has(label.trim().toLowerCase());
}

export type RawSegment = {
  start: number;
  end: number;
  label: string;
};

export type QuantizedSection = {
  /** Raw allin1 label, used to pick the marker kind. */
  label: string;
  seconds: number;
  bar: number;
  source: "downbeat" | "grid";
};

/**
 * Turn raw MIR segments into an ordered, bar-aligned section list.
 *
 * - Drops non-section labels (`start`/`end`).
 * - Snaps each boundary with {@link snapSecondsToBar}.
 * - Collapses every run of boundaries that lands in the same bar onto ONE
 *   marker, keeping the LAST of the run.
 * - Guarantees strictly increasing seconds, which is what marker creation and
 *   the voice-guide count-in both require.
 *
 * Why last-wins: sections shorter than a bar (or two boundaries within half a
 * bar of each other) cannot both be represented — a marker set must advance.
 * Keeping the last one discards the sliver and preserves the section that
 * actually follows it, so `intro(0–1s) | verse(1s–…)` yields Verse at bar 1
 * rather than a 1-second Intro that swallows the verse. Keeping the first
 * would do the opposite and lose whole sections.
 */
export function quantizeSegments(
  segments: readonly RawSegment[],
  options: {
    bpm: number;
    meter?: Meter;
    downbeats?: readonly number[];
    originSeconds?: number;
  },
): QuantizedSection[] {
  // Defensive copy: the model emits ascending boundaries, but a shuffled input
  // must not produce markers that run backwards.
  const ordered = [...segments].sort((a, b) => a.start - b.start);

  const snapped: QuantizedSection[] = [];
  for (const segment of ordered) {
    const label = String(segment.label ?? "").trim();
    if (!isSectionLabel(label)) continue;
    if (!Number.isFinite(segment.start)) continue;

    const position = snapSecondsToBar(segment.start, options);
    const previous = snapped[snapped.length - 1];

    if (previous && previous.bar === position.bar) {
      // Same bar as the previous boundary: this one replaces it.
      previous.seconds = position.seconds;
      previous.source = position.source;
      previous.label = label;
      continue;
    }
    if (previous && position.seconds <= previous.seconds) {
      // Defensive: cannot happen for an ascending input, but never emit a
      // marker that would sit on or behind its predecessor.
      continue;
    }
    snapped.push({
      label,
      seconds: position.seconds,
      bar: position.bar,
      source: position.source,
    });
  }

  return snapped;
}

/** Index of the value in a sorted array closest to `target`, or null if empty. */
function nearestValue(sorted: readonly number[], target: number): number | null {
  if (sorted.length === 0) return null;

  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }

  const candidate = sorted[low];
  const previous = low > 0 ? sorted[low - 1] : undefined;
  if (previous === undefined) return candidate;
  return Math.abs(target - previous) <= Math.abs(target - candidate) ? previous : candidate;
}

/**
 * Map an allin1 HARMONIX label to a LibreTracks marker kind.
 *
 * allin1 predicts `start end intro outro break bridge inst solo verse chorus`.
 * `custom` is the safe default: unknown labels still produce a usable marker,
 * just without a dedicated icon/voice clip.
 */
export const MIR_LABEL_TO_MARKER_KIND: Readonly<Record<string, MarkerKind>> = {
  start: "intro",
  intro: "intro",
  verse: "verse",
  chorus: "chorus",
  bridge: "bridge",
  break: "breakdown",
  inst: "instrumental",
  instrumental: "instrumental",
  solo: "solo",
  outro: "outro",
  end: "outro",
};

export function mirLabelToMarkerKind(label: string): MarkerKind {
  return MIR_LABEL_TO_MARKER_KIND[label.trim().toLowerCase()] ?? "custom";
}

/**
 * Human-readable name for a marker: "Verse" / "Chorus" with a variant number
 * when the analysis reports repeats ("Verse", "Verse", "Chorus" →
 * "Verse", "Verse 2", "Chorus"). Returns the base names so callers can pass
 * `name` straight to `createSectionMarker`.
 */
export function labelSectionNames(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const base = label.charAt(0).toUpperCase() + label.slice(1);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}
