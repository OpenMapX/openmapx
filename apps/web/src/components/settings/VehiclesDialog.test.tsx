import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createQueryWrapper,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/test";

const state = vi.hoisted(() => ({
  vehicles: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

// The save hooks are thin adapters over real TanStack mutations, so the dialog
// sees the same pending/rejected/shared-observer behaviour as the garage hooks
// while the request spies stay under the test's control.
vi.mock("@openmapx/core", async (importOriginal) => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    ...(await importOriginal<typeof import("@openmapx/core")>()),
    useVehicles: () => ({ data: state.vehicles }),
    useCreateVehicle: () =>
      useMutation({ mutationFn: async (draft: unknown) => state.create(draft) }),
    useUpdateVehicle: () =>
      useMutation({ mutationFn: async (patch: unknown) => state.update(patch) }),
    useDeleteVehicle: () => useMutation({ mutationFn: async (id: unknown) => state.remove(id) }),
  };
});

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { VehiclesDialog } from "./VehiclesDialog";

const CAR = {
  id: "v1",
  name: "Blue Golf",
  kind: "car",
  powertrain: "petrol",
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6.4,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

const EV_CAR = {
  ...CAR,
  powertrain: "electric",
  fuelConsumptionLPer100Km: null,
  ev: {
    batteryKwh: 60,
    baseWhPerKm: 180,
    massTonnes: 2,
    maxDcKw: 150,
    maxAcKw: 11,
    vehicleTaperSocPct: 80,
    connectors: ["ccs2", "type2"],
  },
};

/** Toggles the open prop of the dialog mounted by the latest `renderDialog` call. */
const reopen: { current: ((open: boolean) => void) | null } = { current: null };

function renderDialog() {
  const view = render(<VehiclesDialog open onClose={() => {}} />, {
    wrapper: createQueryWrapper(),
  });
  reopen.current = (open) => view.rerender(<VehiclesDialog open={open} onClose={() => {}} />);
  return view;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Makes each successive call of `spy` return the next promise (then undefined). */
function respondWith(spy: typeof state.create, ...responses: Promise<void>[]) {
  const queue = [...responses];
  spy.mockImplementation(() => queue.shift());
}

const clickSave = () => userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));
const saveButton = () => screen.getByRole("button", { name: "vehicles.save" });
const nameInput = () => screen.getByLabelText("vehicles.name") as HTMLInputElement;

beforeEach(() => {
  state.vehicles = [CAR];
  state.create.mockReset();
  state.update.mockReset();
  state.remove.mockReset();
});

describe("VehiclesDialog", () => {
  it("preserves mass and charge taper when renaming an EV", async () => {
    state.vehicles = [
      {
        ...CAR,
        powertrain: "electric",
        ev: {
          batteryKwh: 60,
          baseWhPerKm: 180,
          massTonnes: 1.3,
          maxDcKw: 150,
          maxAcKw: 11,
          vehicleTaperSocPct: 65,
          connectors: ["ccs2"],
        },
      },
    ];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.edit" }));
    await userEvent.clear(screen.getByLabelText("vehicles.name"));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Renamed EV");
    await userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0][0]).toMatchObject({
      ev: { massTonnes: 1.3, vehicleTaperSocPct: 65 },
    });
  });

  it("uses the selected preset mass instead of a generic car mass", async () => {
    state.vehicles = [];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Audi");
    await userEvent.click(screen.getByLabelText("vehicles.powertrain"));
    await userEvent.click(screen.getByRole("option", { name: "vehicles.powertrainElectric" }));
    await userEvent.type(
      screen.getByRole("combobox", { name: "vehicles.preset" }),
      "Audi A6 e-tron Avant (2024)",
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Audi A6 e-tron Avant (2024)" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0][0]).toMatchObject({
      ev: { massTonnes: 2.22, vehicleTaperSocPct: 80 },
    });
  });
  it("lists the garage", () => {
    renderDialog();
    expect(screen.getByText("Blue Golf")).toBeInTheDocument();
  });

  it("shows an empty state for an empty garage", () => {
    state.vehicles = [];
    renderDialog();
    expect(screen.getByText("vehicles.empty")).toBeInTheDocument();
  });

  it("creates a combustion vehicle", async () => {
    state.vehicles = [];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Red Polo");
    await userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Red Polo", kind: "car", isDefault: false }),
      ),
    );
  });

  it.each([
    { powertrain: "petrol", ev: null },
    {
      powertrain: "electric",
      ev: {
        batteryKwh: 60,
        baseWhPerKm: 180,
        massTonnes: 2,
        maxDcKw: 150,
        maxAcKw: 11,
        vehicleTaperSocPct: 80,
        connectors: ["ccs2", "type2"],
      },
    },
  ])("preserves the default selection when editing a $powertrain vehicle", async (spec) => {
    state.vehicles = [{ ...CAR, ...spec }];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.edit" }));
    await userEvent.clear(screen.getByLabelText("vehicles.name"));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Renamed car");
    await userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));

    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    const patch = state.update.mock.calls[0][0];
    expect(patch).toMatchObject({ id: "v1", name: "Renamed car", powertrain: spec.powertrain });
    expect(patch).not.toHaveProperty("isDefault");
  });

  it("refuses to save a vehicle with no name", async () => {
    state.vehicles = [];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    expect(screen.getByRole("button", { name: "vehicles.save" })).toBeDisabled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("refuses to save an electric vehicle with an incomplete battery spec", async () => {
    state.vehicles = [];
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Silent One");
    await userEvent.click(screen.getByLabelText("vehicles.powertrain"));
    await userEvent.click(screen.getByRole("option", { name: "vehicles.powertrainElectric" }));
    expect(screen.getByRole("button", { name: "vehicles.save" })).toBeDisabled();
  });

  it("hides Add once the cap is reached", () => {
    state.vehicles = Array.from({ length: 12 }, (_, i) => ({ ...CAR, id: `v${i}`, name: `V${i}` }));
    renderDialog();
    expect(screen.queryByRole("button", { name: "vehicles.add" })).toBeNull();
    expect(screen.getByText(/vehicles.limitReached/)).toBeInTheDocument();
  });

  it("promotes a vehicle to default", async () => {
    state.vehicles = [CAR, { ...CAR, id: "v2", name: "Red Polo", isDefault: false }];
    renderDialog();
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: "v2", isDefault: true }));
  });

  it("warns that deleting clears the parked position and waits for confirmation", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "vehicles.delete" }));
    expect(screen.getByText("vehicles.deleteWarning")).toBeInTheDocument();
    expect(state.remove).not.toHaveBeenCalled();
  });
});

