// @vitest-environment jsdom

import { useStreetLevelStore } from "@openmapx/core";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// The inner viewer pulls in Photo Sphere Viewer and MapLibre; the gate's
// consent behaviour is independent of it, so stub it out.
vi.mock("./street-level-imagery/StreetLevelViewerInner", () => ({
  default: () => <div data-testid="viewer-inner" />,
}));

const providersMock = vi.fn();
vi.mock("@/integration-api/components/useStreetLevelProviders", () => ({
  useStreetLevelProviders: () => providersMock(),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));

import { StreetLevelViewer } from "./StreetLevelViewer";

const serverOnly = {
  id: "panoramax",
  name: "Panoramax",
  color: "#000",
  endUserExposure: "server-only" as const,
  coverage: {
    kind: "mvt" as const,
    tileUrlTemplate: "",
    minzoom: 0,
    maxzoom: 15,
    layers: { sequences: "s", pictures: "p" },
    props: { id: "id" },
  },
};
const direct = {
  ...serverOnly,
  id: "mapillary",
  name: "Mapillary",
  endUserExposure: "direct" as const,
};

function resetStore() {
  useStreetLevelStore.setState({ activeImage: null, pendingImage: null, acceptedProviders: [] });
}

beforeEach(resetStore);
afterEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("StreetLevelViewer consent gate", () => {
  it("auto-confirms a server-only provider without a dialog, opening the viewer", async () => {
    providersMock.mockReturnValue({ providers: [serverOnly], isLoading: false });

    render(<StreetLevelViewer />);
    // Simulate a pegman drop / deep link.
    useStreetLevelStore.getState().requestImageLoad({ providerId: "panoramax", imageId: "abc" });

    await waitFor(() => {
      expect(useStreetLevelStore.getState().activeImage).toEqual({
        providerId: "panoramax",
        imageId: "abc",
      });
    });
    expect(useStreetLevelStore.getState().pendingImage).toBeNull();
  });

  it("holds a direct provider at the pending stage for the dialog", async () => {
    providersMock.mockReturnValue({ providers: [direct], isLoading: false });

    render(<StreetLevelViewer />);
    useStreetLevelStore.getState().requestImageLoad({ providerId: "mapillary", imageId: "xyz" });

    // Give any effect a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(useStreetLevelStore.getState().activeImage).toBeNull();
    expect(useStreetLevelStore.getState().pendingImage).toEqual({
      providerId: "mapillary",
      imageId: "xyz",
    });
  });

  it("auto-confirms even when the request precedes the providers resolving", async () => {
    // A deep link fires requestImageLoad before the providers query settles.
    providersMock.mockReturnValue({ providers: [], isLoading: true });
    const { rerender } = render(<StreetLevelViewer />);
    useStreetLevelStore.getState().requestImageLoad({ providerId: "panoramax", imageId: "abc" });

    await new Promise((r) => setTimeout(r, 20));
    expect(useStreetLevelStore.getState().activeImage).toBeNull();

    // Providers resolve.
    providersMock.mockReturnValue({ providers: [serverOnly], isLoading: false });
    rerender(<StreetLevelViewer />);

    await waitFor(() => {
      expect(useStreetLevelStore.getState().activeImage).toEqual({
        providerId: "panoramax",
        imageId: "abc",
      });
    });
  });

  it("cancels a pending image for an unknown provider once providers are known", async () => {
    providersMock.mockReturnValue({ providers: [serverOnly], isLoading: false });
    render(<StreetLevelViewer />);
    useStreetLevelStore.getState().requestImageLoad({ providerId: "kartaview", imageId: "q" });

    await waitFor(() => {
      expect(useStreetLevelStore.getState().pendingImage).toBeNull();
    });
    expect(useStreetLevelStore.getState().activeImage).toBeNull();
  });
});
