import { create } from "zustand";

export interface PersonalTimelineState {
  selectedDate: string | null;
  selectedEntryId: string | null;
  setSelectedDate: (date: string) => void;
  selectEntry: (id: string | null) => void;
  clearPanelSelection: () => void;
  resetForSession: () => void;
}

const EMPTY_SELECTION = {
  selectedDate: null,
  selectedEntryId: null,
} as const;

export const usePersonalTimelineStore = create<PersonalTimelineState>((set) => ({
  ...EMPTY_SELECTION,
  setSelectedDate: (selectedDate) => set({ selectedDate, selectedEntryId: null }),
  selectEntry: (selectedEntryId) => set({ selectedEntryId }),
  clearPanelSelection: () => set({ selectedEntryId: null }),
  resetForSession: () => set(EMPTY_SELECTION),
}));
