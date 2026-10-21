import { describe, expect, it } from "vitest";

import {
  barDurationSeconds,
  beatDurationSeconds,
  isSectionLabel,
  labelSectionNames,
  mirLabelToMarkerKind,
  parseMeter,
  quantizeSegments,
  snapSecondsToBar,
} from "./barGrid";

describe("parseMeter", () => {
  it("reads common signatures", () => {
    expect(parseMeter("4/4")).toEqual({ numerator: 4, denominator: 4 });
    expect(parseMeter("6/8")).toEqual({ numerator: 6, denominator: 8 });
    expect(parseMeter("3/4")).toEqual({ numerator: 3, denominator: 4 });
    expect(parseMeter(" 12 / 8 ")).toEqual({ numerator: 12, denominator: 8 });
    expect(parseMeter("7/16")).toEqual({ numerator: 7, denominator: 16 });
  });

  it("falls back instead of throwing on junk", () => {
    // A WorshipTools song with a missing or odd meter must still build a
    // session, so every unparseable input yields the default.
    for (const input of ["", "  ", "—", "-", "4", "4/", "/4", "4/5", "0/4", "4/4/4", "99/4", null, undefined]) {
      expect(parseMeter(input)).toEqual({ numerator: 4, denominator: 4 });
    }
    // A custom fallback only applies to input that fails to parse.
    expect(parseMeter("nonsense", { numerator: 3, denominator: 4 })).toEqual({
      numerator: 3,
      denominator: 4,
    });
    expect(parseMeter("4/4", { numerator: 3, denominator: 4 })).toEqual({
      numerator: 4,
      denominator: 4,
    });
    expect(parseMeter("5/4")).toEqual({ numerator: 5, denominator: 4 });
  });
});

describe("bar and beat durations", () => {
  it("matches the workflow example: 75 BPM in 4/4 is 3.2s per bar", () => {
    expect(barDurationSeconds(75, parseMeter("4/4"))).toBeCloseTo(3.2, 10);
    expect(beatDurationSeconds(75, parseMeter("4/4"))).toBeCloseTo(0.8, 10);
  });

  it("halves at double tempo", () => {
    expect(barDurationSeconds(120, parseMeter("4/4"))).toBeCloseTo(2, 10);
    expect(barDurationSeconds(150, parseMeter("4/4"))).toBeCloseTo(1.6, 10);
  });

  it("scales for compound meters where the beat is an eighth", () => {
    // 6/8 at 120 BPM: eighth = 0.25s, six of them = 1.5s.
    expect(beatDurationSeconds(120, parseMeter("6/8"))).toBeCloseTo(0.25, 10);
    expect(barDurationSeconds(120, parseMeter("6/8"))).toBeCloseTo(1.5, 10);
  });

  it("returns 0 rather than Infinity for a missing tempo", () => {
    expect(barDurationSeconds(0)).toBe(0);
    expect(barDurationSeconds(Number.NaN)).toBe(0);
    expect(barDurationSeconds(-10)).toBe(0);
  });
});

