import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen } from "@/test";
import { ConfigurationMigrationPanel } from "./ConfigurationMigrationPanel";

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/admin/accountAdmin", () => ({
  useAccountAdmin: () => ({ actorId: "synthetic-admin" }),
}));
vi.mock("../activity/activityQueries", () => ({
  useActivityClient: () => ({ apiUrl: "http://synthetic.test/api", client: {} }),
}));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  getAdminConfigurationMigrationInventory: mocks.inventory,
  previewAdminConfigurationMigration: mocks.preview,
  applyAdminConfigurationMigration: mocks.apply,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("checks file size before reading and never admits an oversized migration", async () => {
  mocks.inventory.mockResolvedValue({
    status: 200,
    data: { document: { prerequisites: [] }, fields: [] },
  });
  const cache = createTestQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <ConfigurationMigrationPanel />
    </QueryClientProvider>,
  );
  const input = screen.getByText("Review configuration file").querySelector("input");
  if (!input) throw Error("File input missing");
  const text = vi.fn(),
    file = { size: 1048577, text };
  fireEvent.change(input, { target: { files: [file] } });
  expect(await screen.findByText("Configuration file must be at most1MiB.")).toBeVisible();
  expect(text).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
  cache.clear();
});
