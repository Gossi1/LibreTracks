import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => {
      const base = options?.defaultValue ?? key;
      return typeof options?.count === "number"
        ? base.replace("{{count}}", String(options.count))
        : base;
    },
  }),
}));

const pickLibraryFiles = vi.fn();
const fetchWtServices = vi.fn();
const fetchWtSetlist = vi.fn();
const fetchWtLibrary = vi.fn();
const fetchMirHealth = vi.fn();

vi.mock("@libretracks/shared/desktopApi", () => ({
  pickLibraryFiles: (...args: unknown[]) => pickLibraryFiles(...args),
}));

vi.mock("../../worshiptools/wtApi", () => ({
  DEFAULT_WT_SERVER_URL: "http://127.0.0.1:8080",
  getStoredWtServerUrl: () => "http://127.0.0.1:8080",
  storeWtServerUrl: (url: string) => url,
  getStoredWtConnectionMode: () => "server",
  storeWtConnectionMode: (mode: string) => mode,
  getStoredWtCredentials: () => ({ accountId: "test-acc", refreshToken: "test-ref", apiKey: "test-key" }),
  storeWtCredentials: (creds: unknown) => creds,
  fetchWtServices: (...args: unknown[]) => fetchWtServices(...args),
  fetchWtSetlist: (...args: unknown[]) => fetchWtSetlist(...args),
  fetchWtLibrary: (...args: unknown[]) => fetchWtLibrary(...args),
}));

vi.mock("../../worshiptools/mirApi", () => ({
  DEFAULT_MIR_SERVER_URL: "http://127.0.0.1:8799",
  getStoredMirServerUrl: () => "http://127.0.0.1:8799",
  storeMirServerUrl: (url: string) => url,
  fetchMirHealth: (...args: unknown[]) => fetchMirHealth(...args),
  analyzeReferenceAudio: vi.fn(),
}));

vi.mock("../errors/formatTransportError", () => ({
  formatUserFacingError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

import { WorshipToolsSettingsTab } from "./WorshipToolsSettingsTab";

const SERVICE = {
  id: "svc-1",
  name: "Zondag ochtend",
  datetime: "2026-10-11T10:00:00Z",
  displayDate: "11 okt",
  time: "10:00",
  isToday: false,
  isPast: false,
  cuesCount: 5,
  rehearsals: [],
};

const SETLIST = [
  { songId: "song-1", title: "How Great Is Our God", key: "G", bpm: 75, meter: "4/4" },
  { songId: "song-2", title: "Preek", key: "—", bpm: null, meter: "4/4" },
  { songId: "song-3", title: "Blessed Be Your Name", key: "D", bpm: 138, meter: "4/4" },
];

async function openSetlist() {
  render(<WorshipToolsSettingsTab />);
  const serviceButton = await screen.findByRole("button", { name: /Zondag ochtend/ });
  fireEvent.click(serviceButton);
  await screen.findByText("Blessed Be Your Name");
}

describe("WorshipToolsSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWtServices.mockResolvedValue({ upcoming: [SERVICE], past: [], count: 1 });
    fetchWtLibrary.mockResolvedValue({ songs: [], count: 0 });
    fetchWtSetlist.mockResolvedValue({ service: SERVICE, songs: SETLIST, count: 3 });
    fetchMirHealth.mockResolvedValue({
      success: true,
      available: true,
      detail: "allin1 ready (model=harmonix-fold0, device=cpu)",
      model: "harmonix-fold0",
      cache: { entries: 0, bytes: 0 },
      service: "libretracks-mir",
      version: "1.0.0",
    });
    pickLibraryFiles.mockResolvedValue([]);
  });

  it("marks the cues that are not songs and offers reference audio only for songs", async () => {
    await openSetlist();

    // The sermon is still listed — it belongs to the service — but it is not a
    // song, so it gets no reference-track control.
    expect(screen.getByText("Preek")).toBeTruthy();
    expect(screen.getByText("not a song")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Choose audio…" })).toHaveLength(2);
  });

  it("stays blocked until a reference track has been chosen", async () => {
    await openSetlist();

    expect(
      screen.getByRole("button", { name: "Analyze & build" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("0 reference track(s) chosen")).toBeTruthy();
  });

  it("attaches a reference track and unlocks the build", async () => {
    pickLibraryFiles.mockResolvedValue(["C:/refs/how-great.mp3"]);
    await openSetlist();

    fireEvent.click(screen.getAllByRole("button", { name: "Choose audio…" })[0]);

    await waitFor(() => {
      expect(screen.getByText("how-great.mp3")).toBeTruthy();
      expect(screen.getByText("1 reference track(s) chosen")).toBeTruthy();
    });
    expect(pickLibraryFiles).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Analyze & build" }),
    ).toHaveProperty("disabled", false);

    // Removing it takes the reference back out and blocks the build again.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(screen.getByText("0 reference track(s) chosen")).toBeTruthy();
    });
  });

  it("keeps each song's reference separate when the payload has no songId", async () => {
    // Regression: the setlist route returns only cueId/position/title/key/bpm/
    // meter. Keying references on `songId` made every row share
    // `references[undefined]`, so choosing one file attached it to the whole
    // service.
    fetchWtSetlist.mockResolvedValue({
      service: SERVICE,
      songs: [
        { cueId: "cue-1", position: 1, title: "How Great Is Our God", key: "G", bpm: 75, meter: "4/4" },
        { cueId: "cue-2", position: 2, title: "Blessed Be Your Name", key: "D", bpm: 138, meter: "4/4" },
        { cueId: "cue-3", position: 3, title: "Worthy Is The Lamb", key: "E", bpm: 68, meter: "4/4" },
      ],
      count: 3,
    });
    pickLibraryFiles.mockResolvedValue(["C:/refs/first.mp3"]);
    await openSetlist();

    fireEvent.click(screen.getAllByRole("button", { name: "Choose audio…" })[0]);

    await waitFor(() => {
      expect(screen.getByText("first.mp3")).toBeTruthy();
      expect(screen.getByText("1 reference track(s) chosen")).toBeTruthy();
    });
    // Exactly one row took the file; the others are untouched.
    expect(screen.getAllByText("first.mp3")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose audio…" })).toHaveLength(2);
  });

  it("reports an unreachable analysis service instead of failing later", async () => {
    fetchMirHealth.mockRejectedValue(
      new Error("Could not reach the MIR analysis service at http://127.0.0.1:8799"),
    );
    await openSetlist();

    await waitFor(() => {
      expect(
        screen.getByText(/Could not reach the MIR analysis service/),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Analyze & build" }),
    ).toHaveProperty("disabled", true);
  });
});