describe("snapSecondsToBar", () => {
  it("snaps 39.8s at 75 BPM 4/4 to bar 13 (beat 1 at 38.4s)", () => {
    const result = snapSecondsToBar(39.8, { bpm: 75, meter: parseMeter("4/4") });
    expect(result).toEqual({ seconds: 38.4, bar: 13, source: "grid" });
  });

  it("snaps a timestamp already on the grid back to itself", () => {
    const result = snapSecondsToBar(6.4, { bpm: 75, meter: parseMeter("4/4") });
    expect(result.seconds).toBeCloseTo(6.4, 10);
    expect(result.bar).toBe(3);
  });

  it("snaps to whichever downbeat is closest when the model reports them", () => {
    const downbeats = [0.33, 1.94, 3.53, 5.12];
    expect(snapSecondsToBar(1.0, { bpm: 75, downbeats })).toMatchObject({
      seconds: 0.33,
      source: "downbeat",
    });
    expect(snapSecondsToBar(1.8, { bpm: 75, downbeats })).toMatchObject({
      seconds: 1.94,
      source: "downbeat",
    });
    // Ties go to the earlier downbeat, deterministically.
    expect(snapSecondsToBar(1.135, { bpm: 75, downbeats }).seconds).toBe(0.33);
  });

  it("respects an origin other than zero", () => {
    const result = snapSecondsToBar(10, {
      bpm: 60,
      meter: parseMeter("4/4"),
      originSeconds: 8,
    });
    expect(result).toEqual({ seconds: 12, bar: 2, source: "grid" });
  });

  it("ignores an empty downbeat list and uses the grid", () => {
    const result = snapSecondsToBar(39.8, {
      bpm: 75,
      meter: parseMeter("4/4"),
      downbeats: [],
    });
    expect(result.source).toBe("grid");
    expect(result.seconds).toBeCloseTo(38.4, 10);
  });

  it("never snaps backwards past the origin or before zero", () => {
    for (const t of [-5, -0.001, 0, 0.1, 1.59, 1.61]) {
      const result = snapSecondsToBar(t, { bpm: 75, meter: parseMeter("4/4") });
      expect(result.seconds).toBeGreaterThanOrEqual(0);
      expect(result.bar).toBeGreaterThanOrEqual(1);
    }
  });

  it("degrades to the raw timestamp when there is no usable tempo", () => {
    const result = snapSecondsToBar(12.5, { bpm: 0 });
    expect(result).toEqual({ seconds: 12.5, bar: 1, source: "grid" });
  });
});

describe("isSectionLabel", () => {
  it("drops the degenerate start/end brackets", () => {
    expect(isSectionLabel("start")).toBe(false);
    expect(isSectionLabel("END")).toBe(false);
    expect(isSectionLabel("  Start ")).toBe(false);
    expect(isSectionLabel("")).toBe(false);
    expect(isSectionLabel("   ")).toBe(false);
  });

  it("keeps real sections", () => {
    expect(isSectionLabel("intro")).toBe(true);
    expect(isSectionLabel("chorus")).toBe(true);
    expect(isSectionLabel("inst")).toBe(true);
  });
});

