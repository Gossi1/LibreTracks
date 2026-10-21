import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WT_SERVER_URL,
  fetchWtLibrary,
  fetchWtServices,
  fetchWtSetlist,
  getStoredWtConnectionMode,
  getStoredWtCredentials,
  getStoredWtServerUrl,
  storeWtConnectionMode,
  storeWtCredentials,
  storeWtServerUrl,
  WtApiError,
} from "./wtApi";
import { clearDirectCaches } from "./wtDirect";

const BASE = DEFAULT_WT_SERVER_URL;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  clearDirectCaches();
});

describe("wtApi server URL and mode", () => {
  it("defaults to the local Ichtus server and strips trailing slashes", () => {
    expect(getStoredWtServerUrl()).toBe("http://127.0.0.1:8080");
    expect(storeWtServerUrl("http://192.168.1.5:8080///")).toBe(
      "http://192.168.1.5:8080",
    );
    expect(getStoredWtServerUrl()).toBe("http://192.168.1.5:8080");
  });

  it("stores and retrieves connection mode", () => {
    expect(getStoredWtConnectionMode()).toBe("direct");
    expect(storeWtConnectionMode("server")).toBe("server");
    expect(getStoredWtConnectionMode()).toBe("server");
  });

  it("stores and retrieves direct credentials", () => {
    const creds = storeWtCredentials({
      accountId: "acc-123",
      refreshToken: "ref-456",
    });
    expect(creds.accountId).toBe("acc-123");
    expect(creds.refreshToken).toBe("ref-456");
    const retrieved = getStoredWtCredentials();
    expect(retrieved.accountId).toBe("acc-123");
    expect(retrieved.refreshToken).toBe("ref-456");
  });
});

describe("fetchWtServices (server mode)", () => {
  beforeEach(() => {
    storeWtConnectionMode("server");
  });

  it("calls the services endpoint on the stored server", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        jsonResponse({
          success: true,
          upcoming: [{ id: "svc-1", name: "Kerkdienst" }],
          past: [],
          count: 1,
        }),
      );

    const result = await fetchWtServices();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE}/api/worshiptools-services/services`,
    );
    expect(result.upcoming).toHaveLength(1);
    expect(result.upcoming[0]?.id).toBe("svc-1");
    expect(result.count).toBe(1);
  });

  it("adds ?refresh=1 when forcing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ success: true, upcoming: [], past: [] }));

    await fetchWtServices(true, "http://server.local:8080/");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://server.local:8080/api/worshiptools-services/services?refresh=1",
    );
  });

  it("throws WtApiError when the server reports success:false", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ success: false, error: "Firestore geweigerd" }),
    );
    await expect(fetchWtServices()).rejects.toThrowError(WtApiError);
    await expect(fetchWtServices()).rejects.toThrow("Firestore geweigerd");
  });

  it("throws WtApiError on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("boom", { status: 502 }),
    );
    await expect(fetchWtServices()).rejects.toThrow("HTTP 502");
  });

  it("throws WtApiError when the server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchWtServices()).rejects.toThrow(
      "Could not reach the Ichtus server",
    );
  });
});

describe("fetchWtSetlist (server mode)", () => {
  beforeEach(() => {
    storeWtConnectionMode("server");
  });

  it("encodes the service id and passes songs through", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        success: true,
        service: { id: "a/b", name: "Kerkdienst", displayDate: "Vr 09 okt" },
        songs: [
          { songId: "s1", title: "Rooftops", key: "E", bpm: 74, meter: "4/4" },
        ],
        count: 1,
      }),
    );

    const result = await fetchWtSetlist("a/b", true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE}/api/worshiptools-services/services/a%2Fb/setlist?live=1`,
    );
    expect(result.songs[0]?.title).toBe("Rooftops");
    expect(result.count).toBe(1);
  });
});

describe("fetchWtLibrary (server mode)", () => {
  beforeEach(() => {
    storeWtConnectionMode("server");
  });

  it("returns songs with defaults for missing fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ success: true, songs: [{ songId: "x", title: "Song" }] }),
    );

    const result = await fetchWtLibrary();
    expect(result.songs).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.songs[0]?.bpm).toBeUndefined();
  });
});

