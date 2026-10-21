import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { pickLibraryFiles } from "@libretracks/shared/desktopApi";

import { formatUserFacingError } from "../errors/formatTransportError";
import {
  DEFAULT_MIR_SERVER_URL,
  analyzeReferenceAudio,
  fetchMirHealth,
  getStoredMirServerUrl,
  storeMirServerUrl,
  type MirAnalysis,
  type MirHealth,
} from "../../worshiptools/mirApi";
import {
  downloadCsvFile,
  fetchRehearseSong,
  getRehearseStatus,
  listenRehearseToken,
  openRehearseWindow,
  saveRehearseToken,
  type RehearseStatus,
} from "../../worshiptools/rehearseApi";
import {
  buildStageSession,
  isMusicalSong,
  planStageSession,
  type StageBuildResult,
  type StageProgress,
  type StageSongInput,
} from "../../worshiptools/stageSession";
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
  type WTConnectionMode,
  type WTCredentials,
  type WTSong,
  type WTService,
} from "../../worshiptools/wtApi";

const MAX_LISTED_SONGS = 150;

type SectionStatus = {
  kind: "loading" | "error" | "info";
  message: string;
};

type SetlistEntry = {
  serviceId: string;
  songs: WTSong[];
};

function fileNameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * Stable identity for one row of a service's setlist.
 *
 * The setlist endpoint returns `cueId` and `position` but never `songId` —
 * that field only exists on the library payload. Keying references on
 * `songId` therefore produced `references[undefined]`, a single shared slot,
 * so picking a reference track for one song attached it to EVERY song in the
 * service. Key on what the payload actually sent, scoped per service so two
 * services can never collide.
 */
function setlistRowKey(serviceId: string, song: WTSong, index: number): string {
  return `${serviceId}:${song.cueId ?? song.songId ?? index}`;
}

type SetlistRow = { song: WTSong; key: string; index: number };

function setlistRows(serviceId: string, songs: WTSong[]): SetlistRow[] {
  return songs.map((song, index) => ({
    song,
    key: setlistRowKey(serviceId, song, index),
    index,
  }));
}

