import { useDirectionsStore, useImportedGeometryStore, useNavigationStore } from "@openmapx/core";
import { MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import { act, fireEvent, render as renderInDom, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntakeTransferError } from "@/lib/mobile/nativeIntake";
import { createQueryWrapper, createTestQueryClient } from "@/test";
import { transitPlanQueryKey } from "../../../../../packages/core/src/api/transit";
import { providerPlanSelection } from "../../../../../packages/core/src/travel-plans/__fixtures__/providerPlan";
import { NativeIntakeHandler } from "./NativeIntakeHandler";

const f = vi.hoisted(() => ({
  list: vi.fn(),
  text: vi.fn(),
  complete: vi.fn(),
  mutating: false,
  pathname: "/",
  push: vi.fn(),
  protocolVersion: null as number | null,
  nativeIntake: true,
}));
const travel = vi.hoisted(() => ({ resolve: vi.fn() }));
let travelResult = providerPlanSelection();
let queryClient = createTestQueryClient();
function render(ui: Parameters<typeof renderInDom>[0]) {
  return renderInDom(ui, { wrapper: createQueryWrapper(queryClient) });
}
afterEach(() => queryClient.clear());
vi.mock("../../../../../packages/core/src/travel-plans/resolve", async (original) => ({
  ...(await original<object>()),
  resolveSharedTravelPlan: travel.resolve,
}));
const item = {
  id: "f386e706-b728-40a3-9554-881d0ff0958a",
  kind: "file",
  format: "geojson",
  name: "walk.geojson",
  byteLength: 50,
  createdAtMs: 1,
};
vi.mock("next/navigation", () => ({
  usePathname: () => f.pathname,
  useRouter: () => ({ push: f.push }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/mobile/nativeIntake", () => ({
  IntakeTransferError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  NativeIntakeClient: class {
    list = f.list;
    text = f.text;
    complete = f.complete;
  },
}));
const listeners = new Set<(message: never) => void>();
const client = {
  subscribe: (listener: (message: never) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
const commands = {
  get isMutating() {
    return f.mutating;
  },
};
vi.mock("@/lib/mobile/MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => ({
    state: "native-compatible",
    handshake: {
      selectedProtocolVersion: f.protocolVersion,
      capabilities: { nativeIntake: f.nativeIntake },
    },
    client,
    commands,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  const { close } = useDirectionsStore.getState();
  close();
  queryClient = createTestQueryClient();
  // The real app retains unobserved seeded plans until the panel mounts.
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 300_000 } });
  queryClient.setQueryData(["transit-planning-capabilities"], {
    providers: [
      {
        id: "transit-motis-local",
        metadata: {
          source: "transit-motis-local",
          instance: "ms",
          datasetEpoch: "E",
          rentalFormFactors: [],
        },
      },
    ],
  });
  travelResult = providerPlanSelection({
    bikeHillPreference: useDirectionsStore.getState().bikeHillPreference,
  });
  travel.resolve.mockReset().mockResolvedValue(travelResult);
  f.mutating = false;
  f.protocolVersion = MOBILE_PROTOCOL_MAX;
  f.nativeIntake = true;
  f.pathname = "/";
  useNavigationStore.setState({ status: "idle", nativeSessionId: null });
  useImportedGeometryStore.getState().clearImported();
  f.list.mockResolvedValue({ items: [item], canApply: true, scheme: "openmapx" });
  f.text.mockResolvedValue('{"type":"Point","coordinates":[8,50]}');
  f.complete.mockResolvedValue(undefined);
});
it("imports only on confirmation and acknowledges the exact item", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockResolvedValue({ items: [item], canApply: true, scheme: "openmapx" });
  fireEvent.click(screen.getByText("import"));
  await waitFor(() => expect(f.complete).toHaveBeenCalledWith(item.id, "opened"));
  expect(useImportedGeometryStore.getState().imported?.name).toBe("walk.geojson");
});
it("defers a navigation-start race without applying or deleting", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockImplementation(async () => {
    f.mutating = true;
    return { items: [item], canApply: true, scheme: "openmapx" };
  });
  fireEvent.click(screen.getByText("import"));
  await screen.findByText("deferred");
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});
it("does not auto-open or consume while native reports an active trip", async () => {
  f.list.mockResolvedValue({ items: [item], canApply: false, scheme: "openmapx" });
  render(<NativeIntakeHandler />);
  await screen.findByText("pending");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.text).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
});

it("offers a route back to the map before previewing content on settings pages", async () => {
  f.pathname = "/settings";
  render(<NativeIntakeHandler />);
  await screen.findByText("pending");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.text).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("pending"));
  expect(f.push).toHaveBeenCalledWith("/");
  expect(f.complete).not.toHaveBeenCalled();
});

