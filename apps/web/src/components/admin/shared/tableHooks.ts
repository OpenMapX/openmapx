"use client";

import { type ChangeEvent, useMemo, useState } from "react";

export interface ClientPagination<T> {
  page: number;
  rowsPerPage: number;
  /** The rows for the current page — render these instead of the full array. */
  paged: T[];
  /** Props to spread onto {@link AdminTablePagination}. */
  paginationProps: {
    count: number;
    page: number;
    rowsPerPage: number;
    onPageChange: (event: unknown, page: number) => void;
    onRowsPerPageChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  };
}

/**
 * Client-side pagination for an in-memory row array. Slices `rows` to the
 * current page and clamps the page into range when the row set shrinks (e.g.
 * after a search/filter narrows results), so you never land on an empty page.
 *
 * Pair with {@link AdminTablePagination}: render `paged`, spread `paginationProps`.
 */
export function useClientPagination<T>(rows: T[], initialRowsPerPage = 25): ClientPagination<T> {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(initialRowsPerPage);

  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);

  const paged = useMemo(
    () => rows.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage),
    [rows, safePage, rowsPerPage],
  );

  return {
    page: safePage,
    rowsPerPage,
    paged,
    paginationProps: {
      count: rows.length,
      page: safePage,
      rowsPerPage,
      onPageChange: (_event, p) => setPage(p),
      onRowsPerPageChange: (event) => {
        setRowsPerPage(Number(event.target.value));
        setPage(0);
      },
    },
  };
}

export interface ServerPagination {
  page: number;
  rowsPerPage: number;
  /** `page * rowsPerPage` — spread straight into the request as the offset. */
  offset: number;
  /** Reset to page 0 — call from filter/search/sort change handlers. */
  setPage: (page: number) => void;
  /**
   * Spread onto {@link AdminTablePagination}; add `count` (the server total)
   * and `hideSinglePage={false}` so the footer stays visible for server lists.
   */
  paginationProps: {
    page: number;
    rowsPerPage: number;
    onPageChange: (event: unknown, page: number) => void;
    onRowsPerPageChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  };
}

/**
 * State ergonomics for server-side paginated tables: owns `page`/`rowsPerPage`,
 * derives `offset` for the request, resets the page when the page size changes,
 * and exposes `setPage` so callers can reset to page 0 when a filter/search/sort
 * changes. The data fetch itself stays in the caller's query (each endpoint has
 * its own params); this only standardises the client state + the footer wiring.
 */
export function useServerPagination(initialRowsPerPage = 25): ServerPagination {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(initialRowsPerPage);
  return {
    page,
    rowsPerPage,
    offset: page * rowsPerPage,
    setPage,
    paginationProps: {
      page,
      rowsPerPage,
      onPageChange: (_event, p) => setPage(p),
      onRowsPerPageChange: (event) => {
        setRowsPerPage(Number(event.target.value));
        setPage(0);
      },
    },
  };
}

/**
 * Case-insensitive substring search over an in-memory row array. `getText`
 * returns the haystack for a row (concatenate the searchable columns). Returns
 * the live query, a setter, and the filtered rows (the full array when blank).
 */
export function useTextFilter<T>(
  rows: T[],
  getText: (row: T) => string,
): { query: string; setQuery: (q: string) => void; filtered: T[] } {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? rows.filter((row) => getText(row).toLowerCase().includes(q)) : rows),
    [rows, q, getText],
  );
  return { query, setQuery, filtered };
}