/** `no-reference` → `noReference`, so the i18n key stays camelCase. */
function skipReasonKey(reason: string): string {
  return reason.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

type SongRowProps = {
  song: WTSong;
  /** Present only in a setlist — the library view stays a read-only list. */
  inSetlist?: boolean;
  referencePath?: string;
  onPick?: () => void;
  onClear?: () => void;
  disabled?: boolean;
};

function SongRow({ song, inSetlist, referencePath, onPick, onClear, disabled }: SongRowProps) {
  const { t } = useTranslation();
  const musical = !inSetlist || isMusicalSong(song);
  const details = [
    song.key && song.key !== "—" ? song.key : null,
    song.bpm ? `${song.bpm} BPM` : null,
    song.meter,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="lt-wt-song-row">
      <span className="lt-wt-song-title">
        {song.title}
        {inSetlist && !musical ? (
          <span className="lt-wt-song-nonsong">
            {t("transport.settingsModal.wtNotASong", { defaultValue: "not a song" })}
          </span>
        ) : null}
      </span>
      <span className="lt-wt-song-meta">{details}</span>
      {inSetlist && musical ? (
        <span className="lt-wt-reference">
          {referencePath ? (
            <>
              <span className="lt-wt-reference-file" title={referencePath}>
                {fileNameOf(referencePath)}
              </span>
              <button
                type="button"
                className="lt-secondary-button lt-wt-reference-btn"
                disabled={disabled}
                onClick={onClear}
              >
                {t("transport.settingsModal.wtClearReference", { defaultValue: "Remove" })}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="lt-secondary-button lt-wt-reference-btn"
              disabled={disabled}
              onClick={onPick}
            >
              {t("transport.settingsModal.wtPickReference", { defaultValue: "Choose audio…" })}
            </button>
          )}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Settings → WorshipTools: picks a service, attaches a reference track to each
 * song, runs the local MIR analysis over them and builds a stage session —
 * bar-aligned section markers, per-song tempo/meter/key, and the scratch
 * reference tracks muted so nothing bleeds into the live mix.
 *
 * The build is written into whichever session is currently open; nothing here
 * creates, replaces or discards a session.
 */
export function WorshipToolsSettingsTab() {
  const { t } = useTranslation();
  const [connectionMode, setConnectionMode] = useState<WTConnectionMode>(() => getStoredWtConnectionMode());
  const [credentials, setCredentials] = useState<WTCredentials>(() => getStoredWtCredentials());
  const [serverUrl, setServerUrl] = useState(() => getStoredWtServerUrl());
  const [showToken, setShowToken] = useState(false);
  const [servicesStatus, setServicesStatus] = useState<SectionStatus | null>(null);
  const [libraryStatus, setLibraryStatus] = useState<SectionStatus | null>(null);
  const [upcoming, setUpcoming] = useState<WTService[]>([]);
  const [past, setPast] = useState<WTService[]>([]);
  const [library, setLibrary] = useState<WTSong[]>([]);
  const [libraryCount, setLibraryCount] = useState(0);
  const [search, setSearch] = useState("");
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [setlist, setSetlist] = useState<SetlistEntry | null>(null);
  const [setlistStatus, setSetlistStatus] = useState<SectionStatus | null>(null);

  // Stage-session build state.
  const [references, setReferences] = useState<Record<string, string>>({});
  const [mirUrl, setMirUrl] = useState(() => getStoredMirServerUrl());
  const [mirHealth, setMirHealth] = useState<MirHealth | null>(null);
  const [mirStatus, setMirStatus] = useState<SectionStatus | null>(null);
  const [buildStatus, setBuildStatus] = useState<SectionStatus | null>(null);
  const [progress, setProgress] = useState<StageProgress | null>(null);
  const [result, setResult] = useState<StageBuildResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // CCLI Rehearse state.
  const [rehearseStatus, setRehearseStatus] = useState<RehearseStatus>({
    hasToken: false,
    lastTrackId: null,
  });
  const [rehearseManualToken, setRehearseManualToken] = useState("");
  const [showRehearseToken, setShowRehearseToken] = useState(false);
  const [rehearseTestTrack, setRehearseTestTrack] = useState("");
  const [rehearseStatusMsg, setRehearseStatusMsg] = useState<SectionStatus | null>(null);

  useEffect(() => {
    void getRehearseStatus().then(setRehearseStatus);
    const unlistenPromise = listenRehearseToken(() => {
      void getRehearseStatus().then((s) => {
        setRehearseStatus(s);
        setRehearseStatusMsg({
          kind: "info",
          message: t("transport.settingsModal.rehearseTokenCaptured", {
            defaultValue: "Live Rehearse token captured from webview!",
          }),
        });
      });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [t]);

  const handleOpenRehearse = async (targetUrl?: string) => {
    try {
      await openRehearseWindow(targetUrl);
    } catch (err) {
      setRehearseStatusMsg({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSaveRehearseToken = async () => {
    if (!rehearseManualToken.trim()) return;
    try {
      await saveRehearseToken(rehearseManualToken.trim());
      const s = await getRehearseStatus();
      setRehearseStatus(s);
      setRehearseStatusMsg({
        kind: "info",
        message: t("transport.settingsModal.rehearseTokenSaved", {
          defaultValue: "Rehearse token saved successfully!",
        }),
      });
      setTimeout(() => setRehearseStatusMsg(null), 3000);
    } catch (err) {
      setRehearseStatusMsg({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleTestRehearseExport = async () => {
    const id = rehearseTestTrack.trim() || rehearseStatus.lastTrackId || "";
    if (!id) {
      setRehearseStatusMsg({
        kind: "error",
        message: t("transport.settingsModal.rehearseMissingTrackId", {
          defaultValue: "Please enter a Track ID or Rehearse song URL.",
        }),
      });
      return;
    }
    setRehearseStatusMsg({
      kind: "loading",
      message: t("transport.settingsModal.rehearseFetching", {
        defaultValue: "Fetching Rehearse song markers…",
      }),
    });
    try {
      const res = await fetchRehearseSong(id, rehearseManualToken);
      downloadCsvFile(`${res.title}_markers.csv`, res.csv);
      setRehearseStatusMsg({
        kind: "info",
        message: t("transport.settingsModal.rehearseExportSuccess", {
          count: res.markers.length,
          title: res.title,
          defaultValue: `Exported ${res.markers.length} markers for "${res.title}" to CSV!`,
        }),
      });
    } catch (err) {
      setRehearseStatusMsg({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const showError = useCallback(
    (error: unknown) =>
      ({
        kind: "error",
        message: formatUserFacingError(error, t),
      }) as SectionStatus,
    [t],
  );

  const loadServices = useCallback(
    async (force: boolean, baseUrl?: string) => {
      setServicesStatus({
        kind: "loading",
        message: t("transport.settingsModal.wtLoading", {
          defaultValue: "Loading services…",
        }),
      });
      try {
        const data = await fetchWtServices(force, baseUrl);
        setUpcoming(data.upcoming);
        setPast(data.past);
        setServicesStatus(null);
      } catch (error) {
        setServicesStatus(showError(error));
      }
    },
    [showError, t],
  );

  const loadLibrary = useCallback(
    async (force: boolean, baseUrl?: string) => {
      setLibraryStatus({
        kind: "loading",
        message: t("transport.settingsModal.wtLoading", {
          defaultValue: "Loading services…",
        }),
      });
      try {
        const data = await fetchWtLibrary(force, baseUrl);
        setLibrary(data.songs);
        setLibraryCount(data.count);
        setLibraryStatus(null);
      } catch (error) {
        setLibraryStatus(showError(error));
      }
    },
    [showError, t],
  );

  const checkMir = useCallback(
    async (baseUrl?: string) => {
      const base = storeMirServerUrl(baseUrl ?? mirUrl);
      setMirUrl(base);
      setMirStatus({
        kind: "loading",
        message: t("transport.settingsModal.wtMirChecking", {
          defaultValue: "Checking the analysis service…",
        }),
      });
      try {
        const health = await fetchMirHealth(base);
        setMirHealth(health);
        setMirStatus({
          kind: health.available ? "info" : "error",
          message: health.detail,
        });
        return health;
      } catch (error) {
        setMirHealth(null);
        setMirStatus(showError(error));
        return null;
      }
    },
    [mirUrl, showError, t],
  );

  // First open: pull services, library and the analysis-service health.
  useEffect(() => {
    void loadServices(false);
    void loadLibrary(false);
    void checkMir();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  const handleSaveDirect = () => {
    const updated = storeWtCredentials(credentials);
    setCredentials(updated);
    storeWtConnectionMode("direct");
    setOpenServiceId(null);
    setSetlist(null);
    void loadServices(true, "direct");
    void loadLibrary(true, "direct");
  };

  const handleSaveServer = () => {
    const normalized = storeWtServerUrl(serverUrl);
    setServerUrl(normalized);
    storeWtConnectionMode("server");
    setOpenServiceId(null);
    setSetlist(null);
    void loadServices(true, normalized);
    void loadLibrary(true, normalized);
  };

  const handleSwitchMode = (mode: WTConnectionMode) => {
    setConnectionMode(mode);
    storeWtConnectionMode(mode);
    setOpenServiceId(null);
    setSetlist(null);
    void loadServices(true, mode === "direct" ? "direct" : serverUrl);
    void loadLibrary(true, mode === "direct" ? "direct" : serverUrl);
  };

  const handleToggleService = (service: WTService) => {
    if (openServiceId === service.id) {
      setOpenServiceId(null);
      setSetlist(null);
      setSetlistStatus(null);
      setBuildStatus(null);
      setResult(null);
      return;
    }
    setOpenServiceId(service.id);
    setSetlist(null);
    setBuildStatus(null);
    setResult(null);
    void (async () => {
      setSetlistStatus({
        kind: "loading",
        message: t("transport.settingsModal.wtLoadingSetlist", {
          defaultValue: "Loading setlist…",
        }),
      });
      try {
        const data = await fetchWtSetlist(service.id, false, serverUrl);
        setSetlist({ serviceId: service.id, songs: data.songs });
        setSetlistStatus(null);
      } catch (error) {
        setSetlistStatus(showError(error));
      }
    })();
  };

  const handlePickReference = (rowKey: string) => {
    void (async () => {
      try {
        const paths = await pickLibraryFiles();
        if (!paths || paths.length === 0) return; // cancelled
        setReferences((previous) => ({ ...previous, [rowKey]: paths[0] }));
      } catch (error) {
        setBuildStatus(showError(error));
      }
    })();
  };

  const handleClearReference = (songId: string) => {
    setReferences((previous) => {
      const next = { ...previous };
      delete next[songId];
      return next;
    });
  };

  const handleBuild = (service: WTService, songs: WTSong[]) => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setResult(null);

    void (async () => {
      const setStatus = (status: SectionStatus | null) => setBuildStatus(status);
      try {
        // Phase 1 — musical cues only, in setlist order, each keeping its own
        // reference slot (see setlistRowKey).
        const rows = setlistRows(service.id, songs).filter((row) =>
          isMusicalSong(row.song),
        );
        const inputs: (StageSongInput & { referencePath: string })[] = [];
        for (const row of rows) {
          const referencePath = references[row.key];
          if (!referencePath) continue;
          inputs.push({
            title: row.song.title,
            key: row.song.key,
            bpm: row.song.bpm,
            meter: row.song.meter,
            position: row.index + 1,
            referencePath,
          });
        }
        if (inputs.length === 0) {
          setStatus(
            showError(
              new Error(
                t("transport.settingsModal.wtBuildNoReferences", {
                  defaultValue:
                    "Pick a reference audio track for at least one song before building.",
                }),
              ),
            ),
          );
          return;
        }

        // Phase 2 — every reference track through the local MIR model.
        const health = await fetchMirHealth();
        if (!health.available) {
          setStatus(showError(new Error(health.detail)));
          return;
        }
        setMirHealth(health);

        const analyses: Record<string, MirAnalysis> = {};
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          setStatus({
            kind: "loading",
            message: t("transport.settingsModal.wtAnalyzing", {
              title: input.title,
              current: index + 1,
              total: inputs.length,
              defaultValue:
                "Analyzing {{title}} — step {{current}} of {{total}}. This can take a few minutes on CPU…",
            }),
          });
          analyses[input.referencePath] = await analyzeReferenceAudio(
            input.referencePath,
            { signal: controller.signal, baseUrl: mirUrl },
          );
        }

        // Phase 3 — snap every boundary onto its bar grid.
        const plan = planStageSession({ songs: inputs, analyses });
        if (plan.songs.length === 0) {
          setStatus(
            showError(
              new Error(
                t("transport.settingsModal.wtBuildNothing", {
                  defaultValue:
                    "Nothing could be laid out — no song had usable reference audio.",
                }),
              ),
            ),
          );
          return;
        }

        // Phase 4 — markers, tempo/meter, keys, scratch tracks muted.
        setStatus({
          kind: "loading",
          message: t("transport.settingsModal.wtBuilding", {
            defaultValue: "Building the stage session in the open session…",
          }),
        });
        const built = await buildStageSession(plan, setProgress);
        setResult(built);
        setStatus({
          kind: "info",
          message: t("transport.settingsModal.wtBuildDone", {
            songs: built.songsBuilt,
            markers: built.markersCreated,
            muted: built.referenceTracksMuted,
            defaultValue:
              "Built {{songs}} song(s) with {{markers}} section marker(s); muted {{muted}} reference track(s).",
          }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus({
            kind: "info",
            message: t("transport.settingsModal.wtBuildCancelled", {
              defaultValue: "Build cancelled — nothing further was written.",
            }),
          });
        } else {
          setStatus(showError(error));
        }
      } finally {
        setProgress(null);
        abortRef.current = null;
      }
    })();
  };

  const filteredLibrary = search.trim()
    ? library.filter((song) =>
        song.title.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : library;
  const shownLibrary = filteredLibrary.slice(0, MAX_LISTED_SONGS);

  const renderStatus = (status: SectionStatus | null) =>
    status ? (
      <small
        className={`lt-update-check-status${
          status.kind === "error"
            ? " lt-update-check-status--error"
            : status.kind === "info"
              ? " lt-update-check-status--new"
              : ""
        }`}
        aria-live="polite"
      >
        {status.message}
      </small>
    ) : null;

  const renderServiceGroup = (
    label: string,
    services: WTService[],
  ) =>
    services.length === 0 ? null : (
      <div className="lt-settings-field">
        <span className="lt-settings-field-label">{label}</span>
        <ul className="lt-wt-list">
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                className="lt-wt-service-row"
                aria-expanded={openServiceId === service.id}
                onClick={() => handleToggleService(service)}
              >
                <span className="lt-wt-service-date">{service.displayDate}</span>
                <span className="lt-wt-service-name">
                  {service.name}
                  {service.cuesCount
                    ? ` · ${service.cuesCount} cues`
                    : ""}
                </span>
              </button>
              {openServiceId === service.id ? (
                <div className="lt-wt-setlist">
                  {renderStatus(setlistStatus)}
                  {setlist && setlist.serviceId === service.id ? (
                    setlist.songs.length === 0 ? (
                      <small>
                        {t("transport.settingsModal.wtEmptySetlist", {
                          defaultValue: "This service has no songs yet.",
                        })}
                      </small>
                    ) : (
                      <>                          <ul className="lt-wt-list">
                            {setlistRows(service.id, setlist.songs).map((row) => (
                              <SongRow
                                key={row.key}
                                song={row.song}
                                inSetlist
                                referencePath={references[row.key]}
                                disabled={progress !== null}
                                onPick={() => handlePickReference(row.key)}
                                onClear={() => handleClearReference(row.key)}
                              />
                            ))}
                          </ul>
                        {renderBuildPanel(service, setlist.songs)}
                      </>
                    )
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );

  const renderBuildPanel = (service: WTService, songs: WTSong[]) => {
    const chosenCount = setlistRows(service.id, songs).filter(
      (row) => isMusicalSong(row.song) && references[row.key],
    ).length;
    const skipped = result?.skipped ?? [];

    return (
      <div className="lt-wt-build">
        <small className="lt-wt-build-hint">
          {t("transport.settingsModal.wtBuildHint", {
            defaultValue:
              "Analyzes each reference track, snaps every section to the nearest bar, adds section markers (with the “Name… two, three, four” count-in), sets each song's tempo/meter/key, then mutes the reference audio. It writes into the session that is currently open — use File → New first for a clean stage session.",
          })}
        </small>

        <div className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.settingsModal.wtMirTitle", {
              defaultValue: "Analysis service",
            })}
          </span>
          <small>
            {t("transport.settingsModal.wtMirDescription", {
              defaultValue:
                "The local allinone model runs behind a small loopback service. Start it from analysis-service, then check it here.",
            })}
          </small>
          <div className="lt-inline-actions">
            <input
              type="text"
              className="lt-wt-server-input"
              value={mirUrl}
              spellCheck={false}
              aria-label={t("transport.settingsModal.wtMirUrl", {
                defaultValue: "MIR analysis service URL",
              })}
              placeholder={DEFAULT_MIR_SERVER_URL}
              onChange={(event) => setMirUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void checkMir();
                }
              }}
            />
            <button
              type="button"
              className="lt-secondary-button"
              disabled={mirStatus?.kind === "loading"}
              onClick={() => void checkMir()}
            >
              {t("transport.settingsModal.wtMirCheck", { defaultValue: "Check" })}
            </button>
          </div>
          {renderStatus(mirStatus)}
        </div>

        <div className="lt-inline-actions lt-inline-actions--split">
          <span className="lt-settings-field-label">
            {t("transport.settingsModal.wtBuildTitle", {
              defaultValue: "Build stage session",
            })}
          </span>
          <span className="lt-wt-build-count">
            {t("transport.settingsModal.wtReferenceCount", {
              count: chosenCount,
              defaultValue: "{{count}} reference track(s) chosen",
            })}
          </span>
        </div>

        <div className="lt-inline-actions">
          {progress || abortRef.current ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => abortRef.current?.abort()}
            >
              {t("transport.settingsModal.wtCancel", { defaultValue: "Cancel" })}
            </button>
          ) : (
            <button
              type="button"
              className="lt-secondary-button"
              disabled={!mirHealth?.available || chosenCount === 0}
              onClick={() => handleBuild(service, songs)}
            >
              {t("transport.settingsModal.wtBuild", {
                defaultValue: "Analyze & build",
              })}
            </button>
          )}
        </div>

        {progress ? (
          <small className="lt-wt-progress" aria-live="polite">
            {t(`transport.settingsModal.wtPhase_${progress.phase}`, {
              defaultValue: progress.phase,
            })}
            {progress.label && progress.phase !== "clips" && progress.phase !== "cleanup"
              ? ` — ${progress.current}/${progress.total} ${progress.label}`
              : ""}
          </small>
        ) : null}

        {renderStatus(buildStatus)}

        {result && skipped.length > 0 ? (
          <ul className="lt-wt-list lt-wt-skipped">
            {skipped.map((entry) => (
              <li key={`${entry.title}-${entry.reason}`} className="lt-wt-skip-row">
                <span className="lt-wt-song-title">{entry.title}</span>
                <span className="lt-wt-song-meta">
                  {t(`transport.settingsModal.wtSkip_${skipReasonKey(entry.reason)}`, {
                    defaultValue: entry.reason.replace(/-/g, " "),
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {result && result.warnings.length > 0 ? (
          <ul className="lt-wt-list lt-wt-skipped">
            {result.warnings.map((warning) => (
              <li key={warning} className="lt-wt-skip-row">
                <span className="lt-wt-song-meta">{warning}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };

  return (
    <div className="lt-settings-section-grid">
      <div className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.wtTitle", {
            defaultValue: "WorshipTools",
          })}
        </span>
        <small>
          {t("transport.settingsModal.wtDescription", {
            defaultValue:
              "Browse services, setlists and the song library from WorshipTools, then build a stage session from a service.",
          })}
        </small>

        <div className="lt-inline-actions" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={`lt-secondary-button ${connectionMode === "direct" ? "lt-button--primary" : ""}`}
            style={{ fontWeight: connectionMode === "direct" ? "bold" : "normal" }}
            onClick={() => handleSwitchMode("direct")}
          >
            {t("transport.settingsModal.wtDirectMode", { defaultValue: "Direct (Standalone)" })}
          </button>
          <button
            type="button"
            className={`lt-secondary-button ${connectionMode === "server" ? "lt-button--primary" : ""}`}
            style={{ fontWeight: connectionMode === "server" ? "bold" : "normal" }}
            onClick={() => handleSwitchMode("server")}
          >
            {t("transport.settingsModal.wtServerMode", { defaultValue: "Ichtus Server" })}
          </button>
        </div>

        {connectionMode === "direct" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div className="lt-inline-actions">
              <span style={{ minWidth: "7.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
                {t("transport.settingsModal.wtAccountId", { defaultValue: "Account ID" })}:
              </span>
              <input
                type="text"
                className="lt-wt-server-input"
                value={credentials.accountId}
                spellCheck={false}
                placeholder="6973c054-..."
                onChange={(event) =>
                  setCredentials((previous) => ({ ...previous, accountId: event.target.value }))
                }
              />
            </div>
            <div className="lt-inline-actions">
              <span style={{ minWidth: "7.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
                {t("transport.settingsModal.wtApiKey", { defaultValue: "API Key" })}:
              </span>
              <input
                type={showToken ? "text" : "password"}
                className="lt-wt-server-input"
                value={credentials.apiKey}
                spellCheck={false}
                placeholder="AIzaSy..."
                onChange={(event) =>
                  setCredentials((previous) => ({ ...previous, apiKey: event.target.value }))
                }
              />
            </div>
            <div className="lt-inline-actions">
              <span style={{ minWidth: "7.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
                {t("transport.settingsModal.wtRefreshToken", { defaultValue: "Refresh Token" })}:
              </span>
              <input
                type={showToken ? "text" : "password"}
                className="lt-wt-server-input"
                value={credentials.refreshToken}
                spellCheck={false}
                placeholder="AMf-vBx..."
                onChange={(event) =>
                  setCredentials((previous) => ({ ...previous, refreshToken: event.target.value }))
                }
              />
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken
                  ? t("transport.settingsModal.wtHideToken", { defaultValue: "Hide" })
                  : t("transport.settingsModal.wtShowToken", { defaultValue: "Show" })}
              </button>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={handleSaveDirect}
              >
                {t("transport.settingsModal.wtSaveDirect", { defaultValue: "Save & Connect" })}
              </button>
            </div>
          </div>
        ) : (
          <div className="lt-inline-actions">
            <input
              type="text"
              className="lt-wt-server-input"
              value={serverUrl}
              spellCheck={false}
              aria-label={t("transport.settingsModal.wtServerUrl", {
                defaultValue: "Ichtus server URL",
              })}
              placeholder={DEFAULT_WT_SERVER_URL}
              onChange={(event) => setServerUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSaveServer();
                }
              }}
            />
            <button
              type="button"
              className="lt-secondary-button"
              onClick={handleSaveServer}
            >
              {t("transport.settingsModal.wtServerSave", {
                defaultValue: "Save & reload",
              })}
            </button>
          </div>
        )}
      </div>

      <div className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.rehearseTitle", {
            defaultValue: "CCLI Rehearse (Section Markers)",
          })}
        </span>
        <small>
          {t("transport.settingsModal.rehearseDescription", {
            defaultValue:
              "Automatically capture live auth tokens and song section markers from CCLI Rehearse to build timeline markers and export CSVs.",
          })}
        </small>

        <div className="lt-inline-actions" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
          <div className="lt-wt-status-indicator" style={{ marginRight: "1rem" }}>
            <span className={`lt-wt-status-dot ${rehearseStatus.hasToken ? "is-online" : "is-offline"}`} />
            <span style={{ fontSize: "0.8rem" }}>
              {rehearseStatus.hasToken
                ? t("transport.settingsModal.rehearseTokenActive", { defaultValue: "Active (Token in memory)" })
                : t("transport.settingsModal.rehearseNoToken", { defaultValue: "No Token Captured" })}
            </span>
          </div>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void handleOpenRehearse("https://songselect.ccli.com")}
            >
              <span className="material-symbols-outlined">queue_music</span>
              {t("transport.settingsModal.openSongSelectWebview", { defaultValue: "SongSelect (CCLI)" })}
            </button>
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void handleOpenRehearse("https://planning.worshiptools.com")}
            >
              <span className="material-symbols-outlined">open_in_new</span>
              {t("transport.settingsModal.openPlanningWebview", { defaultValue: "Planning" })}
            </button>
            <button
              type="button"
              className="lt-secondary-button"
              style={{ opacity: 0.8 }}
              onClick={() => void handleOpenRehearse("https://rehearse.ccli.com")}
            >
              {t("transport.settingsModal.openRehearseWebview", { defaultValue: "CCLI Rehearse" })}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
          <div className="lt-inline-actions">
            <span style={{ minWidth: "7.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
              {t("transport.settingsModal.rehearseManualToken", { defaultValue: "Bearer Token" })}:
            </span>
            <input
              type={showRehearseToken ? "text" : "password"}
              className="lt-wt-server-input"
              value={rehearseManualToken}
              placeholder={rehearseStatus.hasToken ? "•••••••• (Token active)" : "eyJhbGciOi..."}
              spellCheck={false}
              onChange={(e) => setRehearseManualToken(e.target.value)}
            />
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => setShowRehearseToken(!showRehearseToken)}
            >
              {showRehearseToken
                ? t("transport.settingsModal.wtHideToken", { defaultValue: "Hide" })
                : t("transport.settingsModal.wtShowToken", { defaultValue: "Show" })}
            </button>
            <button
              type="button"
              className="lt-secondary-button"
              disabled={!rehearseManualToken.trim()}
              onClick={() => void handleSaveRehearseToken()}
            >
              {t("transport.settingsModal.saveToken", { defaultValue: "Save Token" })}
            </button>
          </div>

          <div className="lt-inline-actions">
            <span style={{ minWidth: "7.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
              {t("transport.settingsModal.testExport", { defaultValue: "Test Export" })}:
            </span>
            <input
              type="text"
              className="lt-wt-server-input"
              value={rehearseTestTrack}
              placeholder="Track ID or URL (e.g. 123456)"
              spellCheck={false}
              onChange={(e) => setRehearseTestTrack(e.target.value)}
            />
            <button
              type="button"
              className="lt-secondary-button"
              disabled={rehearseStatusMsg?.kind === "loading"}
              onClick={() => void handleTestRehearseExport()}
            >
              <span className="material-symbols-outlined">download</span>
              {t("transport.settingsModal.exportCsvBtn", { defaultValue: "Fetch & Download CSV" })}
            </button>
          </div>
        </div>

        {renderStatus(rehearseStatusMsg)}
      </div>

      <div className="lt-settings-field">
        <div className="lt-inline-actions lt-inline-actions--split">
          <span className="lt-settings-field-label">
            {t("transport.settingsModal.wtServices", {
              defaultValue: "Services",
            })}
          </span>
          <button
            type="button"
            className="lt-secondary-button"
            disabled={servicesStatus?.kind === "loading"}
            onClick={() => void loadServices(true, serverUrl)}
          >
            {t("transport.settingsModal.wtRefresh", { defaultValue: "Refresh" })}
          </button>
        </div>
        {renderStatus(servicesStatus)}
        {!servicesStatus && upcoming.length === 0 && past.length === 0 ? (
          <small>
            {t("transport.settingsModal.wtNoServices", {
              defaultValue: "No services found on the server.",
            })}
          </small>
        ) : (
          <div className="lt-wt-service-dropdown-container" style={{ margin: "0.5rem 0" }}>
            <select
              className="lt-wt-service-dropdown"
              value={openServiceId ?? ""}
              aria-label={t("transport.worshiptools.selectService", { defaultValue: "Select service" })}
              onChange={(e) => {
                const id = e.target.value;
                const svc = [...upcoming, ...past].find((s) => s.id === id);
                if (svc) handleToggleService(svc);
                else if (openServiceId) {
                  const cur = [...upcoming, ...past].find((s) => s.id === openServiceId);
                  if (cur) handleToggleService(cur);
                }
              }}
            >
              <option value="">
                {t("transport.worshiptools.chooseServicePlaceholder", { defaultValue: "— Choose service from dropdown —" })}
              </option>
              {upcoming.length > 0 && (
                <optgroup label={t("transport.worshiptools.upcomingGroup", { defaultValue: "Upcoming services" })}>
                  {upcoming.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayDate} · {s.name} ({s.cuesCount} cues)
                    </option>
                  ))}
                </optgroup>
              )}
              {past.length > 0 && (
                <optgroup label={t("transport.worshiptools.pastGroup", { defaultValue: "Past services" })}>
                  {past.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayDate} · {s.name} ({s.cuesCount} cues)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        )}
        {renderServiceGroup(
          t("transport.settingsModal.wtUpcoming", {
            defaultValue: "Upcoming",
          }),
          upcoming,
        )}
        {renderServiceGroup(
          t("transport.settingsModal.wtPast", { defaultValue: "Past" }),
          past,
        )}
      </div>

      <div className="lt-settings-field">
        <div className="lt-inline-actions lt-inline-actions--split">
          <span className="lt-settings-field-label">
            {t("transport.settingsModal.wtLibrary", {
              defaultValue: "Song library",
            })}
          </span>
          <button
            type="button"
            className="lt-secondary-button"
            disabled={libraryStatus?.kind === "loading"}
            onClick={() => void loadLibrary(true, serverUrl)}
          >
            {t("transport.settingsModal.wtRefresh", { defaultValue: "Refresh" })}
          </button>
        </div>
        {libraryCount > 0 ? (
          <small>
            {t("transport.settingsModal.wtSongCount", {
              count: libraryCount,
              defaultValue: "{{count}} song(s) in WorshipTools",
            })}
          </small>
        ) : null}
        <input
          type="text"
          className="lt-wt-search"
          value={search}
          placeholder={t("transport.settingsModal.wtSearchPlaceholder", {
            defaultValue: "Search songs…",
          })}
          aria-label={t("transport.settingsModal.wtSearchPlaceholder", {
            defaultValue: "Search songs…",
          })}
          onChange={(event) => setSearch(event.target.value)}
        />
        {renderStatus(libraryStatus)}
        {!libraryStatus && filteredLibrary.length === 0 ? (
          <small>
            {t("transport.settingsModal.wtNoResults", {
              defaultValue: "No songs match.",
            })}
          </small>
        ) : null}
        {shownLibrary.length > 0 ? (
          <ul className="lt-wt-list">
            {shownLibrary.map((song, index) => (
              <SongRow key={song.songId ?? `lib-${index}`} song={song} />
            ))}
          </ul>
        ) : null}
        {filteredLibrary.length > MAX_LISTED_SONGS ? (
          <small>
            {t("transport.settingsModal.wtTruncated", {
              shown: MAX_LISTED_SONGS,
              total: filteredLibrary.length,
              defaultValue:
                "Showing the first {{shown}} of {{total}} songs — refine the search to see more.",
            })}
          </small>
        ) : null}
      </div>
    </div>
  );
}