it("keeps an edited text draft across a fresh listing of the same immutable item", async () => {
  const textItem = {
    id: item.id,
    kind: "text",
    name: "Shared location",
    createdAtMs: 1,
    byteLength: 6,
  };
  f.list.mockImplementation(async () => ({
    items: [{ ...textItem }],
    canApply: true,
    scheme: "openmapx",
  }));
  f.text.mockResolvedValue("Berlin");
  render(<NativeIntakeHandler />);
  const field = await screen.findByLabelText("search");
  await waitFor(() => expect(field).toHaveValue("Berlin"));
  fireEvent.change(field, { target: { value: "Edited destination" } });
  const before = f.list.mock.calls.length;
  await act(async () => {
    for (const listener of listeners) listener({ type: "intake.changed" } as never);
    await Promise.resolve();
  });
  await waitFor(() => expect(f.list.mock.calls.length).toBeGreaterThan(before));
  expect(field).toHaveValue("Edited destination");
  expect(f.text).toHaveBeenCalledTimes(1);
});
it("does not restart a file read on a metadata refresh", async () => {
  f.list.mockImplementation(async () => ({
    items: [{ ...item }],
    canApply: true,
    scheme: "openmapx",
  }));
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  const before = f.list.mock.calls.length;
  await act(async () => {
    for (const listener of listeners) listener({ type: "intake.changed" } as never);
    await Promise.resolve();
  });
  await waitFor(() => expect(f.list.mock.calls.length).toBeGreaterThan(before));
  expect(f.text).toHaveBeenCalledTimes(1);
});

it("offers postponed items again on a later foreground", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  fireEvent.click(screen.getByText("later"));
  expect(f.complete).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const previous = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await screen.findByRole("dialog");
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

it("reports unavailable authority instead of inventing an active trip, and can recheck", async () => {
  f.list.mockRejectedValue(new IntakeTransferError("navigation-unavailable"));
  render(<NativeIntakeHandler />);
  await screen.findByText("navigationUnavailable");
  expect(screen.queryByText("deferred")).toBeNull();
  expect(screen.queryByText("import")).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
  f.list.mockResolvedValue({ items: [item], canApply: true, scheme: "openmapx" });
  fireEvent.click(screen.getByText("retry"));
  await screen.findByText("features");
  expect(screen.queryByText("navigationUnavailable")).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});
it("keeps a previous preview blocked when an authority refresh fails", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockRejectedValue(new IntakeTransferError("navigation-unavailable"));
  fireEvent.click(screen.getByText("import"));
  await screen.findByText("navigationUnavailable");
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});

it("keeps a transient listing failure silent when no shared items are known", async () => {
  f.list.mockRejectedValue(new Error("temporary bridge timeout"));
  render(<NativeIntakeHandler />);
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});
it("shows a generic listing failure when shared items are known", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockRejectedValue(new Error("temporary bridge timeout"));
  await act(async () => {
    for (const listener of listeners) listener({ type: "intake.changed" } as never);
  });
  await screen.findByText("listingUnavailable");
  expect(f.complete).not.toHaveBeenCalled();
});

it("shows no notice for an empty inbox without apply authority", async () => {
  f.list.mockResolvedValue({ items: [], canApply: false, scheme: "openmapx" });
  render(<NativeIntakeHandler />);
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("pending")).toBeNull();
});

it("reports an item gone from the empty inbox as expired rather than an active trip", async () => {
  render(<NativeIntakeHandler />);
  await screen.findByText("features");
  f.list.mockResolvedValue({ items: [], canApply: false, scheme: "openmapx" });
  fireEvent.click(screen.getByText("import"));
  await screen.findByText("expired");
  expect(screen.queryByText("deferred")).toBeNull();
  expect(useImportedGeometryStore.getState().imported).toBeNull();
  expect(f.complete).not.toHaveBeenCalled();
});

