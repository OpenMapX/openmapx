import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/EnvProvider", () => ({ useEnv: () => ({ apiUrl: "http://api.test" }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey[1] === "system"
      ? {
          data: {
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
                status: "update-available",
              },
            ],
          },
          isError: false,
        }
      : { data: undefined, isError: false },
}));

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
});
