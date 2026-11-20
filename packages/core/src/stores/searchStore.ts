import { create } from "zustand";

interface SearchState {
  query: string;
  isOpen: boolean;
  isFocused: boolean;
  setQuery: (query: string) => void;
  setIsOpen: (isOpen: boolean) => void;
  setIsFocused: (isFocused: boolean) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  isOpen: false,
  isFocused: false,
  setQuery: (query) => set({ query }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setIsFocused: (isFocused) => set({ isFocused }),
  reset: () => set({ query: "", isOpen: false, isFocused: false }),
}));
