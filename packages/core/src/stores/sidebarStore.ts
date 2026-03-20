import { create } from "zustand";
import { getPanel } from "../panels/registry";

interface SidebarState {
  activeSidebarId: string | null;
  activeDetailId: string | null;
  collapsed: boolean;
  openSidebar: (id: string) => void;
  closeSidebar: () => void;
  openDetail: (id: string) => void;
  closeDetail: () => void;
  closeAll: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  activeSidebarId: null,
  activeDetailId: null,
  collapsed: false,

  openSidebar: (id) => {
    const current = get().activeSidebarId;
    if (current && current !== id) {
      try {
        getPanel(current)?.onDeactivate?.();
      } catch (e) {
        console.error(`[sidebar] onDeactivate failed for panel "${current}":`, e);
      }
    }
    set({ activeSidebarId: id, collapsed: false });
  },

  closeSidebar: () => {
    const current = get().activeSidebarId;
    if (current) {
      try {
        getPanel(current)?.onDeactivate?.();
      } catch (e) {
        console.error(`[sidebar] onDeactivate failed for panel "${current}":`, e);
      }
    }
    set({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  },

  openDetail: (id) => set({ activeDetailId: id }),
  closeDetail: () => set({ activeDetailId: null }),

  closeAll: () => {
    const current = get().activeSidebarId;
    if (current) {
      try {
        getPanel(current)?.onDeactivate?.();
      } catch (e) {
        console.error(`[sidebar] onDeactivate failed for panel "${current}":`, e);
      }
    }
    set({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  },

  setCollapsed: (collapsed) => set({ collapsed }),
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
}));
