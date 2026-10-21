import { useEffect, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";

import { pickLibraryFiles } from "@libretracks/shared/desktopApi";
import { createEmptySong, updateSongRegionKey } from "@libretracks/shared/desktopApi";

import {
  applyRehearseMarkersToTimeline,
  downloadCsvFile,
  fetchRehearseSong,
  getRehearseStatus,
  listenRehearseToken,
  listenRehearseTrack,
  openRehearseWindow,
  type RehearseSongResult,
  type RehearseStatus,
} from "../../worshiptools/rehearseApi";
import { useWorshipToolsStore } from "../../worshiptools/worshipToolsStore";
import { isMusicalSong } from "../../worshiptools/stageSession";
import type { WTSong } from "../../worshiptools/wtApi";
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

  useEffect(() => {
    if (!isOpen) return;
    void getRehearseStatus().then((status) => {
      setRehearseStatus(status);
      if (status.lastTrackId) {
        setRehearseTrackInput((prev) => prev || status.lastTrackId || "");
      }
    });

    let unlistenToken: (() => void) | undefined;
    let unlistenTrack: (() => void) | undefined;

    void listenRehearseToken(() => {
      setRehearseStatus((prev) => ({ ...prev, hasToken: true }));
      setRehearseFeedback(
        t("transport.worshiptools.tokenCapturedFeedback", {
          defaultValue: "Live Rehearse token captured!",
        }),
      );
      setTimeout(() => setRehearseFeedback(null), 4000);
    }).then((unlisten) => {
      unlistenToken = unlisten;
    });

    void listenRehearseTrack((trackId) => {
      setRehearseStatus((prev) => ({ ...prev, lastTrackId: trackId }));
      setRehearseTrackInput(trackId);
    }).then((unlisten) => {
      unlistenTrack = unlisten;
    });

    return () => {
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

  // Load services when first opened if empty
  useEffect(() => {
    if (isOpen && services.length === 0 && !isLoadingServices) {
      void loadServices(false);
    }
  }, [isOpen, services.length, isLoadingServices, loadServices]);

  if (!isOpen) return null;

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
                        defaultValue: "No Token (Open Rehearse)",
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
                <button
                  type="button"
                  className="lt-secondary-button lt-wt-rehearse-open-btn"
                  style={{ opacity: 0.8 }}
                  onClick={() => void handleOpenRehearse("https://rehearse.ccli.com")}
                  title={t("transport.worshiptools.openRehearseDirectHint", {
                    defaultValue: "Opens CCLI Rehearse directly (may show maintenance page if CCLI is down)",
                  })}
                >
                  {t("transport.worshiptools.openRehearseDirect", { defaultValue: "CCLI Rehearse" })}
                </button>
              </div>
            </div>

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

                <ul className="lt-wt-sidebar-song-list">
                  {songs.map((song, index) => {
                    const rowKey = `${selectedService.id}:${song.cueId ?? song.songId ?? index}`;
                    const musical = isMusicalSong(song);
                    const refPath = references[rowKey];

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