describe("Direct Standalone WorshipTools Client", () => {
  beforeEach(() => {
    storeWtConnectionMode("direct");
    storeWtCredentials({
      apiKey: "mock-test-key",
      accountId: "acc1",
      refreshToken: "mock-test-refresh",
    });
  });

  it("authenticates with Google SecureToken and queries Firestore cuelists", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("securetoken.googleapis.com")) {
        return jsonResponse({
          id_token: "mock-id-token-xyz",
          expires_in: "3600",
        });
      }
      if (u.includes("firestore.googleapis.com") && u.includes("/cuelists")) {
        return jsonResponse({
          documents: [
            {
              name: "projects/worship-extreme-datastore/databases/(default)/documents/accounts/acc1/cuelists/svc-100",
              fields: {
                name: { stringValue: "Zondag Dienst" },
                data: {
                  mapValue: {
                    fields: {
                      cuelist_title: { stringValue: "Zondag Dienst" },
                      cues: {
                        arrayValue: {
                          values: [
                            {
                              mapValue: {
                                fields: {
                                  displayName: { stringValue: "Song 1" },
                                  cue_id: { stringValue: "cue-1" },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
                service: {
                  mapValue: {
                    fields: {
                      times: {
                        arrayValue: {
                          values: [
                            {
                              mapValue: {
                                fields: {
                                  time: { stringValue: "2026-10-18T10:00:00" },
                                  type: { stringValue: "service" },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fetchWtServices();
    expect(fetchMock).toHaveBeenCalled();
    expect(result.upcoming.length + result.past.length).toBe(1);
    const service = result.upcoming[0] ?? result.past[0];
    expect(service?.id).toBe("svc-100");
    expect(service?.name).toBe("Zondag Dienst");
    expect(service?.cuesCount).toBe(1);
  });

  it("extracts song metadata from Firestore cuelist and song documents", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("securetoken.googleapis.com")) {
        return jsonResponse({ id_token: "mock-token", expires_in: "3600" });
      }
      if (u.includes("/cuelists/svc-100")) {
        return jsonResponse({
          name: "projects/.../cuelists/svc-100",
          fields: {
            name: { stringValue: "Zondag" },
            data: {
              mapValue: {
                fields: {
                  cues: {
                    arrayValue: {
                      values: [
                        {
                          mapValue: {
                            fields: {
                              displayName: { stringValue: "Oceans" },
                              cue_id: { stringValue: "cue-oceans" },
                              cue_foreground: {
                                mapValue: {
                                  fields: {
                                    text: { stringValue: "song-oceans-id" },
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                  songMeta: {
                    mapValue: {
                      fields: {
                        "cue-oceans": {
                          mapValue: {
                            fields: {
                              key: { stringValue: "D" },
                              tempo: { integerValue: "64" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }
      if (u.includes("/songs/song-oceans-id")) {
        return jsonResponse({
          name: "projects/.../songs/song-oceans-id",
          fields: {
            name: { stringValue: "Oceans (Where Feet May Fail)" },
            data: {
              mapValue: {
                fields: {
                  defaultKey: { stringValue: "D" },
                  timeSignature: { stringValue: "4/4" },
                },
              },
            },
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const setlist = await fetchWtSetlist("svc-100", true);
    expect(setlist.songs).toHaveLength(1);
    expect(setlist.songs[0]?.title).toBe("Oceans");
    expect(setlist.songs[0]?.key).toBe("D");
    expect(setlist.songs[0]?.bpm).toBe(64);
    expect(setlist.songs[0]?.meter).toBe("4/4");
    expect(setlist.songs[0]?.songId).toBe("song-oceans-id");
  });

  it("fetches and groups roster by team and normalizes status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("securetoken.googleapis.com")) {
        return jsonResponse({ id_token: "mock-token", expires_in: 3600 });
      }
      if (u.includes("/cuelists/svc-100/people")) {
        return jsonResponse({
          documents: [
            {
              fields: {
                user: { stringValue: "96d782bf-af5e-4f5a-ac76-b97d5768e052" }, // Shamir Rozenblad
                role: { stringValue: "5530795a-bd30-454e-99fe-a5073c93b620" }, // Drums (Worship Team)
                status: { stringValue: "accepted" },
              },
            },
            {
              fields: {
                user: { stringValue: "a88a4a10-809e-4fc3-a9de-c615ff91f061" }, // Milad Mosayebi
                role: { stringValue: "bfd25f3f-ef53-4a7b-813a-fdede2b1f0b8" }, // Audio (Tech Team)
                status: { stringValue: "accepted" },
              },
            },
          ],
        });
      }
      if (u.includes("/cuelists/svc-100")) {
        return jsonResponse({
          fields: {
            service: {
              mapValue: {
                fields: {
                  name: { stringValue: "Zondagdienst" },
                },
              },
            },
          },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const { fetchWtRoster, setPeopleCache } = await import("./wtApi");
    setPeopleCache({
      "96d782bf-af5e-4f5a-ac76-b97d5768e052": "Shamir Rozenblad",
      "a88a4a10-809e-4fc3-a9de-c615ff91f061": "Milad Mosayebi",
    });
    const rosterResult = await fetchWtRoster("svc-100", true);
    expect(rosterResult.teams).toHaveLength(2);
    expect(rosterResult.teams[0].name).toBe("Tech Team");
    expect(rosterResult.teams[0].members[0].name).toBe("Milad Mosayebi");
    expect(rosterResult.teams[0].members[0].role).toBe("Audio");
    expect(rosterResult.teams[1].name).toBe("Worship Team");
    expect(rosterResult.teams[1].members[0].name).toBe("Shamir Rozenblad");
    expect(rosterResult.teams[1].members[0].role).toBe("Drums");
    expect(rosterResult.counts.accepted).toBe(2);
  });
});

