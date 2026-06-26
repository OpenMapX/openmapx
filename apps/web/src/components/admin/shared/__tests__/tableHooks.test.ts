// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useClientPagination, useServerPagination, useTextFilter } from "../tableHooks";

const rows = Array.from({ length: 57 }, (_, i) => i);

describe("useClientPagination", () => {
  it("slices to the current page and reports the full count", () => {
    const { result } = renderHook(() => useClientPagination(rows, 25));
    expect(result.current.paged.length).toBe(25);
    expect(result.current.paged[0]).toBe(0);
    expect(result.current.paginationProps.count).toBe(57);
  });

  it("changes page", () => {
    const { result } = renderHook(() => useClientPagination(rows, 25));
    act(() => result.current.paginationProps.onPageChange(null, 2));
    expect(result.current.page).toBe(2);
    expect(result.current.paged).toEqual([50, 51, 52, 53, 54, 55, 56]);
  });

  it("resets to page 0 when rows-per-page changes", () => {
    const { result } = renderHook(() => useClientPagination(rows, 25));
    act(() => result.current.paginationProps.onPageChange(null, 2));
    act(() =>
      result.current.paginationProps.onRowsPerPageChange({
        target: { value: "50" },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(result.current.page).toBe(0);
    expect(result.current.rowsPerPage).toBe(50);
    expect(result.current.paged.length).toBe(50);
  });

  it("clamps the page into range when the row set shrinks", () => {
    const { result, rerender } = renderHook(({ data }) => useClientPagination(data, 25), {
      initialProps: { data: rows },
    });
    act(() => result.current.paginationProps.onPageChange(null, 2));
    expect(result.current.page).toBe(2);
    // Filter down to 3 rows → only one page exists; page must clamp to 0.
    rerender({ data: rows.slice(0, 3) });
    expect(result.current.page).toBe(0);
    expect(result.current.paged).toEqual([0, 1, 2]);
  });
});

describe("useServerPagination", () => {
  it("derives offset from page and rowsPerPage", () => {
    const { result } = renderHook(() => useServerPagination(50));
    expect(result.current.offset).toBe(0);
    act(() => result.current.paginationProps.onPageChange(null, 3));
    expect(result.current.page).toBe(3);
    expect(result.current.offset).toBe(150);
  });

  it("resets to page 0 when rowsPerPage changes", () => {
    const { result } = renderHook(() => useServerPagination(25));
    act(() => result.current.paginationProps.onPageChange(null, 4));
    act(() =>
      result.current.paginationProps.onRowsPerPageChange({
        target: { value: "100" },
      } as React.ChangeEvent<HTMLInputElement>),
    );
    expect(result.current.page).toBe(0);
    expect(result.current.rowsPerPage).toBe(100);
  });

  it("exposes setPage for filter/search resets", () => {
    const { result } = renderHook(() => useServerPagination());
    act(() => result.current.paginationProps.onPageChange(null, 2));
    act(() => result.current.setPage(0));
    expect(result.current.page).toBe(0);
  });
});

describe("useTextFilter", () => {
  const items = [{ name: "Alpha" }, { name: "Beta" }, { name: "alphabet" }];

  it("returns all rows when the query is blank", () => {
    const { result } = renderHook(() => useTextFilter(items, (r) => r.name));
    expect(result.current.filtered.length).toBe(3);
  });

  it("filters case-insensitively by substring", () => {
    const { result } = renderHook(() => useTextFilter(items, (r) => r.name));
    act(() => result.current.setQuery("alpha"));
    expect(result.current.filtered.map((r) => r.name)).toEqual(["Alpha", "alphabet"]);
  });

  it("ignores surrounding whitespace", () => {
    const { result } = renderHook(() => useTextFilter(items, (r) => r.name));
    act(() => result.current.setQuery("  beta  "));
    expect(result.current.filtered).toEqual([{ name: "Beta" }]);
  });
});
