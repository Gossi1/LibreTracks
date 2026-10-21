import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@libretracks/shared/desktopApi", () => ({
  commitTrackMixChange: vi.fn(),
  createAudioTracksWithClips: vi.fn(),
  createSectionMarker: vi.fn(),
  getSongView: vi.fn(),
  upsertSongTempoMarker: vi.fn(),
  upsertSongTimeSignatureMarker: vi.fn(),
  updateSongRegionKey: vi.fn(),
}));

import {
  commitTrackMixChange,
  createAudioTracksWithClips,
  createSectionMarker,
  getSongView,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
  updateSongRegionKey,
} from "@libretracks/shared/desktopApi";

import type { MirAnalysis } from "./mirApi";
import {
  buildStageSession,
  isMusicalSong,
  planStageSession,
  type StageSongInput,
} from "./stageSession";

function makeAnalysis(overrides: Partial<MirAnalysis> = {}): MirAnalysis {
  return {
    path: "/refs/track.mp3",
    bpm: 75,
    downbeats: [],
    beats: [],
    // The worked example from the brief: 75 BPM in 4/4 → a 3.2s bar, so the
    // raw 39.8s chorus boundary must land on bar 13 (38.4s).
    segments: [
      { start: 0, end: 14.2, label: "intro" },
      { start: 14.2, end: 39.8, label: "verse" },
      { start: 39.8, end: 64, label: "chorus" },
      { start: 64, end: 96, label: "verse" },
      { start: 96, end: 128, label: "chorus" },
    ],
    durationSeconds: 128,
    model: "harmonix-fold0",
    analysisMillis: 1200,
    cached: false,
    ...overrides,
  };
}

function makeSong(overrides: Partial<StageSongInput> = {}): StageSongInput {
  return {
    title: "How Great Is Our God",
    key: "G",
    bpm: 75,
    meter: "4/4",
    position: 1,
    referencePath: "/refs/track.mp3",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAudioTracksWithClips).mockResolvedValue({} as never);
  vi.mocked(createSectionMarker).mockResolvedValue({} as never);
  vi.mocked(upsertSongTempoMarker).mockResolvedValue({} as never);
  vi.mocked(upsertSongTimeSignatureMarker).mockResolvedValue({} as never);
  vi.mocked(commitTrackMixChange).mockResolvedValue({} as never);
  vi.mocked(updateSongRegionKey).mockResolvedValue({} as never);
});

describe("Phase 1 — non-musical cues are not songs", () => {
  it("drops liturgy items in both bundled languages", () => {
    const cues = [
      { title: "Welkom & mededelingen" },
      { title: "Preek" },
      { title: "Opening prayer" },
      { title: "Sermon" },
      { title: "Collecte / offering" },
      { title: "How Great Is Our God" },
      { title: "Blessed Be Your Name" },
      { title: "Opwekking 821" },
    ];
    const songs = cues.filter(isMusicalSong);
    expect(songs.map((cue) => cue.title)).toEqual([
      "How Great Is Our God",
      "Blessed Be Your Name",
      "Opwekking 821",
    ]);
  });

  it("keeps an unknown title rather than dropping a real song", () => {
    expect(isMusicalSong({ title: "Kyrie eleison" })).toBe(true);
    expect(isMusicalSong({ title: "   " })).toBe(false);
  });
});

