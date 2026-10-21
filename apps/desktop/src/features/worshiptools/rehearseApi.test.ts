import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRehearseMarkersToTimeline,
  downloadCsvFile,
  fetchRehearseSong,
  getRehearseStatus,
  openRehearseWindow,
  saveRehearseToken,
  type RehearseSongResult,
} from "./rehearseApi";
import * as desktopApi from "../transport/desktopApi";

vi.mock("../transport/desktopApi", () => ({
  createSectionMarker: vi.fn().mockResolvedValue({}),
}));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("rehearseApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls open_rehearse_window via Tauri invoke", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await openRehearseWindow();
    expect(mockInvoke).toHaveBeenCalledWith("open_rehearse_window", { url: null });

    await openRehearseWindow("https://planning.worshiptools.com");
    expect(mockInvoke).toHaveBeenCalledWith("open_rehearse_window", { url: "https://planning.worshiptools.com" });
  });

  it("calls save_rehearse_token with token", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveRehearseToken("my-test-token");
    expect(mockInvoke).toHaveBeenCalledWith("save_rehearse_token", { token: "my-test-token" });
  });

  it("returns status from get_rehearse_status", async () => {
    mockInvoke.mockResolvedValueOnce({ hasToken: true, lastTrackId: "track-123" });
    const status = await getRehearseStatus();
    expect(status).toEqual({ hasToken: true, lastTrackId: "track-123" });
  });

  it("fetches rehearse song and trims custom token", async () => {
    const mockResult: RehearseSongResult = {
      trackId: "track-123",
      title: "Great Are You Lord",
      timeSignature: "6/8",
      bpm: 72,
      beatsPerBar: 6,
      markers: [
        {
          name: "Intro",
          kind: "intro",
          variant: null,
          startSeconds: 0,
          startBeat: 1,
          endBeat: 12,
          startMeasure: 1,
          durationMeasures: 2,
        },
      ],
      csv: "#,Name,Start (s),Measure,Length (Measures)\nM1,INTRO,0.00,1,2\n",
    };
    mockInvoke.mockResolvedValueOnce(mockResult);

    const result = await fetchRehearseSong("track-123", "  bearer-abc  ");
    expect(mockInvoke).toHaveBeenCalledWith("fetch_rehearse_song", {
      trackId: "track-123",
      customToken: "bearer-abc",
    });
    expect(result.title).toBe("Great Are You Lord");
    expect(result.markers).toHaveLength(1);
  });

  it("applies parsed rehearse markers to the timeline with offset", async () => {
    const mockResult: RehearseSongResult = {
      trackId: "track-456",
      title: "Way Maker",
      timeSignature: "4/4",
      bpm: 68,
      beatsPerBar: 4,
      markers: [
        {
          name: "Intro",
          kind: "intro",
          variant: null,
          startSeconds: 2.5,
          startBeat: 1,
          endBeat: 8,
          startMeasure: 1,
          durationMeasures: 2,
        },
        {
          name: "Verse 1",
          kind: "verse",
          variant: 1,
          startSeconds: 15.0,
          startBeat: 9,
          endBeat: 24,
          startMeasure: 3,
          durationMeasures: 4,
        },
      ],
      csv: "",
    };

    const res = await applyRehearseMarkersToTimeline(mockResult, 10.0);
    expect(res.createdCount).toBe(2);

    expect(desktopApi.createSectionMarker).toHaveBeenCalledTimes(2);
    expect(desktopApi.createSectionMarker).toHaveBeenNthCalledWith(1, 12.5, {
      kind: "intro",
      variant: null,
      name: "Intro",
    });
    expect(desktopApi.createSectionMarker).toHaveBeenNthCalledWith(2, 25.0, {
      kind: "verse",
      variant: 1,
      name: "Verse 1",
    });
  });

  it("triggers CSV download helper", () => {
    const createElementSpy = vi.spyOn(document, "createElement");
    const appendChildSpy = vi.spyOn(document.body, "appendChild").mockImplementation(() => null as never);
    const removeChildSpy = vi.spyOn(document.body, "removeChild").mockImplementation(() => null as never);
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();

    const mockAnchor = {
      href: "",
      setAttribute: vi.fn(),
      click: vi.fn(),
    };
    createElementSpy.mockReturnValueOnce(mockAnchor as never);

    downloadCsvFile("markers.csv", "test,data\n1,2");

    expect(mockAnchor.setAttribute).toHaveBeenCalledWith("download", "markers.csv");
    expect(mockAnchor.click).toHaveBeenCalled();
  });
});
