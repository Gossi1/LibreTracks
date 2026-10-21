import { describe, expect, it } from "vitest";

import fixture from "./fixtures/mir-analysis-sample.json";
import type { MirAnalysis } from "./mirApi";
import { planStageSession } from "./stageSession";

/**
 * A golden test over REAL model output: this fixture is exactly what
 * analysis-service returned for `samples/ACUSTICA 1_01.wav` on this machine
 * (harmonix-fold0, CPU). It guards the contract the whole workflow rests on —
 * segments and downbeats in, a laid-out song out — against hand-made data that
 * could drift away from what the network actually emits.
 */
const analysis = fixture as unknown as MirAnalysis;

describe("planning real allin1 output", () => {
  it("lays the analysed song out and snaps every boundary to a detected downbeat", () => {
    const plan = planStageSession({
      songs: [
        {
          title: "ACUSTICA",
          key: "Am",
          bpm: null, // WorshipTools had no tempo — fall back to what we heard
          meter: "4/4",
          position: 1,
          referencePath: fixture.path,
        },
      ],
      analyses: { [fixture.path]: analysis },
    });

    expect(plan.skipped).toEqual([]);
    expect(plan.songs).toHaveLength(1);
    const song = plan.songs[0];

    // Phase 2's headline numbers survive the trip.
    expect(song.bpm).toBe(91);
    expect(song.tempoSource).toBe("analysis");
    expect(song.offsetSeconds).toBe(0);
    // allin1 does not report a duration, so the layout falls back to the end
    // of the last section rather than leaving the next song at offset 0.
    expect(song.durationSeconds).toBeGreaterThan(180);
    expect(song.durationSeconds).toBeLessThan(190);

    // Every `solo` segment became a marker, numbered in order.
    expect(song.sections.map((section) => section.name)).toEqual([
      "Solo",
      "Solo 2",
      "Solo 3",
      "Solo 4",
      "Solo 5",
      "Solo 6",
      "Solo 7",
      "Solo 8",
    ]);
    expect(song.sections.every((section) => section.kind === "solo")).toBe(true);
    // `solo` ships no numbered voice recordings, so no variant is requested —
    // every marker falls back to the base "Solo" clip instead of pointing at a
    // recording that does not exist.
    expect(song.sections.every((section) => section.variant === null)).toBe(true);

    // Boundaries came out on the model's own downbeat grid, in order, and
    // inside the song.
    expect(song.sections.every((section) => section.source === "downbeat")).toBe(true);
    const seconds = song.sections.map((section) => section.seconds);
    expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
    expect(new Set(seconds).size).toBe(seconds.length);
    expect(seconds[0]).toBe(0.9); // first detected beat 1
    expect(seconds.at(-1)!).toBeLessThanOrEqual(song.durationSeconds);
    expect(song.sections.at(-1)!.bar).toBeGreaterThan(1);
  });

  it("prefers the WorshipTools target tempo over the detected one", () => {
    const plan = planStageSession({
      songs: [
        {
          title: "ACUSTICA",
          key: "Am",
          bpm: 90,
          meter: "4/4",
          position: 1,
          referencePath: fixture.path,
        },
      ],
      analyses: { [fixture.path]: analysis },
    });

    expect(plan.songs[0].bpm).toBe(90);
    expect(plan.songs[0].tempoSource).toBe("worshiptools");
    expect(plan.songs[0].sections).toHaveLength(8);
  });
});
