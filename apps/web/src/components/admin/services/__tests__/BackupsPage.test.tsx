// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent } from "@/test";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";

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
      serviceCount: 1,
      volumeCount: 1,
      totalBytes: 1024,
    };
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("BackupsPage pagination", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () =>
      Response.json({ backups: makeBackups(60), warnings: [], root: "ops-agent-managed" }),
    );
  });

  it("shows the next slice when paging forward", async () => {
    const user = userEvent.setup();
    render(
      <AdminJobEffectsProvider>
        <BackupsPage />
      </AdminJobEffectsProvider>,
      { wrapper: createQueryWrapper() },
    );

    await screen.findByText("backup-059");
    expect(screen.getAllByText(/^backup-\d{3}$/)).toHaveLength(25);
    expect(screen.queryByText("backup-034")).toBeNull();
    await screen.findByText(/of 60/);
    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);

    // Page 2 = the next 25 newest (indices 34..10). backup-034 now visible,
    // backup-059 gone.
    await screen.findByText("backup-034");
    expect(screen.queryByText("backup-059")).toBeNull();
  });
});
