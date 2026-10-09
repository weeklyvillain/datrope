import type { SearchFilters, SearchResult } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** The search panel's results, kept outside the panel so they survive switching channels
 *  (the panel remounts with each channel view). */
export type SearchResults = {
  query: string;
  filters: SearchFilters;
  total?: number;
  items: SearchResult[];
  next?: string;
  opened?: string; // the last result opened
  scrollTop: number;
};

export const resultsStore = createStore<{ results: SearchResults | null }>(() => ({ results: null }));

export const useSearchResults = () => useStore(resultsStore, (s) => s.results);
export const setSearchResults = (r: SearchResults | null) => resultsStore.setState({ results: r });
export const updateSearchResults = (patch: Partial<SearchResults>) =>
  resultsStore.setState((s) => (s.results ? { results: { ...s.results, ...patch } } : s));
export const clearSearchResults = () => resultsStore.setState({ results: null });
