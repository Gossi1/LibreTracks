import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";

import {
  createEmptySong,
  discardStagedPackage,
  importSongPackageFromPathWithProgress,
  pickLibraryFiles,
  updateSongRegionKey,
  type CloudFile,
} from "@libretracks/shared/desktopApi";

import {
  applyRehearseMarkersToTimeline,
  clearRehearseToken,
  downloadCsvFile,
  fetchRehearseSong,
  getRehearseStatus,
  getRehearseToken,
  listenRehearseToken,
  listenRehearseTrack,
  openRehearseWindow,
  saveRehearseToken,
  type RehearseSongResult,
  type RehearseStatus,
} from "../../worshiptools/rehearseApi";
import { useWorshipToolsStore } from "../../worshiptools/worshipToolsStore";
import { isMusicalSong } from "../../worshiptools/stageSession";
import { matchSetlistWithCloud, type SetlistCloudMatchResult } from "../../worshiptools/setlistCloudMatcher";
import type { WTSong } from "../../worshiptools/wtApi";
import { stageFromCloud } from "../cloud/cloudFlows";
import { useCloudStore } from "../cloud/cloudStore";
import { getSong } from "../songStore";

type WorshipToolsSidebarPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
};

function fileNameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function WorshipToolsSidebarPanel({
  isOpen,
  onClose,
  onOpenSettings,
}: WorshipToolsSidebarPanelProps) {
  const { t } = useTranslation();
  const [, startTransition] = useTransition();

  const services = useWorshipToolsStore((state) => state.services);
  const upcoming = useWorshipToolsStore((state) => state.upcoming);
  const past = useWorshipToolsStore((state) => state.past);
  const selectedServiceId = useWorshipToolsStore((state) => state.selectedServiceId);
  const selectedService = useWorshipToolsStore((state) => state.selectedService);
  const setlist = useWorshipToolsStore((state) => state.setlist);
  const roster = useWorshipToolsStore((state) => state.roster);
  const isLoadingServices = useWorshipToolsStore((state) => state.isLoadingServices);
  const isLoadingSetlist = useWorshipToolsStore((state) => state.isLoadingSetlist);
  const isLoadingRoster = useWorshipToolsStore((state) => state.isLoadingRoster);
  const error = useWorshipToolsStore((state) => state.error);
  const references = useWorshipToolsStore((state) => state.references);
  const activeTab = useWorshipToolsStore((state) => state.activeTab);

  const loadServices = useWorshipToolsStore((state) => state.loadServices);
  const selectService = useWorshipToolsStore((state) => state.selectService);
  const setReference = useWorshipToolsStore((state) => state.setReference);
  const clearReference = useWorshipToolsStore((state) => state.clearReference);
  const setActiveTab = useWorshipToolsStore((state) => state.setActiveTab);

  const [isAddingTimeline, setIsAddingTimeline] = useState(false);
  const [timelineFeedback, setTimelineFeedback] = useState<string | null>(null);

  const [rehearseStatus, setRehearseStatus] = useState<RehearseStatus>({
    hasToken: false,
    lastTrackId: null,
  });
  const [rehearseTrackInput, setRehearseTrackInput] = useState("");
  const [isFetchingRehearse, setIsFetchingRehearse] = useState(false);
  const [rehearseSong, setRehearseSong] = useState<RehearseSongResult | null>(null);
  const [rehearseError, setRehearseError] = useState<string | null>(null);
  const [isApplyingMarkers, setIsApplyingMarkers] = useState(false);
  const [rehearseFeedback, setRehearseFeedback] = useState<string | null>(null);
  const [markerOffsetSeconds, setMarkerOffsetSeconds] = useState(0);

  const [showTokenInput, setShowTokenInput] = useState(false);
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);

  // Cloud Drive store bindings & states
  const cloudStatus = useCloudStore((state) => state.status);
  const cloudFiles = useCloudStore((state) => state.files.songs);
  const isLoadingCloudFiles = useCloudStore((state) => state.loadingFolder === "songs");
  const isConnectingCloud = useCloudStore((state) => state.connecting);
  const refreshCloudStatus = useCloudStore((state) => state.refreshStatus);
  const refreshCloudFiles = useCloudStore((state) => state.refreshFiles);
  const connectCloud = useCloudStore((state) => state.connect);

  const [cloudFilter, setCloudFilter] = useState<"all" | "found" | "missing">("all");
  const [importingSongKey, setImportingSongKey] = useState<string | null>(null);

  // Check Cloud connection status on open if not probed yet
  useEffect(() => {
    if (!isOpen) return;
    if (cloudStatus === null) {
      void refreshCloudStatus();
    }
  }, [isOpen, cloudStatus, refreshCloudStatus]);

  // Load cloud songs if cloud is connected and files not yet loaded
  useEffect(() => {
    if (!isOpen || !cloudStatus?.connected) return;
    if (activeTab === "setlist" && cloudFiles.length === 0 && !isLoadingCloudFiles) {
      void refreshCloudFiles("songs");
    }
  }, [isOpen, cloudStatus?.connected, activeTab, cloudFiles.length, isLoadingCloudFiles, refreshCloudFiles]);

  const initialLoadAttemptedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    let unlistenToken: (() => void) | undefined;
    let unlistenTrack: (() => void) | undefined;

    void getRehearseStatus().then((status) => {
      if (!isMounted) return;
      setRehearseStatus(status);
      if (status.lastTrackId) {
        setRehearseTrackInput((prev) => prev || status.lastTrackId || "");
      }
      if (!status.hasToken) {
        try {
          const stored = window.localStorage.getItem("libretracks.rehearse.token");
          if (stored && stored.trim()) {
            void saveRehearseToken(stored.trim()).then(() => {
              if (isMounted) {
                setRehearseStatus((prev) => ({ ...prev, hasToken: true }));
              }
            });
          }
        } catch {}
      }
    });

    void listenRehearseToken((capturedToken) => {
      if (!isMounted) return;
      setRehearseStatus((prev) => ({ ...prev, hasToken: true }));
      try {
        window.localStorage.setItem("libretracks.rehearse.token", capturedToken);
      } catch {}
      setRehearseFeedback(
        t("transport.worshiptools.tokenCapturedFeedback", {
          defaultValue: "Live Rehearse token captured!",
        }),
      );
      setTimeout(() => {
        if (isMounted) setRehearseFeedback(null);
      }, 4000);
    }).then((unlisten) => {
      if (isMounted) unlistenToken = unlisten;
      else unlisten();
    });

    void listenRehearseTrack((trackId) => {
      if (!isMounted) return;
      setRehearseStatus((prev) => ({ ...prev, lastTrackId: trackId }));
      setRehearseTrackInput(trackId);
    }).then((unlisten) => {
      if (isMounted) unlistenTrack = unlisten;
      else unlisten();
    });

    return () => {
      isMounted = false;
      unlistenToken?.();
      unlistenTrack?.();
    };
  }, [isOpen, t]);

  const handleOpenRehearse = async (targetUrl?: string) => {
    try {
      await openRehearseWindow(targetUrl);
    } catch (err) {
      setRehearseError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveManualToken = async () => {
    const trimmed = manualTokenInput.trim();
    if (!trimmed) return;
    setIsSavingToken(true);
    try {
      await saveRehearseToken(trimmed);
      setRehearseStatus((prev) => ({ ...prev, hasToken: true }));
      setManualTokenInput("");
      setShowTokenInput(false);
      setRehearseFeedback("Token saved & connected!");
      setTimeout(() => setRehearseFeedback(null), 3500);
    } catch (err) {
      setRehearseError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleClearToken = async () => {
    try {
      await clearRehearseToken();
      setRehearseStatus((prev) => ({ ...prev, hasToken: false }));
      setRehearseFeedback("Token cleared");
      setTimeout(() => setRehearseFeedback(null), 3000);
    } catch (err) {
      setRehearseError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFetchRehearse = async (overrideId?: string) => {
    const id = (overrideId ?? rehearseTrackInput).trim();
    if (!id) return;
    setIsFetchingRehearse(true);
    setRehearseError(null);
    setRehearseFeedback(null);
    try {
      const result = await fetchRehearseSong(id);
      setRehearseSong(result);
    } catch (err) {
      setRehearseError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFetchingRehearse(false);
    }
  };

  const handleApplyMarkers = async () => {
    if (!rehearseSong || rehearseSong.markers.length === 0 || isApplyingMarkers) return;
    setIsApplyingMarkers(true);
    setRehearseFeedback(null);
    try {
      const { createdCount } = await applyRehearseMarkersToTimeline(
        rehearseSong,
        markerOffsetSeconds,
      );
      setRehearseFeedback(
        t("transport.worshiptools.appliedMarkersSuccess", {
          count: createdCount,
          defaultValue: `Successfully applied ${createdCount} markers to the timeline!`,
        }),
      );
      setTimeout(() => setRehearseFeedback(null), 4000);
    } catch (err) {
      setRehearseError(
        t("transport.worshiptools.appliedMarkersError", {
          defaultValue: err instanceof Error ? err.message : "Failed to apply markers",
        }),
      );
    } finally {
      setIsApplyingMarkers(false);
    }
  };

  const handleExportCsv = () => {
    if (!rehearseSong) return;
    const cleanTitle = (rehearseSong.title || "rehearse_song").replace(/[\\/:*?"<>|]/g, "_");
    downloadCsvFile(`${cleanTitle}_markers.csv`, rehearseSong.csv);
  };

  const handleCopyCsv = async () => {
    if (!rehearseSong) return;
    try {
      await navigator.clipboard.writeText(rehearseSong.csv);
      setRehearseFeedback(
        t("transport.worshiptools.copiedCsvFeedback", { defaultValue: "CSV copied to clipboard!" }),
      );
      setTimeout(() => setRehearseFeedback(null), 3000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  // Load services when first opened if empty (at most once per open to prevent infinite re-render loops on failure)
  useEffect(() => {
    if (!isOpen) {
      initialLoadAttemptedRef.current = false;
      return;
    }
    if (!initialLoadAttemptedRef.current && services.length === 0 && !isLoadingServices) {
      initialLoadAttemptedRef.current = true;
      void loadServices(false);
    }
  }, [isOpen, services.length, isLoadingServices, loadServices]);

  const handleSelectServiceChange = (id: string) => {
    startTransition(() => {
      void selectService(id ? id : null);
    });
  };

  const handlePickReference = async (rowKey: string) => {
    try {
      const paths = await pickLibraryFiles();
      if (!paths || paths.length === 0) return;
      setReference(rowKey, paths[0]);
    } catch (err) {
      console.warn("Failed to pick reference file:", err);
    }
  };

  const handleAddSongsToTimeline = async () => {
    if (!setlist || setlist.songs.length === 0 || isAddingTimeline) return;
    setIsAddingTimeline(true);
    setTimelineFeedback(null);
    try {
      const musicalSongs = setlist.songs.filter(isMusicalSong);
      if (musicalSongs.length === 0) {
        setTimelineFeedback(
          t("transport.worshiptools.noMusicalSongs", {
            defaultValue: "No musical songs in this service.",
          }),
        );
        return;
      }

      for (const song of musicalSongs) {
        await createEmptySong(song.title);
        // If key is present and region was created, assign key
        if (song.key && song.key !== "—" && song.key !== "-") {
          const regions = getSong()?.regions;
          const lastRegion = regions ? regions[regions.length - 1] : undefined;
          if (lastRegion) {
            await updateSongRegionKey(lastRegion.id, song.key);
          }
        }
      }

      setTimelineFeedback(
        t("transport.worshiptools.addedSongsSuccess", {
          count: musicalSongs.length,
          defaultValue: `Added ${musicalSongs.length} song(s) to timeline!`,
        }),
      );
      setTimeout(() => setTimelineFeedback(null), 4000);
    } catch (err) {
      setTimelineFeedback(
        t("transport.worshiptools.addSongsError", {
          defaultValue: err instanceof Error ? err.message : "Failed to add songs",
        }),
      );
    } finally {
      setIsAddingTimeline(false);
    }
  };

  const songs = setlist?.songs ?? [];
  const musicalCount = songs.filter(isMusicalSong).length;

  const cloudMatchResult: SetlistCloudMatchResult = useMemo(() => {
    return matchSetlistWithCloud(songs, cloudFiles, selectedService?.id ?? "");
  }, [songs, cloudFiles, selectedService?.id]);

  const filteredSongs = useMemo(() => {
    if (cloudFilter === "all") return songs;
    return songs.filter((song, index) => {
      const rowKey = `${selectedService?.id ?? ""}:${song.cueId ?? song.songId ?? index}`;
      const match = cloudMatchResult.matchedMap.get(rowKey);
      const musical = isMusicalSong(song);
      if (cloudFilter === "found") {
        return musical && match?.hasMatch;
      }
      if (cloudFilter === "missing") {
        return musical && !match?.hasMatch;
      }
      return true;
    });
  }, [songs, cloudFilter, cloudMatchResult, selectedService?.id]);

  const handleImportCloudSong = async (song: WTSong, cloudFile: CloudFile, rowKey: string) => {
    if (importingSongKey) return;
    setImportingSongKey(rowKey);
    setTimelineFeedback(null);
    let localPath: string | null = null;
    try {
      localPath = await stageFromCloud(cloudFile);
      const pos = getSong()?.regions.length ? 999999 : 0;
      await importSongPackageFromPathWithProgress(localPath, pos);
      setTimelineFeedback(
        t("transport.worshiptools.importedCloudSongSuccess", {
          title: song.title,
          defaultValue: `"${song.title}" imported from Cloud Drive to timeline!`,
        }),
      );
      setTimeout(() => setTimelineFeedback(null), 4000);
    } catch (err) {
      setTimelineFeedback(
        t("transport.worshiptools.importCloudSongError", {
          defaultValue: err instanceof Error ? err.message : "Failed to import song from Cloud Drive",
        }),
      );
    } finally {
      if (localPath) {
        void discardStagedPackage(localPath).catch(() => {});
      }
      setImportingSongKey(null);
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      className="lt-library-panel lt-wt-sidebar-panel"
      aria-label="WorshipTools Services & Setlists"
    >
      <header className="lt-library-panel-header lt-wt-panel-header">
        <div className="lt-wt-panel-header-row">
          <div>
            <span className="lt-library-panel-eyebrow">WORSHIPTOOLS</span>
            <h2 className="lt-wt-panel-title">
              <span className="material-symbols-outlined lt-wt-title-icon">church</span>
              {t("transport.worshiptools.title", { defaultValue: "Services & Setlists" })}
            </h2>
          </div>
          <div className="lt-wt-header-actions">
            <button
              type="button"
              className={`lt-secondary-button lt-wt-icon-button ${
                isLoadingServices || isLoadingSetlist ? "is-spinning" : ""
              }`}
              title={t("transport.worshiptools.refresh", { defaultValue: "Refresh services" })}
              aria-label={t("transport.worshiptools.refresh", { defaultValue: "Refresh services" })}
              disabled={isLoadingServices || isLoadingSetlist}
              onClick={() => void loadServices(true)}
            >
              <span className="material-symbols-outlined">refresh</span>
            </button>
            <button
              type="button"
              className="lt-secondary-button lt-wt-icon-button"
              title={t("transport.worshiptools.settings", { defaultValue: "WorshipTools Settings" })}
              aria-label={t("transport.worshiptools.settings", { defaultValue: "WorshipTools Settings" })}
              onClick={onOpenSettings}
            >
              <span className="material-symbols-outlined">settings</span>
            </button>
            <button
              type="button"
              className="lt-secondary-button lt-wt-icon-button"
              title={t("common.close", { defaultValue: "Close" })}
              aria-label={t("common.close", { defaultValue: "Close" })}
              onClick={onClose}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        {/* ── Main Service Dropdown ── */}
        <div className="lt-wt-service-dropdown-container">
          <label htmlFor="lt-wt-service-select" className="lt-wt-select-label">
            {t("transport.worshiptools.selectService", { defaultValue: "Select service" })}
          </label>
          <div className="lt-wt-select-wrap">
            <select
              id="lt-wt-service-select"
              className="lt-wt-service-dropdown"
              value={selectedServiceId ?? ""}
              disabled={isLoadingServices}
              onChange={(e) => handleSelectServiceChange(e.target.value)}
            >
              <option value="">
                {isLoadingServices
                  ? t("transport.worshiptools.loadingServices", { defaultValue: "Loading services…" })
                  : t("transport.worshiptools.chooseServicePlaceholder", {
                      defaultValue: "— Choose service —",
                    })}
              </option>
              {upcoming.length > 0 && (
                <optgroup
                  label={t("transport.worshiptools.upcomingGroup", {
                    defaultValue: "Upcoming services",
                  })}
                >
                  {upcoming.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayDate} · {s.name} ({s.cuesCount} cues)
                    </option>
                  ))}
                </optgroup>
              )}
              {past.length > 0 && (
                <optgroup
                  label={t("transport.worshiptools.pastGroup", {
                    defaultValue: "Past services",
                  })}
                >
                  {past.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayDate} · {s.name} ({s.cuesCount} cues)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="material-symbols-outlined lt-wt-select-arrow" aria-hidden="true">
              arrow_drop_down
            </span>
          </div>
        </div>

        {error ? (
          <div className="lt-wt-error-banner" role="alert">
            <span className="material-symbols-outlined lt-wt-error-icon">warning</span>
            <div className="lt-wt-error-copy">
              <span>{error}</span>
              <button
                type="button"
                className="lt-secondary-button lt-wt-error-settings-btn"
                onClick={onOpenSettings}
              >
                {t("transport.worshiptools.checkCredentials", { defaultValue: "Check Credentials" })}
              </button>
            </div>
          </div>
        ) : null}

        {selectedService ? (
          <div className="lt-wt-service-card">
            <div className="lt-wt-service-card-header">
              <span className="lt-wt-service-card-title">{selectedService.name}</span>
              <span className="lt-wt-service-card-badge">
                {selectedService.cuesCount} {t("transport.worshiptools.cues", { defaultValue: "cues" })}
              </span>
            </div>
            <div className="lt-wt-service-card-date">{selectedService.displayDate}</div>
            {selectedService.rehearsals && selectedService.rehearsals.length > 0 ? (
              <div className="lt-wt-service-card-rehearsal">
                <span className="material-symbols-outlined">schedule</span>
                <span>Repeat: {selectedService.rehearsals.join(", ")}</span>
              </div>
            ) : null}

            {/* Sub-tab pills */}
            <div className="lt-wt-tab-pills" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "setlist"}
                className={`lt-wt-tab-pill ${activeTab === "setlist" ? "is-active" : ""}`}
                onClick={() => setActiveTab("setlist")}
              >
                <span className="material-symbols-outlined">queue_music</span>
                {t("transport.worshiptools.setlistTab", { defaultValue: "Setlist" })} ({songs.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "roster"}
                className={`lt-wt-tab-pill ${activeTab === "roster" ? "is-active" : ""}`}
                onClick={() => setActiveTab("roster")}
              >
                <span className="material-symbols-outlined">groups</span>
                {t("transport.worshiptools.rosterTab", { defaultValue: "Roster" })} (
                {roster?.roster?.length ?? 0})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "rehearse"}
                className={`lt-wt-tab-pill ${activeTab === "rehearse" ? "is-active" : ""}`}
                onClick={() => setActiveTab("rehearse")}
              >
                <span className="material-symbols-outlined">flag</span>
                {t("transport.worshiptools.rehearseTab", { defaultValue: "Markers" })}
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div className="lt-library-panel-body lt-wt-panel-body" tabIndex={0}>
        {isLoadingServices ? (
          <div className="lt-wt-loading-state" style={{ padding: "2rem 1rem", textAlign: "center" }}>
            <span className="material-symbols-outlined is-spinning" style={{ fontSize: "24px", color: "rgb(87 241 219)" }}>
              progress_activity
            </span>
            <p style={{ marginTop: "0.5rem", fontSize: "0.8rem", opacity: 0.8 }}>
              {t("transport.worshiptools.loadingServices", { defaultValue: "Loading services…" })}
            </p>
          </div>
        ) : error && services.length === 0 ? (
          <div className="lt-library-panel-empty lt-wt-empty-state">
            <span className="material-symbols-outlined lt-wt-empty-icon" style={{ color: "rgb(255 120 120)" }}>
              error
            </span>
            <p>{error}</p>
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void loadServices(true)}
              style={{ marginTop: "0.6rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            >
              <span className="material-symbols-outlined">refresh</span>
              {t("transport.worshiptools.retry", { defaultValue: "Retry" })}
            </button>
          </div>
        ) : activeTab === "rehearse" ? (
          /* ── Rehearse Tab ── */
          <div className="lt-wt-rehearse-container">
            <div className="lt-wt-rehearse-status-bar">
              <div className="lt-wt-status-indicator">
                <span
                  className={`lt-wt-status-dot ${rehearseStatus.hasToken ? "is-online" : "is-offline"}`}
                />
                <span className="lt-wt-status-text">
                  {rehearseStatus.hasToken
                    ? t("transport.worshiptools.rehearseConnected", {
                        defaultValue: "Rehearse Connected",
                      })
                    : t("transport.worshiptools.rehearseDisconnected", {
                        defaultValue: "No Token (Open SongSelect)",
                      })}
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="lt-secondary-button lt-wt-rehearse-open-btn"
                  onClick={() => void handleOpenRehearse("https://songselect.ccli.com")}
                  title={t("transport.worshiptools.openSongSelectHint", {
                    defaultValue: "Opens CCLI SongSelect to capture CCLI token and preview songs",
                  })}
                >
                  <span className="material-symbols-outlined">queue_music</span>
                  {t("transport.worshiptools.openSongSelect", { defaultValue: "SongSelect (CCLI)" })}
                </button>
                <button
                  type="button"
                  className="lt-secondary-button lt-wt-rehearse-open-btn"
                  onClick={() => void handleOpenRehearse("https://planning.worshiptools.com")}
                  title={t("transport.worshiptools.openPlanningHint", {
                    defaultValue: "Opens WorshipTools Planning to automatically capture token",
                  })}
                >
                  <span className="material-symbols-outlined">open_in_new</span>
                  {t("transport.worshiptools.openPlanning", { defaultValue: "Planning" })}
                </button>
              </div>
            </div>

            {/* Token details and manual paste toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.25rem 0.2rem 0.45rem",
                fontSize: "0.75rem",
                opacity: 0.9,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span
                  style={{
                    color: rehearseStatus.hasToken ? "#34d399" : "#94a3b8",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                    {rehearseStatus.hasToken ? "check_circle" : "key_off"}
                  </span>
                  {rehearseStatus.hasToken ? "Token saved & active" : "Auto-capture or paste token"}
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="lt-button-link"
                  style={{
                    fontSize: "0.75rem",
                    cursor: "pointer",
                    background: "none",
                    border: "none",
                    color: "#38bdf8",
                    padding: 0,
                    textDecoration: "underline",
                  }}
                  onClick={() => setShowTokenInput((prev) => !prev)}
                >
                  {showTokenInput
                    ? "Cancel"
                    : rehearseStatus.hasToken
                    ? "Change Token"
                    : "Paste Token Manually"}
                </button>
                {rehearseStatus.hasToken && (
                  <button
                    type="button"
                    className="lt-button-link"
                    style={{
                      fontSize: "0.75rem",
                      cursor: "pointer",
                      background: "none",
                      border: "none",
                      color: "#f87171",
                      padding: 0,
                      textDecoration: "underline",
                    }}
                    onClick={() => void handleClearToken()}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {showTokenInput && (
              <div
                style={{
                  display: "flex",
                  gap: "0.35rem",
                  background: "rgba(255, 255, 255, 0.04)",
                  padding: "0.4rem",
                  borderRadius: "4px",
                  marginBottom: "0.5rem",
                }}
              >
                <input
                  type="password"
                  className="lt-wt-server-input"
                  style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem", flex: 1 }}
                  placeholder="Paste CCLI / Rehearse Bearer token…"
                  value={manualTokenInput}
                  onChange={(e) => setManualTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSaveManualToken();
                    }
                  }}
                />
                <button
                  type="button"
                  className="lt-secondary-button"
                  style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text && text.trim()) setManualTokenInput(text.trim());
                    } catch {}
                  }}
                  title="Paste from clipboard"
                >
                  Paste
                </button>
                <button
                  type="button"
                  className="lt-button lt-button--primary"
                  style={{ fontSize: "0.75rem", padding: "0.3rem 0.7rem" }}
                  disabled={isSavingToken || !manualTokenInput.trim()}
                  onClick={() => void handleSaveManualToken()}
                >
                  {isSavingToken ? "Saving…" : "Save"}
                </button>
              </div>
            )}

            {rehearseFeedback && (
              <div className="lt-wt-feedback" role="status">
                {rehearseFeedback}
              </div>
            )}

            <div className="lt-wt-rehearse-input-group">
              <label className="lt-wt-rehearse-label">
                {t("transport.worshiptools.trackIdOrUrl", {
                  defaultValue: "Song Title, Track ID, or CCLI #",
                })}
              </label>
              <div className="lt-inline-actions">
                <input
                  type="text"
                  className="lt-wt-server-input"
                  placeholder="e.g. What A God, 7236901-21697-29807, or URL"
                  value={rehearseTrackInput}
                  onChange={(e) => setRehearseTrackInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleFetchRehearse();
                    }
                  }}
                />
                <button
                  type="button"
                  className="lt-button lt-button--primary"
                  disabled={isFetchingRehearse || !rehearseTrackInput.trim()}
                  onClick={() => void handleFetchRehearse()}
                >
                  {isFetchingRehearse ? (
                    <span className="material-symbols-outlined is-spinning">progress_activity</span>
                  ) : (
                    <span className="material-symbols-outlined">download</span>
                  )}
                  {t("transport.worshiptools.fetchMarkers", { defaultValue: "Fetch Markers" })}
                </button>
              </div>
            </div>

            {/* Quick picker from current setlist if available */}
            {songs && songs.length > 0 && (
              <div className="lt-wt-rehearse-quick-select" style={{ fontSize: "0.75rem" }}>
                <span style={{ opacity: 0.7, marginRight: "0.4rem" }}>
                  {t("transport.worshiptools.quickSelectSong", { defaultValue: "Or pick from setlist:" })}
                </span>
                <select
                  className="lt-wt-service-dropdown"
                  style={{ display: "inline-block", width: "auto", padding: "0.2rem 0.4rem" }}
                  onChange={(e) => {
                    if (e.target.value) {
                      setRehearseTrackInput(e.target.value);
                    }
                  }}
                  defaultValue=""
                >
                  <option value="" disabled>
                    {t("transport.worshiptools.chooseSong", { defaultValue: "Choose song…" })}
                  </option>
                  {songs.filter(isMusicalSong).map((s, idx) => (
                    <option key={`${s.title}-${idx}`} value={s.title}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {rehearseError && (
              <div className="lt-wt-status-banner is-error" style={{ margin: "0.4rem 0" }}>
                <span className="material-symbols-outlined">error</span>
                <span>{rehearseError}</span>
              </div>
            )}

            {rehearseSong && (
              <div className="lt-wt-rehearse-result">
                <div className="lt-wt-rehearse-song-header">
                  <h4 className="lt-wt-rehearse-song-title">{rehearseSong.title}</h4>
                  <div className="lt-wt-song-badges">
                    <span className="lt-wt-badge is-meter">{rehearseSong.timeSignature}</span>
                    {rehearseSong.bpm ? (
                      <span className="lt-wt-badge is-bpm">{rehearseSong.bpm} BPM</span>
                    ) : null}
                    <span className="lt-wt-badge">{rehearseSong.markers.length} markers</span>
                  </div>
                </div>

                <div className="lt-inline-actions" style={{ alignItems: "center", gap: "0.4rem" }}>
                  <label style={{ fontSize: "0.75rem", opacity: 0.8 }}>
                    {t("transport.worshiptools.markerOffset", { defaultValue: "Timeline Offset (s):" })}
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    className="lt-wt-server-input"
                    style={{ width: "5rem" }}
                    value={markerOffsetSeconds}
                    onChange={(e) => setMarkerOffsetSeconds(parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className="lt-wt-rehearse-actions">
                  <button
                    type="button"
                    className="lt-button lt-button--primary"
                    disabled={isApplyingMarkers || rehearseSong.markers.length === 0}
                    onClick={() => void handleApplyMarkers()}
                  >
                    <span className="material-symbols-outlined">add_location_alt</span>
                    {isApplyingMarkers
                      ? t("transport.worshiptools.applying", { defaultValue: "Applying…" })
                      : t("transport.worshiptools.applyToTimeline", {
                          defaultValue: "Apply to Timeline",
                        })}
                  </button>
                  <button
                    type="button"
                    className="lt-secondary-button"
                    onClick={handleExportCsv}
                    title={t("transport.worshiptools.exportCsvHint", {
                      defaultValue: "Download marker list as CSV",
                    })}
                  >
                    <span className="material-symbols-outlined">file_download</span>
                    {t("transport.worshiptools.exportCsv", { defaultValue: "Export CSV" })}
                  </button>
                  <button
                    type="button"
                    className="lt-secondary-button"
                    onClick={() => void handleCopyCsv()}
                    title={t("transport.worshiptools.copyCsvHint", {
                      defaultValue: "Copy CSV content to clipboard",
                    })}
                  >
                    <span className="material-symbols-outlined">content_copy</span>
                    {t("transport.worshiptools.copyCsv", { defaultValue: "Copy CSV" })}
                  </button>
                </div>

                <div className="lt-wt-rehearse-marker-list-wrap">
                  <table className="lt-wt-rehearse-marker-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Section</th>
                        <th>Start</th>
                        <th>Measure</th>
                        <th>Bars</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rehearseSong.markers.map((m, idx) => (
                        <tr key={`${m.name}-${idx}`}>
                          <td>M{idx + 1}</td>
                          <td>
                            <span className="lt-wt-marker-pill">{m.name}</span>
                          </td>
                          <td>{m.startSeconds.toFixed(2)}s</td>
                          <td>{m.startMeasure}</td>
                          <td>{m.durationMeasures}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : !selectedService ? (
          <div className="lt-library-panel-empty lt-wt-empty-state">
            <span className="material-symbols-outlined lt-wt-empty-icon">event_available</span>
            <p>
              {t("transport.worshiptools.selectPrompt", {
                defaultValue: "Select a service from the dropdown above to view setlist and team.",
              })}
            </p>
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => setActiveTab("rehearse")}
              style={{ marginTop: "0.6rem" }}
            >
              <span className="material-symbols-outlined">flag</span>
              {t("transport.worshiptools.openRehearseMarkers", { defaultValue: "Open Rehearse Markers" })}
            </button>
          </div>
        ) : activeTab === "setlist" ? (
          /* ── Setlist Tab ── */
          <div className="lt-wt-setlist-container">
            {isLoadingSetlist ? (
              <div className="lt-wt-loading-state">
                <span className="material-symbols-outlined is-spinning">progress_activity</span>
                <span>{t("transport.worshiptools.loadingSetlist", { defaultValue: "Loading setlist…" })}</span>
              </div>
            ) : songs.length === 0 ? (
              <div className="lt-library-panel-empty">
                {t("transport.worshiptools.emptySetlist", {
                  defaultValue: "This service has no songs or cues yet.",
                })}
              </div>
            ) : (
              <>
                <div className="lt-wt-setlist-actions">
                  <button
                    type="button"
                    className="lt-secondary-button lt-wt-timeline-add-btn"
                    disabled={isAddingTimeline || musicalCount === 0}
                    onClick={() => void handleAddSongsToTimeline()}
                    title={t("transport.worshiptools.addToTimelineHint", {
                      defaultValue: "Add all songs from this service as regions on the timeline",
                    })}
                  >
                    <span className="material-symbols-outlined">add_to_photos</span>
                    {isAddingTimeline
                      ? t("transport.worshiptools.adding", { defaultValue: "Adding…" })
                      : t("transport.worshiptools.addToTimeline", {
                          count: musicalCount,
                          defaultValue: `Add ${musicalCount} Songs to Timeline`,
                        })}
                  </button>
                  <button
                    type="button"
                    className="lt-secondary-button lt-wt-stage-btn"
                    onClick={onOpenSettings}
                    title={t("transport.worshiptools.openStageBuilderHint", {
                      defaultValue: "Open Stage Session Builder with audio MIR analysis",
                    })}
                  >
                    <span className="material-symbols-outlined">auto_fix_high</span>
                    {t("transport.worshiptools.stageBuilder", { defaultValue: "Stage Builder…" })}
                  </button>
                </div>

                {timelineFeedback ? (
                  <div className="lt-wt-feedback" role="status">
                    {timelineFeedback}
                  </div>
                ) : null}

                {/* Cloud Drive setlist search bar */}
                <div className={`lt-wt-cloud-card ${cloudStatus?.connected ? "is-connected" : "is-disconnected"}`}>
                  <div className="lt-wt-cloud-card-info">
                    <div className="lt-wt-cloud-status-text">
                      <span className={`material-symbols-outlined lt-wt-cloud-icon ${cloudStatus?.connected ? "is-connected" : ""}`}>
                        {cloudStatus?.connected ? "cloud_done" : "cloud_off"}
                      </span>
                      <div>
                        <span className="lt-wt-cloud-title">
                          {t("transport.worshiptools.cloudStatusTitle", { defaultValue: "Cloud Drive (Google Drive)" })}
                        </span>
                        <span className="lt-wt-cloud-counter">
                          {!cloudStatus?.connected
                            ? t("transport.worshiptools.cloudConnectPrompt", {
                                defaultValue: "Verbind Cloud Drive om liederen te zoeken.",
                              })
                            : isLoadingCloudFiles
                              ? t("transport.worshiptools.cloudSearching", {
                                  defaultValue: "Zoeken in Cloud Drive…",
                                })
                              : t("transport.worshiptools.cloudFoundSummary", {
                                  found: cloudMatchResult.foundCount,
                                  total: cloudMatchResult.totalMusical,
                                  percent: cloudMatchResult.percentFound,
                                  defaultValue: `${cloudMatchResult.foundCount} van ${cloudMatchResult.totalMusical} liederen beschikbaar (${cloudMatchResult.percentFound}%)`,
                                })}
                        </span>
                      </div>
                    </div>
                    {!cloudStatus?.connected ? (
                      <button
                        type="button"
                        className="lt-secondary-button lt-wt-cloud-connect-btn"
                        disabled={isConnectingCloud}
                        onClick={() => void connectCloud()}
                      >
                        <span className="material-symbols-outlined">cloud</span>
                        {isConnectingCloud
                          ? t("common.connecting", { defaultValue: "Verbinden…" })
                          : t("transport.worshiptools.connectCloud", { defaultValue: "Verbinden" })}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`lt-secondary-button lt-wt-cloud-refresh-btn ${isLoadingCloudFiles ? "is-spinning" : ""}`}
                        disabled={isLoadingCloudFiles}
                        onClick={() => void refreshCloudFiles("songs")}
                        title={t("transport.worshiptools.refreshCloud", { defaultValue: "Zoek opnieuw in Cloud Drive" })}
                      >
                        <span className="material-symbols-outlined">refresh</span>
                        <span>{t("transport.worshiptools.searchCloudBtn", { defaultValue: "Zoek in Cloud" })}</span>
                      </button>
                    )}
                  </div>

                  {cloudStatus?.connected && cloudMatchResult.totalMusical > 0 && !isLoadingCloudFiles && (
                    <div className="lt-wt-cloud-filter-pills" role="radiogroup" aria-label="Cloud Filter">
                      <button
                        type="button"
                        className={`lt-wt-cloud-filter-pill ${cloudFilter === "all" ? "is-active" : ""}`}
                        onClick={() => setCloudFilter("all")}
                      >
                        {t("transport.worshiptools.filterAll", {
                          count: songs.length,
                          defaultValue: `Alle (${songs.length})`,
                        })}
                      </button>
                      <button
                        type="button"
                        className={`lt-wt-cloud-filter-pill is-matched ${cloudFilter === "found" ? "is-active" : ""}`}
                        onClick={() => setCloudFilter("found")}
                      >
                        <span className="material-symbols-outlined">check_circle</span>
                        {t("transport.worshiptools.filterFound", {
                          count: cloudMatchResult.foundCount,
                          defaultValue: `In Cloud (${cloudMatchResult.foundCount})`,
                        })}
                      </button>
                      <button
                        type="button"
                        className={`lt-wt-cloud-filter-pill is-missing ${cloudFilter === "missing" ? "is-active" : ""}`}
                        onClick={() => setCloudFilter("missing")}
                      >
                        <span className="material-symbols-outlined">cancel</span>
                        {t("transport.worshiptools.filterMissing", {
                          count: cloudMatchResult.missingCount,
                          defaultValue: `Ontbrekend (${cloudMatchResult.missingCount})`,
                        })}
                      </button>
                    </div>
                  )}
                </div>

                {filteredSongs.length === 0 ? (
                  <div className="lt-library-panel-empty" style={{ margin: "1rem 0" }}>
                    {t("transport.worshiptools.noFilteredSongs", {
                      defaultValue: "Geen liederen gevonden voor dit filter.",
                    })}
                  </div>
                ) : (
                  <ul className="lt-wt-sidebar-song-list">
                    {filteredSongs.map((song, index) => {
                      const rowKey = `${selectedService.id}:${song.cueId ?? song.songId ?? index}`;
                      const musical = isMusicalSong(song);
                      const refPath = references[rowKey];
                      const matchInfo = cloudMatchResult.matchedMap.get(rowKey);

                      return (
                        <li
                          key={rowKey}
                          className={`lt-wt-sidebar-song-item ${!musical ? "is-nonsong" : ""}`}
                        >
                          <div className="lt-wt-song-position">{song.position ?? index + 1}</div>
                          <div className="lt-wt-song-main">
                            <div className="lt-wt-song-header">
                              <span className="lt-wt-song-title-text" title={song.title}>
                                {song.title}
                              </span>
                              {!musical && (
                                <span className="lt-wt-nonsong-tag">
                                  {t("transport.worshiptools.notASong", { defaultValue: "cue" })}
                                </span>
                              )}
                            </div>
                            {musical ? (
                              <div className="lt-wt-song-badges">
                                {song.key && song.key !== "—" ? (
                                  <span className="lt-wt-badge is-key">{song.key}</span>
                                ) : null}
                                {song.bpm ? (
                                  <span className="lt-wt-badge is-bpm">{song.bpm} BPM</span>
                                ) : null}
                                {song.meter ? (
                                  <span className="lt-wt-badge is-meter">{song.meter}</span>
                                ) : null}
                              </div>
                            ) : null}

                            {musical && (
                              <div className="lt-wt-song-cloud-status">
                                {isLoadingCloudFiles ? (
                                  <span className="lt-wt-cloud-badge is-loading">
                                    <span className="material-symbols-outlined is-spinning">progress_activity</span>
                                    {t("transport.worshiptools.checkingCloud", { defaultValue: "Controleren…" })}
                                  </span>
                                ) : !cloudStatus?.connected ? (
                                  <span
                                    className="lt-wt-cloud-badge is-unknown"
                                    title={t("transport.worshiptools.cloudNotConnectedHint", {
                                      defaultValue: "Verbind Cloud Drive om beschikbaarheid te zien",
                                    })}
                                  >
                                    <span className="material-symbols-outlined">cloud_off</span>
                                    {t("transport.worshiptools.cloudNotChecked", { defaultValue: "Niet gecontroleerd" })}
                                  </span>
                                ) : matchInfo?.hasMatch ? (
                                  <>
                                    <span
                                      className="lt-wt-cloud-badge is-found"
                                      title={matchInfo.bestMatch?.name}
                                    >
                                      <span className="material-symbols-outlined">check_circle</span>
                                      {t("transport.worshiptools.inCloud", { defaultValue: "In Cloud" })}
                                      {matchInfo.allMatches.length > 1 && (
                                        <span className="lt-wt-cloud-versions-tag">
                                          {matchInfo.allMatches.length} {t("transport.worshiptools.versions", { defaultValue: "versies" })}
                                        </span>
                                      )}
                                    </span>
                                    {matchInfo.bestMatch && (
                                      <span className="lt-wt-cloud-file-name" title={matchInfo.bestMatch.name}>
                                        <span className="material-symbols-outlined">inventory_2</span>
                                        {matchInfo.bestMatch.name}
                                      </span>
                                    )}
                                    {matchInfo.bestMatch && (
                                      <button
                                        type="button"
                                        className="lt-wt-song-cloud-import-btn"
                                        disabled={importingSongKey !== null}
                                        onClick={() => void handleImportCloudSong(song, matchInfo.bestMatch!, rowKey)}
                                        title={t("transport.worshiptools.importCloudSongHint", {
                                          defaultValue: "Download song package from Cloud Drive and import to timeline",
                                        })}
                                      >
                                        {importingSongKey === rowKey ? (
                                          <span className="material-symbols-outlined is-spinning">progress_activity</span>
                                        ) : (
                                          <span className="material-symbols-outlined">download</span>
                                        )}
                                        <span>
                                          {importingSongKey === rowKey
                                            ? t("transport.worshiptools.importing", { defaultValue: "Importeren…" })
                                            : t("transport.worshiptools.importToTimeline", { defaultValue: "+ Timeline" })}
                                        </span>
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <span className="lt-wt-cloud-badge is-missing">
                                    <span className="material-symbols-outlined">cancel</span>
                                    {t("transport.worshiptools.notInCloud", { defaultValue: "Niet in Cloud" })}
                                  </span>
                                )}
                              </div>
                            )}

                            {musical && (
                              <div className="lt-wt-song-ref-row">
                                <button
                                  type="button"
                                  className="lt-wt-song-rehearse-btn"
                                  title={t("transport.worshiptools.generateMarkersFromRehearse", {
                                    defaultValue: "Generate markers from Rehearse",
                                  })}
                                  onClick={() => {
                                    setActiveTab("rehearse");
                                    setRehearseTrackInput(song.title);
                                    void handleFetchRehearse(song.title);
                                  }}
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>flag</span>
                                  <span>{t("transport.worshiptools.markers", { defaultValue: "Markers" })}</span>
                                </button>
                                {refPath ? (
                                  <>
                                    <span className="lt-wt-ref-name" title={refPath}>
                                      <span className="material-symbols-outlined">audiotrack</span>
                                      {fileNameOf(refPath)}
                                    </span>
                                    <button
                                      type="button"
                                      className="lt-wt-ref-clear"
                                      title={t("transport.worshiptools.clearAudio", {
                                        defaultValue: "Remove reference track",
                                      })}
                                      onClick={() => clearReference(rowKey)}
                                    >
                                      <span className="material-symbols-outlined">close</span>
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="lt-wt-ref-pick-btn"
                                    onClick={() => void handlePickReference(rowKey)}
                                  >
                                    <span className="material-symbols-outlined">music_note</span>
                                    {t("transport.worshiptools.pickAudio", {
                                      defaultValue: "+ Reference track",
                                    })}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : (
          /* ── Roster Tab ── */
          <div className="lt-wt-roster-container">
            {isLoadingRoster ? (
              <div className="lt-wt-loading-state">
                <span className="material-symbols-outlined is-spinning">progress_activity</span>
                <span>{t("transport.worshiptools.loadingRoster", { defaultValue: "Loading team roster…" })}</span>
              </div>
            ) : !roster || roster.teams.length === 0 ? (
              <div className="lt-library-panel-empty">
                {t("transport.worshiptools.emptyRoster", {
                  defaultValue: "No team assignments for this service.",
                })}
              </div>
            ) : (
              <div className="lt-wt-roster-content">
                <div className="lt-wt-roster-counts">
                  <span className="lt-wt-roster-chip is-accepted">
                    ✓ {roster.counts.accepted} {t("transport.worshiptools.accepted", { defaultValue: "Accepted" })}
                  </span>
                  {roster.counts.pending > 0 && (
                    <span className="lt-wt-roster-chip is-pending">
                      ⏳ {roster.counts.pending} {t("transport.worshiptools.pending", { defaultValue: "Pending" })}
                    </span>
                  )}
                  {roster.counts.declined > 0 && (
                    <span className="lt-wt-roster-chip is-declined">
                      ✕ {roster.counts.declined} {t("transport.worshiptools.declined", { defaultValue: "Declined" })}
                    </span>
                  )}
                </div>

                {roster.teams.map((team) => (
                  <div key={team.name} className="lt-wt-team-section">
                    <div className="lt-wt-team-header">
                      <span className="lt-wt-team-name">{team.name}</span>
                      <span className="lt-wt-team-count">{team.members.length}</span>
                    </div>
                    <ul className="lt-wt-member-list">
                      {team.members.map((m) => (
                        <li key={`${m.userId}-${m.role}`} className="lt-wt-member-item">
                          <div className="lt-wt-member-info">
                            <span className="lt-wt-member-name">{m.name}</span>
                            <span className="lt-wt-member-role">{m.role}</span>
                          </div>
                          <span className={`lt-wt-status-pill is-${m.status}`}>
                            {m.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
