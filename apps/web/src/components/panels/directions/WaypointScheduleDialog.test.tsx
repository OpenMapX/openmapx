import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";

// Interpolating override: the shared mock returns the bare key, but these tests
// need to see the resolved time zone substituted into the hint.
vi.mock("next-intl", async () => {
  const { mockNextIntl } = await import("@/test/intl");
  const useTranslations = (namespace?: string) => {
    const t = (key: string, values?: Record<string, string>) => {
      const name = namespace ? `${namespace}.${key}` : key;
      return values
        ? `${name}(${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : name;
    };
    t.rich = t;
    t.markup = t;
    t.raw = t;
    t.has = () => true;
    return t;
  };
  return mockNextIntl({ useTranslations });
});

import { describeSchedule, WaypointScheduleDialog } from "./WaypointScheduleDialog";

const COLOGNE: [number, number] = [6.96, 50.94];

describe("describeSchedule", () => {
  const time = (iso: string) => iso.slice(11, 16);

  it("is null for an absent or empty schedule", () => {
    expect(describeSchedule(undefined, time)).toBeNull();
    expect(describeSchedule({}, time)).toBeNull();
  });

  it("summarises a window and a dwell together", () => {
    expect(describeSchedule({ fixedAt: "2026-09-01T14:00", dwellSeconds: 1800 }, time)).toBe(
      "14:00 · 30 min",
    );
  });

  it("summarises a dwell on its own", () => {
    expect(describeSchedule({ dwellSeconds: 600 }, time)).toBe("10 min");
  });

  it("prefers the appointment over the other window fields", () => {
    expect(
      describeSchedule({ fixedAt: "2026-09-01T14:00", arriveBy: "2026-09-01T13:00" }, time),
    ).toBe("14:00");
  });
});

describe("WaypointScheduleDialog", () => {
  function renderDialog(props: Partial<React.ComponentProps<typeof WaypointScheduleDialog>> = {}) {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <WaypointScheduleDialog
        open
        waypointLabel="Dentist"
        coords={COLOGNE}
        schedule={undefined}
        onSave={onSave}
        onClose={onClose}
        {...props}
      />,
    );
    return { onSave, onClose };
  }

  it("shows the resolved time zone for the coordinate", () => {
    renderDialog();
    expect(screen.getByText(/Europe\/Berlin/)).toBeTruthy();
  });

  it("hides the time input until a constraint kind is chosen", () => {
    renderDialog();
    expect(screen.queryByTestId("schedule-time-input")).toBeNull();
    fireEvent.click(screen.getByLabelText("directions.scheduleArriveBy"));
    expect(screen.getByTestId("schedule-time-input")).toBeTruthy();
  });

  it("saves the chosen kind and dwell with the resolved zone", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByLabelText("directions.scheduleFixedAt"));
    fireEvent.change(screen.getByTestId("schedule-time-input"), {
      target: { value: "2026-09-01T14:00" },
    });
    fireEvent.change(screen.getByTestId("schedule-dwell-input"), { target: { value: "30" } });
    fireEvent.click(screen.getByText("directions.scheduleSave"));
    expect(onSave).toHaveBeenCalledWith({
      fixedAt: "2026-09-01T14:00",
      dwellSeconds: 1800,
      timeZone: "Europe/Berlin",
    });
  });

  it("clears the constraint with null", () => {
    const { onSave } = renderDialog({ schedule: { dwellSeconds: 600 } });
    fireEvent.click(screen.getByText("directions.scheduleClear"));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("saves null when nothing is set at all", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByText("directions.scheduleSave"));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("blocks save on a dwell outside the allowed range", () => {
    const { onSave } = renderDialog();
    fireEvent.change(screen.getByTestId("schedule-dwell-input"), { target: { value: "2000" } });
    fireEvent.click(screen.getByText("directions.scheduleSave"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("directions.scheduleInvalidDwell")).toBeTruthy();
  });

  it("blocks save when a kind is chosen but the time is empty", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByLabelText("directions.scheduleDepartAfter"));
    fireEvent.click(screen.getByText("directions.scheduleSave"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("directions.scheduleInvalidTime")).toBeTruthy();
  });

  it("preloads an existing constraint", () => {
    renderDialog({ schedule: { arriveBy: "2026-09-01T14:00", dwellSeconds: 900 } });
    expect((screen.getByTestId("schedule-time-input") as HTMLInputElement).value).toBe(
      "2026-09-01T14:00",
    );
    expect((screen.getByTestId("schedule-dwell-input") as HTMLInputElement).value).toBe("15");
  });
});
