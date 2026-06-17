// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { BackupsPage } from "../BackupsPage";

/** Build N backups, oldest first, so we can verify sort-then-slice ordering. */
function makeBackups(count: number) {
  return Array.from({ length: count }, (_, i) => {
    // Monotonic ISO timestamps that sort lexicographically by index: index i
    // maps to minute i, so the highest index is the newest backup. createdAt
    // sort is descending (newest first) in the component.
    const minutes = String(i).padStart(2, "0");
    return {
      name: `backup-${String(i).padStart(3, "0")}`,
      createdAt: `2026-01-01T00:${minutes}:00.000Z`,
      openmapxVersion: "1.0.0",
      services: 1,
      volumes: 1,
      totalBytes: 1024,
    };
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("BackupsPage pagination", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ backups: makeBackups(60), warnings: [], root: "/data" }),
    });
  });

  it("renders at most rowsPerPage rows for an oversized dataset", async () => {
    render(<BackupsPage />, { wrapper: createQueryWrapper() });

    // Wait for the rows to appear, then count the data rows in the table body.
    await screen.findByText("backup-059");
    const rows = screen.getAllByText(/^backup-\d{3}$/);
    expect(rows.length).toBe(25); // default rowsPerPage
  });

  it("sorts newest-first then slices (page 1 shows the newest 25)", async () => {
    render(<BackupsPage />, { wrapper: createQueryWrapper() });

    // Newest is backup-059 (highest createdAt); it must be on page 1.
    await screen.findByText("backup-059");
    // The 35th-oldest (backup-034) is on page 2, so it must NOT be visible yet.
    expect(screen.queryByText("backup-034")).toBeNull();
  });

  it("shows the next slice when paging forward", async () => {
    const user = userEvent.setup();
    render(<BackupsPage />, { wrapper: createQueryWrapper() });

    await screen.findByText("backup-059");
    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);

    // Page 2 = the next 25 newest (indices 34..10). backup-034 now visible,
    // backup-059 gone.
    await screen.findByText("backup-034");
    expect(screen.queryByText("backup-059")).toBeNull();
  });

  it("reports the full count in the pager, not the page size", async () => {
    render(<BackupsPage />, { wrapper: createQueryWrapper() });
    await screen.findByText("backup-059");
    // The pager shows the full filtered count (60), not the 25 rendered rows.
    await screen.findByText(/of 60/);
  });
});
