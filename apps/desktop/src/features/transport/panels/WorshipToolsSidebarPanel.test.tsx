import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useWorshipToolsStore } from "../../worshiptools/worshipToolsStore";
import { WorshipToolsSidebarPanel } from "./WorshipToolsSidebarPanel";

describe("WorshipToolsSidebarPanel", () => {
  beforeEach(() => {
    useWorshipToolsStore.setState({
      services: [
        {
          id: "svc-1",
          name: "Zondagdienst",
          datetime: "2026-10-18T10:00:00Z",
          displayDate: "Zo 18 okt 2026 - 10:00",
          time: "10:00",
          isToday: false,
          isPast: false,
          cuesCount: 5,
          rehearsals: ["Do 19:30"],
        },
      ],
      upcoming: [
        {
          id: "svc-1",
          name: "Zondagdienst",
          datetime: "2026-10-18T10:00:00Z",
          displayDate: "Zo 18 okt 2026 - 10:00",
          time: "10:00",
          isToday: false,
          isPast: false,
          cuesCount: 5,
          rehearsals: ["Do 19:30"],
        },
      ],
      past: [],
      selectedServiceId: "svc-1",
      selectedService: {
        id: "svc-1",
        name: "Zondagdienst",
        datetime: "2026-10-18T10:00:00Z",
        displayDate: "Zo 18 okt 2026 - 10:00",
        time: "10:00",
        isToday: false,
        isPast: false,
        cuesCount: 5,
        rehearsals: ["Do 19:30"],
      },
      setlist: {
        service: { id: "svc-1", name: "Zondagdienst", displayDate: "Zo 18 okt 2026 - 10:00" },
        songs: [
          { title: "Way Maker", key: "E", bpm: 68, meter: "4/4", position: 1 },
          { title: "Gebed", key: "—", bpm: null, meter: "4/4", position: 2 },
        ],
        count: 2,
      },
      roster: {
        service: { id: "svc-1", name: "Zondagdienst", displayDate: "Zo 18 okt 2026 - 10:00" },
        teams: [
          {
            name: "Tech Team",
            order: 1,
            accepted: 1,
            declined: 0,
            pending: 0,
            members: [
              { name: "Milad", role: "Audio", roleOrder: 2, status: "accepted", userId: "u1" },
            ],
          },
        ],
        roster: [
          { name: "Milad", role: "Audio", status: "accepted", team: "Tech Team", userId: "u1" },
        ],
        counts: { total: 1, accepted: 1, pending: 0, declined: 0 },
      },
      isLoadingServices: false,
      isLoadingSetlist: false,
      isLoadingRoster: false,
      error: null,
      references: {},
      activeTab: "setlist",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders service dropdown with upcoming options and displays songs", () => {
    render(
      <WorshipToolsSidebarPanel
        isOpen={true}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    // Dropdown contains the service
    const select = screen.getByLabelText(/select service/i) as HTMLSelectElement;
    expect(select.value).toBe("svc-1");
    expect(screen.getByText(/Zo 18 okt 2026 - 10:00 · Zondagdienst/i)).toBeTruthy();

    // Songs rendered
    expect(screen.getByText("Way Maker")).toBeTruthy();
    expect(screen.getByText("Gebed")).toBeTruthy();
    expect(screen.getByText("68 BPM")).toBeTruthy();
    expect(screen.getByText("E")).toBeTruthy();
  });

  it("switches to roster tab when clicking roster pill", () => {
    render(
      <WorshipToolsSidebarPanel
        isOpen={true}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const rosterTab = screen.getByRole("tab", { name: /roster/i });
    fireEvent.click(rosterTab);

    expect(screen.getByText("Tech Team")).toBeTruthy();
    expect(screen.getByText("Milad")).toBeTruthy();
    expect(screen.getByText("Audio")).toBeTruthy();
  });
});
