import { afterEach, describe, expect, it } from "vitest";
import { PANEL } from "../panels/ids";
import { getPanel } from "../panels/registry";
import { usePersonalTimelineStore } from "./personalTimelineStore";

afterEach(() => {
  usePersonalTimelineStore.getState().resetForSession();
});

describe("usePersonalTimelineStore", () => {
  it("keeps the selected day when the timeline panel deactivates", () => {
    const store = usePersonalTimelineStore.getState();
    store.setSelectedDate("2026-08-09");
    store.selectEntry("journey-1");

    getPanel(PANEL.TIMELINE)?.onDeactivate?.();

    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: "2026-08-09",
      selectedEntryId: null,
    });
  });

  it("resets both day and selection at a session boundary", () => {
    const store = usePersonalTimelineStore.getState();
    store.setSelectedDate("2026-08-09");
    store.selectEntry("visit-1");

    store.resetForSession();

    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: null,
      selectedEntryId: null,
    });
  });

  it("registers timeline as a sidebar panel", () => {
    expect(getPanel(PANEL.TIMELINE)).toMatchObject({
      id: "timeline",
      layer: "sidebar",
    });
  });
});