interface SaveScenario {
  label: string;
  request: typeof state.create;
  /** Opens an editor with distinctive values and returns the intended payload. */
  start: () => Promise<Record<string, unknown>>;
  /** Replaces the abandoned editor with a fresh one holding a different name. */
  restart: () => Promise<void>;
  specLabel: string;
  specValue: string;
}

const SAVE_SCENARIOS: SaveScenario[] = [
  {
    label: "create",
    request: state.create,
    specLabel: "vehicles.fuelConsumption",
    specValue: "5.2",
    start: async () => {
      state.vehicles = [];
      renderDialog();
      await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
      await userEvent.type(nameInput(), "Synthetic Create");
      await userEvent.type(screen.getByLabelText("vehicles.fuelConsumption"), "5.2");
      return { name: "Synthetic Create", fuelConsumptionLPer100Km: 5.2, isDefault: false };
    },
    restart: async () => {
      await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
      await userEvent.type(nameInput(), "Newer draft");
    },
  },
  {
    label: "update",
    request: state.update,
    specLabel: "vehicles.battery",
    specValue: "72",
    start: async () => {
      state.vehicles = [EV_CAR];
      renderDialog();
      await userEvent.click(screen.getByRole("button", { name: "vehicles.edit" }));
      await userEvent.clear(nameInput());
      await userEvent.type(nameInput(), "Synthetic Update");
      await userEvent.clear(screen.getByLabelText("vehicles.battery"));
      await userEvent.type(screen.getByLabelText("vehicles.battery"), "72");
      return {
        id: "v1",
        name: "Synthetic Update",
        ev: expect.objectContaining({ batteryKwh: 72 }),
      };
    },
    restart: async () => {
      await userEvent.click(screen.getByRole("button", { name: "vehicles.edit" }));
      await userEvent.clear(nameInput());
      await userEvent.type(nameInput(), "Newer edit");
    },
  },
];

