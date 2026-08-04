import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";
import en from "../../../../../../packages/i18n/locales/en.json";

const mocks = (
  vi as unknown as {
    hoisted<T>(factory: () => T): T;
  }
).hoisted(() => {
  const api = {
    capability: vi.fn(),
    prepare: vi.fn(),
    getJob: vi.fn(),
    getManifest: vi.fn(),
    openArchive: vi.fn(),
  };
  const storage = {
    list: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    openPartial: vi.fn(),
    finalize: vi.fn(),
    openReady: vi.fn(),
    estimate: vi.fn(),
  };
  return {
    api,
    storage,
    downloadOfflinePackage: vi.fn(),
    requestPersistentStorage: vi.fn(),
  };
});

vi.mock("@openmapx/core", () => ({
  createPlace: vi.fn(),
  geoJsonBBox: vi.fn(),
  idsFromPrimaryOrCoords: vi.fn(),
  useAutocomplete: () => ({ data: [], isFetching: false }),
  useDebounce: (value: string) => value,
  usePlaceDetails: () => ({ data: undefined }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({
    apiUrl: "https://api.example",
    styleProvider: "openmapx",
  }),
}));

vi.mock("@/lib/map", () => ({ loadOpenMapXStyle: vi.fn() }));
vi.mock("@/lib/haptics", () => ({ haptics: { success: vi.fn() } }));
vi.mock("@/lib/persistentStorage", () => ({
  requestPersistentStorage: mocks.requestPersistentStorage,
}));
vi.mock("@/lib/recentMapDataCache", () => ({
  isRecentMapDataCacheEnabled: () => true,
  setRecentMapDataCacheEnabled: vi.fn(),
}));
vi.mock("@/lib/useNetworkStatus", () => ({
  useNetworkStatus: () => ({ online: true, metered: false }),
}));
vi.mock("@/lib/offlineAreas", () => ({
  configureDefaultOfflinePackageResolver: vi.fn(),
  createOfflinePackageApi: () => mocks.api,
  createOfflinePackageStorage: () => mocks.storage,
  deleteOfflineGlyphCacheIfUnused: vi.fn(),
  downloadOfflinePackage: mocks.downloadOfflinePackage,
  getDefaultOfflinePackageResolver: () => null,
  notifyOfflinePackageChanged: vi.fn(),
  validateOfflineStyleAssets: vi.fn(),
}));

vi.mock("./AreaPickerMap", () => ({
  AreaPickerMap: ({
    onChange,
  }: {
    onChange: (bbox: { west: number; south: number; east: number; north: number }) => void;
  }) => (
    <button type="button" onClick={() => onChange({ west: 13, south: 52, east: 14, north: 53 })}>
      Choose fixture area
    </button>
  ),
}));
vi.mock("./OfflineMapView", () => ({ OfflineMapView: () => null }));

import { OfflineSettingsClient } from "./OfflineSettingsClient";

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OfflineSettingsClient />
    </NextIntlClientProvider>,
  );
}

describe("OfflineSettingsClient download dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storage.list.mockResolvedValue([]);
    mocks.api.capability.mockResolvedValue({
      available: true,
      provider: "openmapx",
      sourceMaxZoom: 14,
    });
    mocks.requestPersistentStorage.mockResolvedValue(true);
    mocks.api.prepare.mockImplementation(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[1] as AbortSignal | undefined;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
  });

  it("replaces mutable selection controls with the submitted download summary", async () => {
    const user = userEvent.setup();
    renderSettings();

    const open = await screen.findByRole("button", { name: "Download a new area" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "Choose fixture area" }));

    expect(screen.getAllByRole("slider")).toHaveLength(2);
    expect(screen.getByLabelText("Search for a place")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Start download" }));
    await waitFor(() => expect(mocks.api.prepare).toHaveBeenCalledTimes(1));

    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    expect(screen.queryByLabelText("Search for a place")).toBeNull();
    expect(screen.getByText("Preparing the offline package…")).not.toBeNull();
    expect(screen.getByText(/z10–14/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).not.toBeNull();
  });

  it("refreshes resumable packages after pausing and closing the transfer view", async () => {
    const user = userEvent.setup();
    mocks.api.prepare.mockResolvedValue({
      jobId: "job",
      packageId: "fixture",
      status: "ready-to-download",
      manifest: {
        packageId: "fixture",
        archive: { byteLength: 1024 },
      },
    });
    mocks.downloadOfflinePackage.mockImplementation(
      (...args: unknown[]) =>
        new Promise((resolve) => {
          const options = args[3] as { signal: AbortSignal };
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                id: "fixture",
                status: "paused",
                bytesReceived: 256,
                bytesTotal: 1024,
              }),
            { once: true },
          );
        }),
    );
    renderSettings();

    const open = await screen.findByRole("button", { name: "Download a new area" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "Choose fixture area" }));
    await user.click(screen.getByRole("button", { name: "Start download" }));
    await screen.findByRole("button", { name: "Pause" });

    await user.click(screen.getByRole("button", { name: "Pause" }));
    const close = await screen.findByRole("button", { name: "Close" });
    expect(screen.getByText("Paused")).not.toBeNull();
    expect(screen.queryByText("Error")).toBeNull();
    expect(mocks.storage.list).toHaveBeenCalledTimes(1);

    await user.click(close);

    await waitFor(() => expect(mocks.storage.list).toHaveBeenCalledTimes(2));
  });

  it("keeps the immutable transfer view and reports a failed preparation", async () => {
    const user = userEvent.setup();
    mocks.api.prepare.mockRejectedValue(new Error("Preparation exploded"));
    renderSettings();

    const open = await screen.findByRole("button", { name: "Download a new area" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "Choose fixture area" }));
    await user.click(screen.getByRole("button", { name: "Start download" }));

    await screen.findByRole("button", { name: "Close" });
    expect(screen.getByText("Preparation exploded")).not.toBeNull();
    expect(screen.getByText("Error")).not.toBeNull();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("shows live byte progress when a paused package is resumed", async () => {
    const user = userEvent.setup();
    mocks.storage.list.mockResolvedValue([
      {
        id: "fixture",
        name: "Fixture",
        manifest: {
          packageId: "fixture",
          archive: { byteLength: 1024 },
          coverage: { minZoom: 10, maxZoom: 14 },
        },
        status: "paused",
        bytesReceived: 256,
        bytesTotal: 1024,
        verifiedPrefixBytes: 256,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    mocks.downloadOfflinePackage.mockImplementation((...args: unknown[]) => {
      const options = args[3] as {
        onProgress?: (progress: {
          packageId: string;
          status: "downloading";
          bytesReceived: number;
          bytesTotal: number;
          speedBytesPerSecond: number;
        }) => void;
      };
      options.onProgress?.({
        packageId: "fixture",
        status: "downloading",
        bytesReceived: 512,
        bytesTotal: 1024,
        speedBytesPerSecond: 256,
      });
      return new Promise(() => {});
    });
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Resume" }));

    expect(await screen.findByText("50%")).not.toBeNull();
    expect(screen.getByText("512 B / 1.0 KB")).not.toBeNull();
    expect(screen.getByText("256 B/s")).not.toBeNull();
  });
});
