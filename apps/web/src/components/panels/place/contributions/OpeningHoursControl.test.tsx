import { type OsmContributionContext, useSettingsStore } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { OsmContributionForm } from "./OsmContributionForm";
import {
  initialOsmContributionState,
  osmContributionReducer,
  selectedChanges,
} from "./osmContributionDraft";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useOsmContributionCategories: () => ({ data: [], isFetching: false }),
  };
});

function buildContext(
  currentOpeningHours: string | null = "Mo-Fr 09:00-17:00",
): OsmContributionContext {
  return {
    ref: { type: "node", id: 12 },
    version: 4,
    geometry: "point",
    center: { lat: 52.5, lon: 13.4 },
    displayName: "Café Central",
    currentPreset: { status: "matched", presetId: "amenity/cafe", name: "Cafe" },
    fields: [
      {
        kind: "text",
        field: "openingHours",
        label: "Opening hours",
        currentValue: currentOpeningHours,
        maxCodePoints: 255,
        enabled: true,
      },
    ],
    advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=12",
    elementUrl: "https://www.openstreetmap.org/node/12",
    fetchedAt: "2026-08-10T09:00:00.000Z",
  };
}

function Harness({
  currentOpeningHours = "Mo-Fr 09:00-17:00",
}: {
  currentOpeningHours?: string | null;
}) {
  const context = buildContext(currentOpeningHours);
  const [state, dispatch] = useReducer(osmContributionReducer, undefined, () => {
    const s1 = osmContributionReducer(initialOsmContributionState, {
      type: "open",
      intent: "edit",
    });
    const s2 = osmContributionReducer(s1, { type: "contextLoaded", context });
    return osmContributionReducer(s2, { type: "selectField", field: "openingHours" });
  });

  if (state.step !== "edit") return null;

  return (
    <div>
      <OsmContributionForm
        context={state.context}
        draft={state.draft}
        locale="en"
        dispatch={dispatch}
      />
      <output data-testid="serialized-changes">
        {JSON.stringify(selectedChanges(state.draft))}
      </output>
      <output data-testid="draft-error">{state.draft.errors.openingHours ?? ""}</output>
    </div>
  );
}

async function nudgeHour(field: HTMLElement | undefined, key: string) {
  if (!field) throw new Error("expected a time field");
  await userEvent.click(field);
  screen.getByRole("slider").focus();
  await userEvent.keyboard(key);
  await userEvent.click(screen.getByRole("button", { name: "timePicker.ok" }));
}