describe("Phase 3 — bar-grid quantization", () => {
  it("snaps a raw boundary to the downbeat of the nearest measure", () => {
    const plan = planStageSession({
      songs: [makeSong()],
      analyses: { "/refs/track.mp3": makeAnalysis() },
    });

    expect(plan.songs).toHaveLength(1);
    const sections = plan.songs[0].sections;
    expect(sections.map((section) => section.name)).toEqual([
      "Intro",
      "Verse",
      "Chorus",
      "Verse 2",
      "Chorus 2",
    ]);
    expect(sections.map((section) => section.seconds)).toEqual([
      0, 12.8, 38.4, 64, 96,
    ]);
    expect(sections.map((section) => section.bar)).toEqual([1, 5, 13, 21, 31]);
    expect(sections.map((section) => section.kind)).toEqual([
      "intro",
      "verse",
      "chorus",
      "verse",
      "chorus",
    ]);
    // Repeats carry the numbered voice-guide variant the engine picks clips by.
    expect(sections.map((section) => section.variant)).toEqual([
      null,
      null,
      null,
      2,
      2,
    ]);
  });

  it("prefers detected downbeats over the regular grid", () => {
    const downbeats = [0, 3.15, 6.3, 9.45];
    const plan = planStageSession({
      songs: [makeSong()],
      analyses: {
        "/refs/track.mp3": makeAnalysis({
          bpm: 75,
          downbeats,
          segments: [
            { start: 0, end: 3, label: "intro" },
            { start: 6.4, end: 10, label: "chorus" },
          ],
          durationSeconds: 10,
        }),
      },
    });
    expect(plan.songs[0].sections.map((section) => section.name)).toEqual([
      "Intro",
      "Chorus",
    ]);
    const chorus = plan.songs[0].sections[1];
    expect(chorus.seconds).toBe(6.3); // the nearest detected beat 1
    expect(chorus.bar).toBe(2);
    expect(chorus.source).toBe("downbeat");
  });

  it("falls back to the model tempo when WorshipTools has none", () => {
    const plan = planStageSession({
      songs: [makeSong({ bpm: null })],
      analyses: { "/refs/track.mp3": makeAnalysis({ bpm: 118 }) },
    });
    expect(plan.songs[0].bpm).toBe(118);
    expect(plan.songs[0].tempoSource).toBe("analysis");
    expect(plan.songs[0].sections).not.toHaveLength(0);
  });

  it("prefers the WorshipTools target tempo over what the model heard", () => {
    const plan = planStageSession({
      songs: [makeSong({ bpm: 76 })],
      analyses: { "/refs/track.mp3": makeAnalysis({ bpm: 75 }) },
    });
    expect(plan.songs[0].bpm).toBe(76);
    expect(plan.songs[0].tempoSource).toBe("worshiptools");
  });

  it("skips markers, not the song, when there is no tempo at all", () => {
    const plan = planStageSession({
      songs: [makeSong({ bpm: null })],
      analyses: { "/refs/track.mp3": makeAnalysis({ bpm: null }) },
    });
    expect(plan.songs).toHaveLength(1);
    expect(plan.songs[0].sections).toEqual([]);
    expect(plan.songs[0].sectionsSkipped).toBe(true);
    expect(plan.warnings.join(" ")).toContain("section markers skipped");
  });
});

describe("Phase 1/2 — songs that cannot be laid out", () => {
  it("reports each excluded song with a reason", () => {
    const plan = planStageSession({
      songs: [
        makeSong({ title: "No audio", referencePath: null }),
        makeSong({ title: "Not analyzed", referencePath: "/refs/other.mp3" }),
        makeSong({ title: "Zero length", referencePath: "/refs/empty.mp3" }),
      ],
      analyses: {
        "/refs/empty.mp3": makeAnalysis({ durationSeconds: 0, segments: [] }),
      },
    });
    expect(plan.songs).toEqual([]);
    expect(plan.skipped).toEqual([
      { title: "No audio", reason: "no-reference" },
      { title: "Not analyzed", reason: "not-analyzed" },
      { title: "Zero length", reason: "no-duration" },
    ]);
  });

  it("lays songs back to back in setlist order", () => {
    const plan = planStageSession({
      songs: [
        makeSong({ title: "First", referencePath: "/refs/a.mp3", position: 1 }),
        makeSong({ title: "Second", referencePath: "/refs/b.mp3", position: 3 }),
      ],
      analyses: {
        "/refs/a.mp3": makeAnalysis({ durationSeconds: 128 }),
        "/refs/b.mp3": makeAnalysis({ durationSeconds: 64 }),
      },
      gapSeconds: 4,
    });
    expect(plan.songs[0].offsetSeconds).toBe(0);
    expect(plan.songs[1].offsetSeconds).toBe(132);
    expect(plan.totalDurationSeconds).toBe(200);
    // Each song's first section sits on its own bar 1, absolutely offset.
    expect(plan.songs[1].sections[0].seconds).toBe(132);
    expect(plan.songs[1].sections[1].seconds).toBe(144.8);
  });
});

