import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useServices", () => ({
  useServiceDetail: (serviceId: string) => ({
    data: {
      manifest: {
        id: serviceId,
        name: serviceId === "dawarich-app" ? "Dawarich" : "Redis",
        version: "1.0.0",
        quality: "community-verified",
        container: { image: "example.invalid/image", tag: "1.0.0" },
      },
      directory: "/services/example",
      isBuiltIn: false,
      enabled: true,
      status: "not-running",
    },
    isLoading: false,
    isError: false,
  }),
  useServiceAction: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useServiceConfig: () => ({ data: undefined }),
  useServiceConfigSave: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("./ManagedDawarichSetup", () => ({
  ManagedDawarichSetup: () => <section>Managed Dawarich provisioning</section>,
}));
vi.mock("./ServiceCredentials", () => ({ ServiceCredentials: () => null }));
vi.mock("./ServiceLogsDrawer", () => ({ ServiceLogsDrawer: () => null }));

describe("ServiceDetail managed Dawarich setup", () => {
  it("shows the provisioning card only on the Dawarich app service", async () => {
    const { ServiceDetail } = await import("./ServiceDetail");

    expect(renderToStaticMarkup(<ServiceDetail id="dawarich-app" />)).toContain(
      "Managed Dawarich provisioning",
    );

    expect(renderToStaticMarkup(<ServiceDetail id="dawarich-redis" />)).not.toContain(
      "Managed Dawarich provisioning",
    );
  });
});
