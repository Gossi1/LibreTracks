import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import {
  directFetchRoster,
  directFetchServices,
  directFetchSetlist,
  fetchWtRoster,
  fetchWtServices,
  fetchWtSetlist,
  type WTRosterResult,
  type WTService,
  type WTServicesResult,
  type WTSetlistResult,
} from "./wtApi";

const STORAGE_SELECTED_SERVICE_KEY = "lt-wt-selected-service";

export type WorshipToolsState = {
  services: WTService[];
  upcoming: WTService[];
  past: WTService[];
  selectedServiceId: string | null;
  selectedService: WTService | null;
  setlist: WTSetlistResult | null;
  roster: WTRosterResult | null;
  isLoadingServices: boolean;
  isLoadingSetlist: boolean;
  isLoadingRoster: boolean;
  error: string | null;
  references: Record<string, string>;
  activeTab: "setlist" | "roster" | "rehearse";

  loadServices: (force?: boolean) => Promise<void>;
  selectService: (id: string | null, force?: boolean) => Promise<void>;
  setReference: (rowKey: string, filePath: string) => void;
  clearReference: (rowKey: string) => void;
  setActiveTab: (tab: "setlist" | "roster" | "rehearse") => void;
};

export const useWorshipToolsStore = create<WorshipToolsState>()(
  subscribeWithSelector((set, get) => ({
    services: [],
    upcoming: [],
    past: [],
    selectedServiceId: (() => {
      try {
        return window.localStorage.getItem(STORAGE_SELECTED_SERVICE_KEY) || null;
      } catch {
        return null;
      }
    })(),
    selectedService: null,
    setlist: null,
    roster: null,
    isLoadingServices: false,
    isLoadingSetlist: false,
    isLoadingRoster: false,
    error: null,
    references: {},
    activeTab: "setlist",

    loadServices: async (force = false) => {
      set({ isLoadingServices: true, error: null });
      try {
        let result: WTServicesResult;
        try {
          result = await fetchWtServices(force);
        } catch (err) {
          console.warn("fetchWtServices failed, trying direct Firestore connection:", err);
          result = await directFetchServices(force);
        }

        const all = [...result.upcoming, ...result.past];
        const state = get();
        let selectedId = state.selectedServiceId;

        // If previously selected id is not found or empty, pick the first upcoming service if available
        if (!selectedId || !all.some((s) => s.id === selectedId)) {
          selectedId = result.upcoming[0]?.id ?? all[0]?.id ?? null;
        }

        const selectedService = all.find((s) => s.id === selectedId) ?? null;

        set({
          services: all,
          upcoming: result.upcoming,
          past: result.past,
          selectedServiceId: selectedId,
          selectedService,
          isLoadingServices: false,
        });

        if (selectedId) {
          await get().selectService(selectedId, force);
        }
      } catch (err) {
        console.error("WorshipTools loadServices error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        set({ error: msg, isLoadingServices: false });
      }
    },

    selectService: async (id: string | null, force = false) => {
      if (!id) {
        set({
          selectedServiceId: null,
          selectedService: null,
          setlist: null,
          roster: null,
        });
        try {
          window.localStorage.removeItem(STORAGE_SELECTED_SERVICE_KEY);
        } catch {
          // ignore
        }
        return;
      }

      try {
        window.localStorage.setItem(STORAGE_SELECTED_SERVICE_KEY, id);
      } catch {
        // ignore
      }

      const service = get().services.find((s) => s.id === id) ?? null;
      set({
        selectedServiceId: id,
        selectedService: service,
        isLoadingSetlist: true,
        isLoadingRoster: true,
      });

      // Load setlist & roster in parallel
      const loadSetlistPromise = (async () => {
        try {
          return await fetchWtSetlist(id, force);
        } catch (err) {
          console.warn("fetchWtSetlist failed, trying directFetchSetlist:", err);
          return await directFetchSetlist(id, force);
        }
      })()
        .then((setlist) => {
          if (get().selectedServiceId === id) {
            set({ setlist, isLoadingSetlist: false });
          }
        })
        .catch((err) => {
          if (get().selectedServiceId === id) {
            set({
              isLoadingSetlist: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });

      const loadRosterPromise = (async () => {
        try {
          return await fetchWtRoster(id, force);
        } catch (err) {
          console.warn("fetchWtRoster failed, trying directFetchRoster:", err);
          return await directFetchRoster(id, force);
        }
      })()
        .then((roster) => {
          if (get().selectedServiceId === id) {
            set({ roster, isLoadingRoster: false });
          }
        })
        .catch((err) => {
          if (get().selectedServiceId === id) {
            set({
              isLoadingRoster: false,
            });
          }
        });

      await Promise.all([loadSetlistPromise, loadRosterPromise]);
    },

    setReference: (rowKey: string, filePath: string) => {
      set((state) => ({
        references: { ...state.references, [rowKey]: filePath },
      }));
    },

    clearReference: (rowKey: string) => {
      set((state) => {
        const next = { ...state.references };
        delete next[rowKey];
        return { references: next };
      });
    },

    setActiveTab: (tab: "setlist" | "roster" | "rehearse") => {
      set({ activeTab: tab });
    },
  })),
);