describe("Phase 4 — writing the plan into the session", () => {
  const view = {
    regions: [
      { id: "region_a", startSeconds: 0, endSeconds: 100 },
      { id: "region_b", startSeconds: 100, endSeconds: 300 },
    ],
    tracks: [
      { id: "t1", name: "1. First (ref)" },
      { id: "t2", name: "Voice" },
      { id: "t3", name: "2. Second (ref)" },
    ],
  };

  it("places clips, grid markers, sections, then mutes the scratch tracks", async () => {
    vi.mocked(getSongView).mockResolvedValue(view as never);

    const plan = planStageSession({
      songs: [
        makeSong({ title: "First", referencePath: "/refs/a.mp3", position: 1 }),
        makeSong({ title: "Second", referencePath: "/refs/b.mp3", position: 3, key: "D" }),
      ],
      analyses: {
        "/refs/a.mp3": makeAnalysis({ durationSeconds: 128 }),
        "/refs/b.mp3": makeAnalysis({ durationSeconds: 64 }),
      },
      gapSeconds: 4,
    });

    const progress: string[] = [];
    const result = await buildStageSession(plan, (step) => progress.push(step.phase));

    // One batched clip drop instead of one rebuild per song.
    expect(createAudioTracksWithClips).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAudioTracksWithClips).mock.calls[0][0]).toEqual([
      { trackName: "1. First (ref)", filePath: "/refs/a.mp3", timelineStartSeconds: 0 },
      { trackName: "3. Second (ref)", filePath: "/refs/b.mp3", timelineStartSeconds: 132 },
    ]);

    // Tempo and meter re-base at every song start.
    expect(vi.mocked(upsertSongTempoMarker).mock.calls).toEqual([
      [0, 75],
      [132, 75],
    ]);
    expect(vi.mocked(upsertSongTimeSignatureMarker).mock.calls).toEqual([
      [0, "4/4"],
      [132, "4/4"],
    ]);

    // Section markers: first of the second song lands at 132s (its own bar 1).
    const markerCalls = vi.mocked(createSectionMarker).mock.calls;
    expect(markerCalls).toHaveLength(10);
    expect(markerCalls[5]).toEqual([132, { kind: "intro", variant: null, name: "Intro" }]);
    expect(markerCalls[7]).toEqual([170.4, { kind: "chorus", variant: null, name: "Chorus" }]);
    expect(markerCalls[9]).toEqual([228, { kind: "chorus", variant: 2, name: "Chorus 2" }]);

    // Scratch disposal: only the "(ref)" tracks get muted, never the mix.
    expect(vi.mocked(commitTrackMixChange).mock.calls).toEqual([
      [{ trackId: "t1", muted: true }],
      [{ trackId: "t3", muted: true }],
    ]);

    // The key lands on whichever region covers that song's start.
    expect(vi.mocked(updateSongRegionKey).mock.calls).toEqual([
      ["region_a", "G"],
      ["region_b", "D"],
    ]);

    expect(result).toMatchObject({
      songsBuilt: 2,
      markersCreated: 10,
      referenceTracksMuted: 2,
      keysApplied: 2,
      skipped: [],
    });
    expect(progress).toContain("clips");
    expect(progress).toContain("markers");
    expect(progress).toContain("cleanup");
  });

  it("stops at the failing step and names the song it was working on", async () => {
    vi.mocked(getSongView).mockResolvedValue(view as never);
    vi.mocked(createSectionMarker).mockRejectedValueOnce(new Error("boom"));

    const plan = planStageSession({
      songs: [makeSong()],
      analyses: { "/refs/track.mp3": makeAnalysis() },
    });

    await expect(buildStageSession(plan)).rejects.toThrow(
      /Stage build failed while creating the "Intro" marker for "How Great Is Our God"/,
    );
    // Nothing further was attempted: no muting, no key changes.
    expect(commitTrackMixChange).not.toHaveBeenCalled();
    expect(updateSongRegionKey).not.toHaveBeenCalled();
  });
});
