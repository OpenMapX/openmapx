import { create } from "zustand";

interface SavedPlacesState {
  activeTab: "lists" | "labeled";
  selectedListId: string | null;
  setActiveTab: (tab: "lists" | "labeled") => void;
  selectList: (listId: string) => void;
  clearSelectedList: () => void;
}

export const useSavedPlacesStore = create<SavedPlacesState>((set) => ({
  activeTab: "lists",
  selectedListId: null,
  setActiveTab: (activeTab) => set({ activeTab }),
  selectList: (selectedListId) => set({ selectedListId }),
  clearSelectedList: () => set({ selectedListId: null }),
}));
