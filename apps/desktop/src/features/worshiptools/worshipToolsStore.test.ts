import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorshipToolsStore } from "./worshipToolsStore";
import * as wtApi from "./wtApi";

describe("worshipToolsStore", () => {
  beforeEach(() => {
    useWorshipToolsStore.setState({
      services: [],
      upcoming: [],
      past: [],
      selectedServiceId: null,
      selectedService: null,
      setlist: null,
      roster: null,
      isLoadingServices: false,
      isLoadingSetlist: false,
      isLoadingRoster: false,
      error: null,
      references: {},
      activeTab: "setlist",
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads services and auto-selects the first upcoming service", async () => {
    const mockServices: wtApi.WTServicesResult = {
      upcoming: [
        {
          id: "svc-1",
          name: "Ochtenddienst",
          datetime: "2026-10-18T10:00:00Z",
          displayDate: "Zo 18 okt 2026 - 10:00",
          time: "10:00",
          isToday: false,
          isPast: false,
          cuesCount: 12,
          rehearsals: [],
        },
      ],
      past: [],
      count: 1,
    };

    const mockSetlist: wtApi.WTSetlistResult = {
      service: { id: "svc-1", name: "Ochtenddienst", displayDate: "Zo 18 okt 2026 - 10:00" },
      songs: [{ title: "Song 1", key: "G", bpm: 72, meter: "4/4", position: 1 }],
      count: 1,
    };

    const mockRoster: wtApi.WTRosterResult = {
      service: { id: "svc-1", name: "Ochtenddienst", displayDate: "Zo 18 okt 2026 - 10:00" },
      teams: [
        {
          name: "Worship Team",
          order: 2,
          accepted: 1,
          declined: 0,
          pending: 0,
          members: [
            { name: "Shamir", role: "Drums", roleOrder: 8, status: "accepted", userId: "u1" },
          ],
        },
      ],
      roster: [
        { name: "Shamir", role: "Drums", status: "accepted", team: "Worship Team", userId: "u1" },
      ],
      counts: { total: 1, accepted: 1, pending: 0, declined: 0 },
    };

    vi.spyOn(wtApi, "fetchWtServices").mockResolvedValue(mockServices);
    vi.spyOn(wtApi, "fetchWtSetlist").mockResolvedValue(mockSetlist);
    vi.spyOn(wtApi, "fetchWtRoster").mockResolvedValue(mockRoster);

    await useWorshipToolsStore.getState().loadServices();

    const state = useWorshipToolsStore.getState();
    expect(state.services).toHaveLength(1);
    expect(state.selectedServiceId).toBe("svc-1");
    expect(state.selectedService?.name).toBe("Ochtenddienst");
    expect(state.setlist?.songs).toHaveLength(1);
    expect(state.roster?.teams).toHaveLength(1);
  });

  it("stores and clears reference tracks per row key", () => {
    const store = useWorshipToolsStore.getState();
    store.setReference("svc-1:cue-1", "C:/audio/track1.wav");
    expect(useWorshipToolsStore.getState().references["svc-1:cue-1"]).toBe("C:/audio/track1.wav");

    store.clearReference("svc-1:cue-1");
    expect(useWorshipToolsStore.getState().references["svc-1:cue-1"]).toBeUndefined();
  });
});
