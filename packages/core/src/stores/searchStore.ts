import { create } from "zustand";
import type { AutocompleteResult, SearchResult } from "../types/geocoding";

interface SearchState {
  query: string;
  isOpen: boolean;
  isFocused: boolean;
  suggestions: AutocompleteResult[];
  results: SearchResult[];
  setQuery: (query: string) => void;
  setIsOpen: (isOpen: boolean) => void;
  setIsFocused: (isFocused: boolean) => void;
  setSuggestions: (suggestions: AutocompleteResult[]) => void;
  setResults: (results: SearchResult[]) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  isOpen: false,
  isFocused: false,
  suggestions: [],
  results: [],
  setQuery: (query) => set({ query }),
  setIsOpen: (isOpen) => set({ isOpen }),
  setIsFocused: (isFocused) => set({ isFocused }),
  setSuggestions: (suggestions) => set({ suggestions }),
  setResults: (results) => set({ results }),
  reset: () => set({ query: "", isOpen: false, isFocused: false, suggestions: [], results: [] }),
}));
