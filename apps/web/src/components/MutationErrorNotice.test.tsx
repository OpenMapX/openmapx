import {
  ApiClientError,
  ApiRequestAbortedError,
  CALLER_SHOWS_ERRORS,
  type LabeledPlace,
  type SavedList,
  type SavedPlace,
  useSavedPlacesStore,
} from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { type QueryClient, useMutation } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

const state = vi.hoisted(() => ({
  pathname: "/" as string | null,
  writes: [] as { method: string; path: string }[],
  lists: [] as SavedList[],
  places: [] as SavedPlace[],
  labels: [] as LabeledPlace[],
  vehicles: [] as unknown[],
  shares: [] as unknown[],
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => state.pathname,
}));
vi.mock("../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({
    data: { user: { id: "user-1" } },
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@emoji-mart/react", () => ({ default: () => null }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
// Reads come from the test; every write goes through the real mutation hooks
// and the real SDK to the stubbed network below.
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({ data: state.lists, isLoading: false }),
  useSavedListPlaces: () => ({ data: state.places, isLoading: false }),
  useLabeledPlaces: () => ({ data: state.labels, isLoading: false }),
  useVehicles: () => ({ data: state.vehicles }),
  useShares: () => ({ data: state.shares }),
}));

const { MutationErrorNotice } = await import("./MutationErrorNotice");
const { SavedListDetail } = await import("./panels/saved/SavedListDetail");
const { SavedLabeledTab } = await import("./panels/saved/SavedLabeledTab");
const { VehiclesDialog } = await import("./settings/VehiclesDialog");
const { SharedLinksSection } = await import("./auth/SharedLinksSection");
const { ShareListDialog } = await import("./panels/saved/ShareListDialog");

const FAILED = en.common.actionFailed;