describe.each(SAVE_SCENARIOS)("VehiclesDialog saving ($label)", (scenario) => {
  const specInput = () => screen.getByLabelText(scenario.specLabel) as HTMLInputElement;
  const editorOpen = () => screen.queryByLabelText("vehicles.name") !== null;

  it("keeps the submitted draft visible and locked while the request is unresolved", async () => {
    const request = deferred();
    respondWith(scenario.request, request.promise);
    const payload = await scenario.start();
    await clickSave();

    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));
    expect(scenario.request.mock.calls[0][0]).toMatchObject(payload);
    expect(nameInput()).toHaveValue(String(payload.name));
    expect(specInput()).toHaveValue(Number(scenario.specValue));
    expect(nameInput()).toBeDisabled();
    expect(specInput()).toBeDisabled();
    expect(screen.getByLabelText("vehicles.powertrain")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("vehicles.kind")).toHaveAttribute("aria-disabled", "true");
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "vehicles.cancel" })).not.toBeDisabled();

    // A second activation of the disabled button must not duplicate the request.
    fireEvent.click(saveButton());
    expect(scenario.request).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve());
    await waitFor(() => expect(editorOpen()).toBe(false));
  });

  it("keeps every value on rejection, shows a localized alert and retries the same payload", async () => {
    const failing = deferred();
    const retry = deferred();
    respondWith(scenario.request, failing.promise, retry.promise);
    const payload = await scenario.start();
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));

    await act(async () => failing.reject(new Error("raw server detail")));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("vehicles.saveFailed");
    expect(alert).not.toHaveTextContent("raw server detail");
    expect(nameInput()).toHaveValue(String(payload.name));
    expect(specInput()).toHaveValue(Number(scenario.specValue));
    expect(nameInput()).not.toBeDisabled();
    expect(specInput()).not.toBeDisabled();
    expect(saveButton()).not.toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(scenario.request).toHaveBeenCalledTimes(1);

    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(2));
    expect(scenario.request.mock.calls[1][0]).toEqual(scenario.request.mock.calls[0][0]);
    // The error is cleared the moment the retry starts.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton()).toBeDisabled();

    await act(async () => retry.resolve());
    await waitFor(() => expect(editorOpen()).toBe(false));
  });

  it("ignores a late success after the editor was cancelled and replaced", async () => {
    const request = deferred();
    respondWith(scenario.request, request.promise);
    await scenario.start();
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "vehicles.cancel" }));
    expect(editorOpen()).toBe(false);
    await scenario.restart();

    await act(async () => request.resolve());
    expect(editorOpen()).toBe(true);
    expect(nameInput().value).toMatch(/^Newer /);
    expect(nameInput()).not.toBeDisabled();
    expect(specInput()).not.toBeDisabled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a late failure after the editor was cancelled and replaced", async () => {
    const request = deferred();
    respondWith(scenario.request, request.promise);
    await scenario.start();
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "vehicles.cancel" }));
    await scenario.restart();

    await act(async () => request.reject(new Error("late")));
    expect(editorOpen()).toBe(true);
    expect(nameInput().value).toMatch(/^Newer /);
    expect(nameInput()).not.toBeDisabled();
    expect(saveButton()).not.toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a pending draft across closing and reopening, then handles its completion", async () => {
    const request = deferred();
    respondWith(scenario.request, request.promise);
    const payload = await scenario.start();
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));

    await act(async () => reopen.current?.(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => reopen.current?.(true));
    expect(nameInput()).toHaveValue(String(payload.name));
    expect(nameInput()).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    await act(async () => request.resolve());
    await waitFor(() => expect(editorOpen()).toBe(false));
  });

  it("retires the old request when the editor is replaced after reopening", async () => {
    const request = deferred();
    respondWith(scenario.request, request.promise);
    await scenario.start();
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));

    await act(async () => reopen.current?.(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => reopen.current?.(true));
    await userEvent.click(screen.getByRole("button", { name: "vehicles.cancel" }));
    await scenario.restart();

    await act(async () => request.reject(new Error("late")));
    expect(nameInput().value).toMatch(/^Newer /);
    expect(nameInput()).not.toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("VehiclesDialog saving alongside default promotion", () => {
  const OTHER = { ...CAR, id: "v2", name: "Red Polo", isDefault: false };

  async function startEditSave(request: ReturnType<typeof deferred>) {
    state.vehicles = [CAR, OTHER];
    respondWith(state.update, request.promise);
    renderDialog();
    await userEvent.click(screen.getAllByRole("button", { name: "vehicles.edit" })[0]);
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), "Edited Golf");
    await clickSave();
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  }

  it("still closes the editor when its save succeeds while a row promotion is in flight", async () => {
    const edit = deferred();
    const promote = deferred();
    await startEditSave(edit);
    respondWith(state.update, promote.promise);
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls[1][0]).toEqual({ id: "v2", isDefault: true });

    await act(async () => edit.resolve());
    await waitFor(() => expect(screen.queryByLabelText("vehicles.name")).toBeNull());
    await act(async () => promote.resolve());
  });

  it("is not failed or left pending by a promotion that settles first", async () => {
    const edit = deferred();
    const promote = deferred();
    await startEditSave(edit);
    respondWith(state.update, promote.promise);
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));

    await act(async () => promote.reject(new Error("promotion failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput()).toHaveValue("Edited Golf");
    expect(nameInput()).toBeDisabled();

    await act(async () => edit.reject(new Error("edit failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("vehicles.saveFailed");
    expect(nameInput()).not.toBeDisabled();
    expect(saveButton()).not.toBeDisabled();
    expect(within(screen.getByRole("dialog")).getAllByRole("radio")).toHaveLength(2);
  });
});

const PRESET_ID = "audi:a6_e_tron:2024:a6_e_tron_avant";
const PRESET_LABEL = "Audi A6 e-tron Avant (2024)";

const kindSelect = () => screen.getByLabelText("vehicles.kind");
const powertrainSelect = () => screen.getByLabelText("vehicles.powertrain");
const presetInput = () => screen.getByRole("combobox", { name: "vehicles.preset" });
const connectorsInput = () => screen.getByRole("combobox", { name: "vehicles.connectors" });
const numberInput = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

async function replaceText(input: HTMLElement, value: string) {
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

/** Every value the electric editor shows, in the way the user reads it. */
function readEditor() {
  const chips = connectorsInput()
    .closest(".MuiAutocomplete-root")
    ?.querySelectorAll(".MuiChip-label");
  return {
    name: nameInput().value,
    kind: kindSelect().textContent,
    powertrain: powertrainSelect().textContent,
    preset: (presetInput() as HTMLInputElement).value,
    battery: numberInput("vehicles.battery").value,
    consumption: numberInput("vehicles.consumption").value,
    maxDc: numberInput("vehicles.maxDc").value,
    maxAc: numberInput("vehicles.maxAc").value,
    connectors: Array.from(chips ?? [], (chip) => chip.textContent),
  };
}

// Chips are ButtonBase divs: they carry only the MUI disabled class, not the attribute.
const isLocked = (element: HTMLElement) =>
  element.matches(":disabled") ||
  element.getAttribute("aria-disabled") === "true" ||
  element.classList.contains("Mui-disabled");

/**
 * Asserts the lock state of each named control and, separately, of every other
 * interactive element inside the form (popup buttons, chips, hidden inputs), so
 * a control added later cannot be left editable while the save is pending.
 */
function expectEditorLocked(locked: boolean) {
  const named: [string, HTMLElement][] = [
    ["name", nameInput()],
    ["kind", kindSelect()],
    ["powertrain", powertrainSelect()],
    ["preset", presetInput()],
    ["battery", numberInput("vehicles.battery")],
    ["consumption", numberInput("vehicles.consumption")],
    ["maxDc", numberInput("vehicles.maxDc")],
    ["maxAc", numberInput("vehicles.maxAc")],
    ["connectors", connectorsInput()],
  ];
  for (const [label, element] of named) {
    expect({ label, locked: isLocked(element) }).toEqual({ label, locked });
  }

  const actions = saveButton().parentElement as HTMLElement;
  const controls = Array.from(
    (actions.parentElement as HTMLElement).querySelectorAll<HTMLElement>(
      "input, textarea, select, button, [role='button'], [role='combobox']",
    ),
  ).filter((element) => !actions.contains(element));
  expect(controls.length).toBeGreaterThan(named.length);
  for (const element of controls) {
    expect({ element: element.outerHTML.slice(0, 120), locked: isLocked(element) }).toEqual({
      element: element.outerHTML.slice(0, 120),
      locked,
    });
  }
  expect(isLocked(saveButton())).toBe(locked);
  expect(isLocked(screen.getByRole("button", { name: "vehicles.cancel" }))).toBe(false);
}

interface ElectricScenario {
  label: string;
  request: typeof state.create;
  start: () => Promise<void>;
  /** Editor contents as shown, with every value distinct from the defaults. */
  shown: ReturnType<typeof readEditor>;
  /** The exact request payload, including mass/taper from the preset or vehicle. */
  payload: Record<string, unknown>;
}

const ELECTRIC_SCENARIOS: ElectricScenario[] = [
  {
    label: "create",
    request: state.create,
    start: async () => {
      state.vehicles = [];
      renderDialog();
      await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
      await userEvent.type(nameInput(), "Synthetic Electric Create");
      await userEvent.click(kindSelect());
      await userEvent.click(screen.getByRole("option", { name: "vehicles.kindMotorcycle" }));
      await userEvent.click(powertrainSelect());
      await userEvent.click(screen.getByRole("option", { name: "vehicles.powertrainElectric" }));
      await userEvent.type(presetInput(), PRESET_LABEL);
      await userEvent.click(await screen.findByRole("option", { name: PRESET_LABEL }));
      await replaceText(numberInput("vehicles.battery"), "77");
      await replaceText(numberInput("vehicles.consumption"), "171");
      await replaceText(numberInput("vehicles.maxDc"), "190");
      await replaceText(numberInput("vehicles.maxAc"), "22");
      await userEvent.type(connectorsInput(), "directions.ev.connector.chademo");
      await userEvent.click(
        await screen.findByRole("option", { name: "directions.ev.connector.chademo" }),
      );
    },
    shown: {
      name: "Synthetic Electric Create",
      kind: "vehicles.kindMotorcycle",
      powertrain: "vehicles.powertrainElectric",
      preset: PRESET_LABEL,
      battery: "77",
      consumption: "171",
      maxDc: "190",
      maxAc: "22",
      connectors: [
        "directions.ev.connector.ccs2",
        "directions.ev.connector.type2",
        "directions.ev.connector.chademo",
      ],
    },
    payload: {
      name: "Synthetic Electric Create",
      kind: "motorcycle",
      powertrain: "electric",
      isDefault: false,
      presetId: PRESET_ID,
      ev: {
        batteryKwh: 77,
        baseWhPerKm: 171,
        massTonnes: 2.22,
        maxDcKw: 190,
        maxAcKw: 22,
        vehicleTaperSocPct: 80,
        connectors: ["ccs2", "type2", "chademo"],
      },
      fuelConsumptionLPer100Km: null,
    },
  },
  {
    label: "update",
    request: state.update,
    start: async () => {
      state.vehicles = [
        {
          ...EV_CAR,
          kind: "motorcycle",
          powertrain: "plugin_hybrid",
          presetId: PRESET_ID,
          ev: {
            batteryKwh: 83,
            baseWhPerKm: 177,
            massTonnes: 1.3,
            maxDcKw: 175,
            maxAcKw: 16,
            vehicleTaperSocPct: 65,
            connectors: ["ccs1", "chademo"],
          },
        },
      ];
      renderDialog();
      await userEvent.click(screen.getByRole("button", { name: "vehicles.edit" }));
      await replaceText(nameInput(), "Synthetic Electric Update");
      await replaceText(numberInput("vehicles.maxAc"), "19");
    },
    shown: {
      name: "Synthetic Electric Update",
      kind: "vehicles.kindMotorcycle",
      powertrain: "vehicles.powertrainPluginHybrid",
      preset: PRESET_LABEL,
      battery: "83",
      consumption: "177",
      maxDc: "175",
      maxAc: "19",
      connectors: ["directions.ev.connector.ccs1", "directions.ev.connector.chademo"],
    },
    payload: {
      id: "v1",
      name: "Synthetic Electric Update",
      kind: "motorcycle",
      powertrain: "plugin_hybrid",
      presetId: PRESET_ID,
      ev: {
        batteryKwh: 83,
        baseWhPerKm: 177,
        massTonnes: 1.3,
        maxDcKw: 175,
        maxAcKw: 19,
        vehicleTaperSocPct: 65,
        connectors: ["ccs1", "chademo"],
      },
      fuelConsumptionLPer100Km: null,
    },
  },
];

describe.each(ELECTRIC_SCENARIOS)("VehiclesDialog electric draft ($label)", (scenario) => {
  it("locks every control with all values intact while pending and after a rejection", async () => {
    const failing = deferred();
    const retry = deferred();
    respondWith(scenario.request, failing.promise, retry.promise);
    await scenario.start();

    expect(readEditor()).toEqual(scenario.shown);
    expectEditorLocked(false);
    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(1));
    expect(scenario.request.mock.calls[0][0]).toEqual(scenario.payload);

    expect(readEditor()).toEqual(scenario.shown);
    expectEditorLocked(true);

    await act(async () => failing.reject(new Error("raw server detail")));
    expect(await screen.findByRole("alert")).toHaveTextContent("vehicles.saveFailed");
    expect(readEditor()).toEqual(scenario.shown);
    expectEditorLocked(false);

    await clickSave();
    await waitFor(() => expect(scenario.request).toHaveBeenCalledTimes(2));
    expect(scenario.request.mock.calls[1][0]).toEqual(scenario.payload);
    expect(readEditor()).toEqual(scenario.shown);
    expectEditorLocked(true);

    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByLabelText("vehicles.name")).toBeNull());
  });
});