describe("OpeningHoursControl", () => {
  it("applies quick presets and updates the live OSM preview", async () => {
    render(<Harness />);
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe("Mo-Fr 09:00-17:00");

    await userEvent.click(screen.getByText("osmContributions.ohPreset24_7"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe("24/7");
    expect(JSON.parse(screen.getByTestId("serialized-changes").textContent ?? "[]")).toEqual([
      { field: "openingHours", action: "set", value: "24/7" },
    ]);

    await userEvent.click(screen.getByText("osmContributions.ohPresetMonSat"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Fr 09:00-18:00; Sa 09:00-14:00",
    );
  });

  it("toggles weekday and holiday chips and compacts consecutive days", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 09:00-17:00" />);

    // Click Saturday chip -> Mo-Sa 09:00-17:00
    await userEvent.click(screen.getByText("osmContributions.ohDaySa"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe("Mo-Sa 09:00-17:00");

    // Click Public holidays (PH) chip -> Mo-Sa,PH 09:00-17:00
    await userEvent.click(screen.getByText("osmContributions.ohHolidayPH"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Sa,PH 09:00-17:00",
    );

    // Click School holidays (SH) chip and enable SH AND mode -> SH Mo-Sa,PH 09:00-17:00
    await userEvent.click(screen.getByText("osmContributions.ohHolidaySH"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Sa,SH,PH 09:00-17:00",
    );
    await userEvent.click(screen.getByLabelText("osmContributions.ohHolidayShAndMode"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "SH Mo-Sa,PH 09:00-17:00",
    );
  });

  it("adds and edits multiple rules, holiday rules, and fallback rules", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 09:00-17:00" />);

    await userEvent.click(screen.getByText("osmContributions.ohAddHolidayRule"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Fr 09:00-17:00; PH off",
    );

    await userEvent.click(screen.getByText("osmContributions.ohAddFallbackRule"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Fr 09:00-17:00; PH off || Mo-Fr 09:00-17:00",
    );
  });

  it("supports multiple time spans, extended next-day hours, and comments", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 08:00-34:00" />);

    // Add second time span -> Mo-Fr 08:00-34:00,09:00-17:00
    await userEvent.click(screen.getByText("+ osmContributions.ohAddTimeSpan"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Fr 08:00-34:00,09:00-17:00",
    );

    // Only the closing time already past 24:00 offers next day (+24h)
    const nextDayBoxes = screen.getAllByLabelText("osmContributions.ohNextDayHint");
    expect(nextDayBoxes).toHaveLength(1);
    const [nextDayCheckbox] = nextDayBoxes;
    if (!nextDayCheckbox) throw new Error("expected next day checkbox");
    expect((nextDayCheckbox as HTMLInputElement).checked).toBe(true);
    await userEvent.click(nextDayCheckbox);
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "Mo-Fr 08:00-10:00,09:00-17:00",
    );
    expect(screen.queryByLabelText("osmContributions.ohNextDayHint")).toBeNull();

    // Enter a rule comment
    const commentInput = screen.getByLabelText("osmContributions.ohCommentLabel");
    fireEvent.change(commentInput, { target: { value: "kitchen until 22:00" } });
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      'Mo-Fr 08:00-10:00,09:00-17:00 "kitchen until 22:00"',
    );
  });

  it.each(["Mo-Fr 09:00-17:00", "Fr 18:00-02:00"])("offers no next day (+24h) for %s", (value) => {
    render(<Harness currentOpeningHours={value} />);
    expect(screen.queryByLabelText("osmContributions.ohNextDayHint")).toBeNull();
  });

  it("supports advanced year, month, date, week, and nth-weekday constraints", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 09:00-17:00" />);

    // Open Advanced accordion
    await userEvent.click(screen.getByText("osmContributions.ohAdvancedConstraints"));

    // Add year constraint
    await userEvent.click(screen.getByText("+ osmContributions.ohAddYearRange"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "2025 Mo-Fr 09:00-17:00",
    );

    // Add month constraint
    await userEvent.click(screen.getByText("+ osmContributions.ohAddMonthRange"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "2025 Apr-Oct Mo-Fr 09:00-17:00",
    );

    // Add week constraint
    await userEvent.click(screen.getByText("+ osmContributions.ohAddWeekRange"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "2025 Apr-Oct week 01-53/2 Mo-Fr 09:00-17:00",
    );
  });

  it("switches bi-directionally between Visual builder and OSM syntax mode and flags invalid syntax", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 09:00-17:00" />);

    // Switch to Raw mode
    await userEvent.click(screen.getByText("osmContributions.ohModeRaw"));
    const rawInput = screen.getByLabelText("osmContributions.ohRawInputLabel");

    fireEvent.change(rawInput, { target: { value: "not valid syntax" } });
    expect(screen.getByTestId("draft-error").textContent).toBe("INVALID_SYNTAX");

    // Switching to Visual mode when syntax is invalid displays the warning banner
    await userEvent.click(screen.getByText("osmContributions.ohModeVisual"));
    expect(screen.getByText("osmContributions.ohParseErrorBanner")).not.toBeNull();

    // Switch back to Raw mode and enter a complex valid OSM opening_hours string
    const [firstRawButton] = screen.getAllByText("osmContributions.ohModeRaw");
    if (!firstRawButton) throw new Error("expected raw mode button");
    await userEvent.click(firstRawButton);

    const rawInputAgain = screen.getByLabelText("osmContributions.ohRawInputLabel");
    fireEvent.change(rawInputAgain, {
      target: { value: "easter -2 days-easter +1 day: 10:00-18:00" },
    });
    expect(screen.getByTestId("draft-error").textContent).toBe("");

    // Switch back to Visual mode -> renders the parsed rule and preserves canonical string
    await userEvent.click(screen.getByText("osmContributions.ohModeVisual"));
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
      "easter -2 days-easter +1 day: 10:00-18:00",
    );
  });

  it("edits times on the clock field and keeps a past-midnight end on the next day", async () => {
    render(<Harness currentOpeningHours="Fr 18:00-26:30" />);
    const [opens, closes] = screen.getAllByRole("textbox", { name: /timePicker\.open/ });

    await nudgeHour(closes, "{ArrowUp}");
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe("Fr 18:00-27:30");

    await nudgeHour(opens, "{ArrowDown}");
    expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe("Fr 17:00-27:30");
  });

  it("closes at 24:00 when the closing time reaches midnight", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    try {
      render(<Harness currentOpeningHours="Mo-Su 10:00-23:00" />);
      const closes = () => screen.getAllByRole("textbox", { name: /timePicker\.open/ })[1];

      await nudgeHour(closes(), "{ArrowUp}");
      expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
        "Mo-Su 10:00-24:00",
      );
      expect(screen.getByDisplayValue("24:00")).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: "osmContributions.ohNextDayHint" })).toBeNull();

      await nudgeHour(closes(), "{ArrowUp}");
      expect(screen.getByTestId("opening-hours-live-preview").textContent).toBe(
        "Mo-Su 10:00-01:00",
      );
    } finally {
      useSettingsStore.setState({ timeFormat: "auto" });
    }
  });

  it("supports explicit removal and undo via RemoveToggle", async () => {
    render(<Harness currentOpeningHours="Mo-Fr 09:00-17:00" />);

    await userEvent.click(screen.getByText("osmContributions.removeValue"));
    expect(JSON.parse(screen.getByTestId("serialized-changes").textContent ?? "[]")).toEqual([
      { field: "openingHours", action: "remove" },
    ]);

    await userEvent.click(screen.getByText("osmContributions.undoRemove"));
    expect(JSON.parse(screen.getByTestId("serialized-changes").textContent ?? "[]")).toEqual([]);
  });
});
