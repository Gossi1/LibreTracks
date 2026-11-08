import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
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
import { useCloudStore } from "../cloud/cloudStore";
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
          { title: "Oceans", key: "D", bpm: 130, meter: "4/4", position: 3 },
        ],
        count: 3,
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

    useCloudStore.setState({
      status: { configured: true, connected: true, provider: "google-drive" },
      files: {
        songs: [
          {
            id: "cf-1",
            name: "Way Maker [68bpm E 4-4].ltpkg",
            sizeBytes: 1000000,
            modified: "2026-10-15T00:00:00Z",
          },
        ],
        sessions: [],
      },
      loadingFolder: null,
      connecting: false,
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

  it("checks setlist songs against cloud drive and shows which songs exist and which are missing", () => {
    render(
      <WorshipToolsSidebarPanel
        isOpen={true}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    // Summary of found vs total musical songs (Way Maker found, Oceans missing = 1 of 2)
    expect(screen.getByText(/1 van 2 liederen beschikbaar/i)).toBeTruthy();

    // Way Maker is in Cloud
    expect(screen.getByText("In Cloud")).toBeTruthy();
    expect(screen.getByText("Way Maker [68bpm E 4-4].ltpkg")).toBeTruthy();

    // Oceans is NOT in Cloud
    expect(screen.getByText("Niet in Cloud")).toBeTruthy();
  });

  it("allows filtering setlist by All, In Cloud, and Missing", () => {
    render(
      <WorshipToolsSidebarPanel
        isOpen={true}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    // Initially both songs are visible
    expect(screen.getByText("Way Maker")).toBeTruthy();
    expect(screen.getByText("Oceans")).toBeTruthy();

    // Filter by "In Cloud"
    const inCloudPill = screen.getByRole("button", { name: /In Cloud \(1\)/i });
    fireEvent.click(inCloudPill);

    expect(screen.getByText("Way Maker")).toBeTruthy();
    expect(screen.queryByText("Oceans")).toBeNull();

    // Filter by "Missing"
    const missingPill = screen.getByRole("button", { name: /Ontbrekend \(1\)/i });
    fireEvent.click(missingPill);

    expect(screen.queryByText("Way Maker")).toBeNull();
    expect(screen.getByText("Oceans")).toBeTruthy();
  });

  it("does not violate rules of hooks when opening from closed state", () => {
    const { rerender } = render(
      <WorshipToolsSidebarPanel
        isOpen={false}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.queryByText("Way Maker")).toBeNull();

    // Opening from closed should render all hooks consistently without error
    rerender(
      <WorshipToolsSidebarPanel
        isOpen={true}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Way Maker")).toBeTruthy();
  });
});