it.each([4, MOBILE_PROTOCOL_MAX])(
  "opens the normal provider trip on protocol %s without displaying DB text or an import summary",
  async (version) => {
    f.protocolVersion = version;
    const { dbNavigatorExamples } = await import(
      "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
    );
    const { useDirectionsStore } = await import("@openmapx/core");
    f.list.mockResolvedValue({
      items: [{ ...item, kind: "text", byteLength: 500 }],
      canApply: true,
      scheme: "openmapx",
    });
    f.text.mockResolvedValue(dbNavigatorExamples[3]);
    render(<NativeIntakeHandler />);
    await screen.findByText("sharedTrip");
    expect(travel.resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(travel.resolve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(f.complete).toHaveBeenCalledWith(item.id, "opened"));
    expect(useDirectionsStore.getState().transitItineraries[0]).toMatchObject(
      travelResult.plan.data.itineraries[0],
    );
    expect(queryClient.getQueryData(transitPlanQueryKey(travelResult.query))).toBe(
      travelResult.plan,
    );
    expect(screen.queryByText("DB Navigator")).toBeNull();
    expect(screen.queryByLabelText("tripText")).toBeNull();
  },
);
it.each([3, null])("does not read the inbox on protocol %s", (version) => {
  f.protocolVersion = version;
  render(<NativeIntakeHandler />);
  expect(f.list).not.toHaveBeenCalled();
});
it("does not read the inbox when native intake is unavailable", () => {
  f.nativeIntake = false;
  render(<NativeIntakeHandler />);
  expect(f.list).not.toHaveBeenCalled();
});
it("keeps a mandatory bike-carriage session visible and retains the share before any resolution", async () => {
  const { dbNavigatorExamples } = await import(
    "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
  );
  useDirectionsStore.getState().setTransitAccessMode("bike");
  useDirectionsStore.getState().setRequireBikeTransport(true);
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 500 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue(dbNavigatorExamples[0]);
  render(<NativeIntakeHandler />);
  await screen.findByText("sharedTrip");
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("tripBikeRequirement");
  expect(travel.resolve).not.toHaveBeenCalled();
  expect(f.complete).not.toHaveBeenCalled();
  expect(useDirectionsStore.getState()).toMatchObject({
    transitAccessMode: "bike",
    requireBikeTransport: true,
  });
});
it("rechecks native authority after resolving and retains the share on a navigation race", async () => {
  const { dbNavigatorExamples } = await import(
    "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
  );
  const { useDirectionsStore } = await import("@openmapx/core");
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 500 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue(dbNavigatorExamples[0]);
  travel.resolve.mockImplementation(async () => {
    f.mutating = true;
    return travelResult;
  });
  render(<NativeIntakeHandler />);
  await screen.findByText("sharedTrip");
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("deferred");
  expect(f.complete).not.toHaveBeenCalled();
  expect(useDirectionsStore.getState().transitItineraries).toEqual([]);
});
it("Later cancels a pending travel-plan lookup without consuming content", async () => {
  const { dbNavigatorExamples } = await import(
    "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
  );
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 500 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue(dbNavigatorExamples[0]);
  let signal: AbortSignal | undefined;
  travel.resolve.mockImplementation((_plan, _port, s) => {
    signal = s as AbortSignal;
    return new Promise(() => {});
  });
  render(<NativeIntakeHandler />);
  await screen.findByText("sharedTrip");
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("loading");
  fireEvent.click(screen.getByText("later"));
  expect(signal?.aborted).toBe(true);
  expect(f.complete).not.toHaveBeenCalled();
});

it("an unavailable exact trip retains the input and can be retried", async () => {
  const { dbNavigatorExamples } = await import(
    "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
  );
  const { TravelPlanResolutionError } = await import("@openmapx/core/navigation/api");
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 500 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue(dbNavigatorExamples[0]);
  travel.resolve.mockRejectedValueOnce(new TravelPlanResolutionError("not-found"));
  render(<NativeIntakeHandler />);
  await screen.findByText("sharedTrip");
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("tripUnavailable");
  expect(f.complete).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("tripText")).toBeNull();
  fireEvent.click(screen.getByText("open"));
  await waitFor(() => expect(f.complete).toHaveBeenCalledWith(item.id, "opened"));
});
it("unmount aborts a lookup and prevents later publication or acknowledgement", async () => {
  const { dbNavigatorExamples } = await import(
    "../../../../../packages/core/src/travel-plans/__fixtures__/dbNavigator"
  );
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 500 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue(dbNavigatorExamples[0]);
  let finish: (value: typeof travelResult) => void = () => {};
  let signal: AbortSignal | undefined;
  travel.resolve.mockImplementation((...args: unknown[]) => {
    signal = args[2] as AbortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const view = render(<NativeIntakeHandler />);
  await screen.findByText("sharedTrip");
  fireEvent.click(screen.getByText("open"));
  await screen.findByText("loading");
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(travelResult));
  expect(useDirectionsStore.getState().transitItineraries).toEqual([]);
  expect(f.complete).not.toHaveBeenCalled();
});
it("a URL-only DB share is editable but cannot become a location search", async () => {
  f.list.mockResolvedValue({
    items: [{ ...item, kind: "text", byteLength: 60 }],
    canApply: true,
    scheme: "openmapx",
  });
  f.text.mockResolvedValue("https://www.bahn.de/buchung/start?vbid=abc");
  render(<NativeIntakeHandler />);
  await screen.findByText("tripMissingText");
  expect(screen.getByText("open")).toBeDisabled();
  expect(travel.resolve).not.toHaveBeenCalled();
});
