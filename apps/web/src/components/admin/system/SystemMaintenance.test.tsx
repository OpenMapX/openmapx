import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const systemStatus = {
  deployment: {
    dockerAvailable: true,
    composeRendered: true,
    hostControlConfigured: true,
    maintenanceReady: true,
  },
  images: [
    {
      id: "app-api",
      name: "OpenMapX API",
      image: "ghcr.io/openmapx/api:latest",
      containerState: "running",
      runningImageId: "sha256:old-image",
      localImageId: "sha256:new-image",
      updateAvailable: true,
      status: "update-available" as "update-available" | "up-to-date",
    },
  ],
};

vi.mock("@/lib/EnvProvider", () => ({ useEnv: () => ({ apiUrl: "http://api.test" }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey[1] === "system"
      ? {
          data: systemStatus,
          isError: false,
        }
      : { data: undefined, isError: false },
}));

afterEach(() => {
  systemStatus.images[0].runningImageId = "sha256:old-image";
  systemStatus.images[0].localImageId = "sha256:new-image";
  systemStatus.images[0].updateAvailable = true;
  systemStatus.images[0].status = "update-available";
});

describe("SystemMaintenance", () => {
  it("renders staged image state and safe operator actions", async () => {
    const { SystemMaintenance } = await import("./SystemMaintenance");
    const markup = renderToStaticMarkup(<SystemMaintenance />);
    expect(markup).toContain("System maintenance");
    expect(markup).toContain("Check for updates");
    expect(markup).toContain("Update OpenMapX");
    expect(markup).toContain("Update ready");
    expect(markup).toContain("Deep diagnostics");
    expect(markup).toContain("Host-control readiness");
  });

  it("does not send a JSON content type for bodyless maintenance actions", async () => {
    const { buildSystemJobRequestInit } = await import("./SystemMaintenance");

    expect(buildSystemJobRequestInit()).toEqual({
      method: "POST",
      credentials: "include",
    });
    expect(buildSystemJobRequestInit({ confirmation: "UPDATE OPENMAPX" })).toEqual({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "UPDATE OPENMAPX" }),
    });
  });

  it("disables application updates when every core image is current", async () => {
    systemStatus.images[0].runningImageId = "sha256:current-image";
    systemStatus.images[0].localImageId = "sha256:current-image";
    systemStatus.images[0].updateAvailable = false;
    systemStatus.images[0].status = "up-to-date";

    const { SystemMaintenance } = await import("./SystemMaintenance");
    const markup = renderToStaticMarkup(<SystemMaintenance />);

    expect(
      /<button[^>]*disabled=""[^>]*title="All core images are up to date"[^>]*>[\s\S]*?Update OpenMapX/.test(
        markup,
      ),
    ).toBe(true);
  });
});