describe("VehiclesDialog replacing a pending editor through row Edit", () => {
  const SECOND_EV = { ...EV_CAR, id: "v2", name: "Second EV", isDefault: false };
  const editRow = (index: number) =>
    userEvent.click(screen.getAllByRole("button", { name: "vehicles.edit" })[index]);

  /** Opens the editor that will be abandoned; the test then saves it and leaves it pending. */
  const OLD_EDITORS = {
    create: {
      request: state.create,
      start: async () => {
        await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
        await userEvent.type(nameInput(), "Old create draft");
        await userEvent.type(screen.getByLabelText("vehicles.fuelConsumption"), "5.2");
      },
    },
    update: {
      request: state.update,
      start: async () => {
        await editRow(0);
        await replaceText(nameInput(), "Old update draft");
        await replaceText(screen.getByLabelText("vehicles.fuelConsumption"), "7.1");
      },
    },
  };

  const combinations = (["create", "update"] as const).flatMap((oldEditor) =>
    (["success", "failure"] as const).flatMap((oldOutcome) =>
      (["idle", "saving"] as const).flatMap((replacement) =>
        (["success", "failure"] as const).map((replacementOutcome) => ({
          oldEditor,
          oldOutcome,
          replacement,
          replacementOutcome,
        })),
      ),
    ),
  );

  it.each(combinations)(
    "isolates an old $oldEditor $oldOutcome from a replacement that is $replacement that ends in $replacementOutcome",
    async ({ oldEditor, oldOutcome, replacement, replacementOutcome }) => {
      const old = deferred();
      const next = deferred();
      const oldRequest = OLD_EDITORS[oldEditor].request;
      state.vehicles = [CAR, SECOND_EV];
      if (oldEditor === "update") respondWith(state.update, old.promise, next.promise);
      else {
        respondWith(state.create, old.promise);
        respondWith(state.update, next.promise);
      }
      renderDialog();
      await OLD_EDITORS[oldEditor].start();
      await clickSave();
      await waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(1));
      expect(nameInput()).toBeDisabled();

      // Replace the pending editor directly, with no Cancel in between.
      await editRow(1);
      await replaceText(nameInput(), "Replacement edit");
      await replaceText(numberInput("vehicles.battery"), "91");
      expect(nameInput()).toHaveValue("Replacement edit");
      expect(nameInput()).not.toBeDisabled();
      expect(saveButton()).not.toBeDisabled();
      expect(screen.queryByRole("progressbar")).toBeNull();

      if (replacement === "saving") {
        await clickSave();
        await waitFor(() =>
          expect(state.update).toHaveBeenCalledTimes(oldEditor === "update" ? 2 : 1),
        );
        expect(state.update.mock.calls.at(-1)?.[0]).toMatchObject({
          id: "v2",
          name: "Replacement edit",
          ev: expect.objectContaining({ batteryKwh: 91 }),
        });
      }
      const assertReplacementIntact = () => {
        expect(nameInput()).toHaveValue("Replacement edit");
        expect(numberInput("vehicles.battery")).toHaveValue(91);
        expect(screen.queryByRole("alert")).toBeNull();
        const pending = replacement === "saving";
        expect(nameInput().disabled).toBe(pending);
        expect(numberInput("vehicles.battery").disabled).toBe(pending);
        expect(isLocked(saveButton())).toBe(pending);
        expect(screen.queryByRole("progressbar") !== null).toBe(pending);
      };
      assertReplacementIntact();

      // The abandoned request settles late and must not touch the new editor.
      await act(async () =>
        oldOutcome === "success" ? old.resolve() : old.reject(new Error("old failed")),
      );
      assertReplacementIntact();
      expect(oldRequest).toHaveBeenCalledTimes(
        oldEditor === "update" && replacement === "saving" ? 2 : 1,
      );

      // The replacement stays fully functional: it saves and settles on its own.
      if (replacement === "idle") {
        await clickSave();
        await waitFor(() =>
          expect(state.update).toHaveBeenCalledTimes(oldEditor === "update" ? 2 : 1),
        );
        expect(state.update.mock.calls.at(-1)?.[0]).toMatchObject({
          id: "v2",
          name: "Replacement edit",
          ev: expect.objectContaining({ batteryKwh: 91 }),
        });
        expect(nameInput()).toBeDisabled();
        expect(saveButton()).toBeDisabled();
      }
      await act(async () =>
        replacementOutcome === "success" ? next.resolve() : next.reject(new Error("new failed")),
      );
      if (replacementOutcome === "success") {
        await waitFor(() => expect(screen.queryByLabelText("vehicles.name")).toBeNull());
      } else {
        expect(await screen.findByRole("alert")).toHaveTextContent("vehicles.saveFailed");
        expect(nameInput()).toHaveValue("Replacement edit");
        expect(nameInput()).not.toBeDisabled();
        expect(saveButton()).not.toBeDisabled();
        expect(screen.queryByRole("progressbar")).toBeNull();
      }
    },
  );
});
