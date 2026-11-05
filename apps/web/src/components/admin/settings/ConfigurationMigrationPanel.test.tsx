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

it("shows a valid server preview when browser metadata storage is blocked", async () => {
  mocks.inventory.mockResolvedValue({
    status: 200,
    data: { document: { prerequisites: [] }, fields: [] },
  });
  mocks.preview.mockResolvedValue({
    status: 200,
    data: {
      previewId: "00000000-0000-4000-8000-000000000001",
      fingerprint: "a".repeat(64),
      expectedCurrentRevisionId: null,
      changes: [],
      prerequisites: [],
      denials: [],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  });
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw Error("storage denied");
    }),
    remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw Error("storage denied");
    }),
    set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("quota exceeded");
    }),
    cache = createTestQueryClient();
  try {
    render(
      <QueryClientProvider client={cache}>
        <ConfigurationMigrationPanel />
      </QueryClientProvider>,
    );
    const input = screen.getByText("Review configuration file").querySelector("input")!;
    fireEvent.change(input, {
      target: {
        files: [
          {
            size: 100,
            text: async () =>
              JSON.stringify({
                format: "openmapx-configuration",
                version: 1,
                exportedAt: new Date().toISOString(),
                settings: {},
                integrations: [],
                serviceConfigs: [],
                bindings: [],
                installations: [],
                prerequisites: [],
              }),
          },
        ],
      },
    });
    expect(await screen.findByText(/0 selected changes/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed configuration" })).not.toBeDisabled();
  } finally {
    get.mockRestore();
    remove.mockRestore();
    set.mockRestore();
    cache.clear();
  }
});