function renderWithNotice(ui: ReactNode, queryClient: QueryClient = createTestQueryClient()) {
  const Wrapper = createQueryWrapper(queryClient);
  return render(
    <Wrapper>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        {ui}
        <MutationErrorNotice />
      </NextIntlClientProvider>
    </Wrapper>,
  );
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  state.pathname = "/";
  state.writes = [];
  state.lists = [];
  state.places = [];
  state.labels = [];
  state.vehicles = [];
  state.shares = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return json(404, { error: "Not found" });
    state.writes.push({ method: request.method, path });
    return json(503, { error: "Refused" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the failed-change notice", () => {
  function FailingAction({
    error,
    options,
  }: {
    error: unknown;
    options?: typeof CALLER_SHOWS_ERRORS;
  }) {
    const mutation = useMutation({
      ...options,
      mutationFn: async () => {
        throw error;
      },
    });
    return (
      <button type="button" onClick={() => mutation.mutate(undefined, { onError: () => {} })}>
        Act
      </button>
    );
  }

  it.each<[string, unknown, string]>([
    ["an unexplained failure", new Error("boom"), FAILED],
    ["a request that timed out", new ApiRequestAbortedError("timeout"), FAILED],
    [
      "an expired session",
      new ApiClientError(401, { error: "Authentication required" }, null),
      en.common.signedOutRetry,
    ],
    [
      "a declared conflict",
      new ApiClientError(409, { error: "taken", code: "SAVED_LIST_NAME_TAKEN" }, null),
      en.saved.listNameTaken,
    ],
    [
      "a vehicle name conflict",
      new ApiClientError(409, { error: "taken", code: "VEHICLE_NAME_TAKEN" }, null),
      en.vehicles.nameTaken,
    ],
  ])("explains %s", async (_name, error, message) => {
    renderWithNotice(<FailingAction error={error} />);
    await userEvent.click(screen.getByRole("button", { name: "Act" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("shows one notice for several failures at once", async () => {
    const error = new ApiClientError(401, { error: "Authentication required" }, null);
    renderWithNotice(
      <>
        <FailingAction error={error} />
        <FailingAction error={error} />
      </>,
    );
    for (const button of screen.getAllByRole("button", { name: "Act" })) {
      await userEvent.click(button);
    }
    await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it.each<[string, unknown, typeof CALLER_SHOWS_ERRORS | undefined, string]>([
    ["the caller shows the failure", new Error("boom"), CALLER_SHOWS_ERRORS, "/"],
    ["the request was cancelled", new ApiRequestAbortedError("aborted"), undefined, "/"],
    ["an administration page has its own reporting", new Error("boom"), undefined, "/admin/users"],
  ])("stays silent when %s", async (_name, error, options, pathname) => {
    state.pathname = pathname;
    const client = createTestQueryClient();
    renderWithNotice(<FailingAction error={error} options={options} />, client);
    await userEvent.click(screen.getByRole("button", { name: "Act" }));
    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can be dismissed", async () => {
    renderWithNotice(<FailingAction error={new Error("boom")} />);
    await userEvent.click(screen.getByRole("button", { name: "Act" }));
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: en.common.close }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("failed saves on personal data surfaces", () => {
  it("reports a saved place note that was not saved", async () => {
    state.lists = [
      { id: "list-1", name: "Trip", icon: null, isPrivate: true, placeCount: 1 } as SavedList,
    ];
    state.places = [
      {
        id: "place-1",
        listId: "list-1",
        name: "Cafe",
        address: null,
        lat: 52,
        lng: 13,
        placeId: null,
        fieldContributors: null,
        note: null,
        sortOrder: 0,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ];
    act(() => useSavedPlacesStore.getState().selectList("list-1"));
    renderWithNotice(<SavedListDetail />);

    await userEvent.click(screen.getByRole("button", { name: `+ ${en.saved.note}` }));
    await userEvent.keyboard("Window seat{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(state.writes).toEqual([{ method: "PATCH", path: "/api/saved/places/place-1" }]);
  });

  it("reports a label that could not be removed", async () => {
    state.labels = [
      {
        id: "label-1",
        label: "Gym",
        icon: null,
        name: "Gym",
        address: "Ring 1",
        lat: 52,
        lng: 13,
        placeId: null,
        fieldContributors: null,
      },
    ];
    renderWithNotice(<SavedLabeledTab />);

    const row = screen.getByText("Gym").parentElement?.parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("button"));
    await userEvent.click(screen.getByRole("menuitem", { name: en.saved.removeAddress }));

    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(state.writes).toEqual([{ method: "DELETE", path: "/api/saved/labels/Gym" }]);
  });

  it("reports a default vehicle that was not changed", async () => {
    const car = {
      kind: "car",
      powertrain: "petrol",
      presetId: null,
      ev: null,
      fuelConsumptionLPer100Km: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    };
    state.vehicles = [
      { ...car, id: "v1", name: "Blue Golf", isDefault: true },
      { ...car, id: "v2", name: "Red Van", isDefault: false },
    ];
    renderWithNotice(<VehiclesDialog open onClose={() => {}} />);

    const [, second] = screen.getAllByRole("radio", { name: en.vehicles.makeDefault });
    await userEvent.click(second);
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
  });

  it("shows a vehicle editor failure only in the editor", async () => {
    state.vehicles = [
      {
        id: "v1",
        name: "Blue Golf",
        kind: "car",
        powertrain: "petrol",
        isDefault: true,
        presetId: null,
        ev: null,
        fuelConsumptionLPer100Km: null,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
    ];
    renderWithNotice(<VehiclesDialog open onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: en.vehicles.edit }));
    await userEvent.click(screen.getByRole("button", { name: en.vehicles.save }));

    expect(await screen.findByText(en.vehicles.saveFailed)).toBeInTheDocument();
    expect(state.writes).toEqual([{ method: "PATCH", path: "/api/vehicles/v1" }]);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it("reports a share link that was not deleted", async () => {
    state.shares = [
      {
        id: "share-1",
        label: "Trip",
        targetType: "list",
        targetId: "list-1",
        mode: "live",
        createdAt: "2026-01-01T12:00:00Z",
        expiresAt: null,
      },
    ];
    renderWithNotice(<SharedLinksSection />);

    await userEvent.click(screen.getByRole("button", { name: en.share.revokeLink }));

    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(state.writes).toEqual([{ method: "DELETE", path: "/api/shares/share-1" }]);
  });

  it("shows a failed share link creation only in its dialog", async () => {
    renderWithNotice(<ShareListDialog open listId="list-1" listName="Trip" onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: en.share.createLink }));

    expect(await screen.findByText(en.share.createFailed)).toBeInTheDocument();
    expect(state.writes).toEqual([{ method: "POST", path: "/api/shares" }]);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });
});