describe("quantizeSegments", () => {
  const bpm = 75;
  const meter = parseMeter("4/4");

  it("snaps every boundary and orders the result", () => {
    const sections = quantizeSegments(
      [
        { start: 0, end: 0.33, label: "start" },
        { start: 0.33, end: 13.13, label: "intro" },
        { start: 13.13, end: 39.8, label: "verse" },
        { start: 39.8, end: 64.0, label: "chorus" },
        { start: 64.0, end: 64.5, label: "end" },
      ],
      { bpm, meter },
    );

    expect(sections.map((s) => s.label)).toEqual(["intro", "verse", "chorus"]);
    expect(sections.map((s) => s.seconds)).toEqual([0, 12.8, 38.4]);
    expect(sections.map((s) => s.bar)).toEqual([1, 5, 13]);
    expect(sections.every((s) => s.source === "grid")).toBe(true);
  });

  it("collapses a sub-bar sliver, keeping the section that follows it", () => {
    // 12.9s and 13.1s both round to bar 5 (12.8s). One marker per bar is all a
    // timeline can hold, so the 0.2s "break" must lose to the chorus — not the
    // other way round, which would erase the chorus from the session entirely.
    const sections = quantizeSegments(
      [
        { start: 0, end: 12.9, label: "verse" },
        { start: 12.9, end: 13.1, label: "break" },
        { start: 13.1, end: 40, label: "chorus" },
      ],
      { bpm, meter },
    );

    expect(sections.map((s) => [s.label, s.bar])).toEqual([
      ["verse", 1],
      ["chorus", 5],
    ]);
    expect(sections.map((s) => s.seconds)).toEqual([0, 12.8]);
  });

  it("lets a later section win a collision at bar 1", () => {
    // A 1-second intro still snaps to bar 1, the same cell as the verse. The
    // verse is the section the worship band actually needs to jump to.
    const sections = quantizeSegments(
      [
        { start: 0, end: 1.0, label: "intro" },
        { start: 1.0, end: 40, label: "verse" },
      ],
      { bpm, meter },
    );
    expect(sections.map((s) => [s.label, s.bar, s.seconds])).toEqual([
      ["verse", 1, 0],
    ]);
  });

  it("always produces strictly increasing positions", () => {
    const sections = quantizeSegments(
      Array.from({ length: 40 }, (_, index) => ({
        start: index * 1.7 + (index % 3) * 0.4,
        end: (index + 1) * 1.7,
        label: index % 2 === 0 ? "verse" : "chorus",
      })),
      { bpm, meter },
    );
    for (let index = 1; index < sections.length; index += 1) {
      expect(sections[index].seconds).toBeGreaterThan(sections[index - 1].seconds);
      expect(sections[index].bar).toBeGreaterThanOrEqual(sections[index - 1].bar);
    }
  });

  it("prefers detected downbeats over the fixed grid", () => {
    // A rubato intro: the model hears the first downbeat late.
    const sections = quantizeSegments([{ start: 1.4, end: 30, label: "intro" }], {
      bpm,
      meter,
      downbeats: [1.6, 4.8, 8.0],
    });
    expect(sections[0]).toMatchObject({ seconds: 1.6, source: "downbeat" });
  });

  it("skips blank labels instead of emitting nameless markers", () => {
    const sections = quantizeSegments(
      [
        { start: 0, end: 10, label: "   " },
        { start: 10, end: 20, label: "" },
        { start: 20, end: 30, label: "bridge" },
      ],
      { bpm, meter },
    );
    expect(sections.map((s) => s.label)).toEqual(["bridge"]);
  });

  it("orders a shuffled input instead of emitting markers backwards", () => {
    const sections = quantizeSegments(
      [
        { start: 40, end: 60, label: "chorus" },
        { start: 0, end: 12, label: "intro" },
        { start: 12, end: 40, label: "verse" },
      ],
      { bpm, meter },
    );
    expect(sections.map((s) => s.label)).toEqual(["intro", "verse", "chorus"]);
    expect(sections.map((s) => s.seconds)).toEqual([0, 12.8, 41.6]);
  });

  it("handles an empty segment list", () => {
    expect(quantizeSegments([], { bpm, meter })).toEqual([]);
  });
});

describe("mirLabelToMarkerKind", () => {
  it("maps every allin1 HARMONIX label", () => {
    expect(mirLabelToMarkerKind("intro")).toBe("intro");
    expect(mirLabelToMarkerKind("verse")).toBe("verse");
    expect(mirLabelToMarkerKind("chorus")).toBe("chorus");
    expect(mirLabelToMarkerKind("bridge")).toBe("bridge");
    expect(mirLabelToMarkerKind("break")).toBe("breakdown");
    expect(mirLabelToMarkerKind("inst")).toBe("instrumental");
    expect(mirLabelToMarkerKind("solo")).toBe("solo");
    expect(mirLabelToMarkerKind("outro")).toBe("outro");
    // `start`/`end` never reach marker creation, but stay well-defined.
    expect(mirLabelToMarkerKind("start")).toBe("intro");
    expect(mirLabelToMarkerKind("end")).toBe("outro");
  });

  it("is case-insensitive and falls back to custom", () => {
    expect(mirLabelToMarkerKind("  Chorus ")).toBe("chorus");
    expect(mirLabelToMarkerKind("samba")).toBe("custom");
    expect(mirLabelToMarkerKind("")).toBe("custom");
  });
});

describe("labelSectionNames", () => {
  it("numbers repeats without touching the first occurrence", () => {
    expect(labelSectionNames(["intro", "verse", "verse", "chorus", "verse"])).toEqual([
      "Intro",
      "Verse",
      "Verse 2",
      "Chorus",
      "Verse 3",
    ]);
  });

  it("capitalises for the marker label", () => {
    expect(labelSectionNames(["inst"])).toEqual(["Inst"]);
  });
});
