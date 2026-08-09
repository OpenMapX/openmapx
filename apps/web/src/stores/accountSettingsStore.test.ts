import { afterEach, describe, expect, it } from "vitest";
import { useAccountSettingsStore } from "./accountSettingsStore";

afterEach(() => {
  useAccountSettingsStore.getState().close();
});

describe("useAccountSettingsStore", () => {
  it("opens account settings at the requested timeline section", () => {
    useAccountSettingsStore.getState().show("timeline");

    expect(useAccountSettingsStore.getState()).toMatchObject({
      open: true,
      section: "timeline",
    });
  });

  it("opens the default account settings view and clears all state on close", () => {
    useAccountSettingsStore.getState().show();
    expect(useAccountSettingsStore.getState()).toMatchObject({ open: true, section: null });

    useAccountSettingsStore.getState().close();

    expect(useAccountSettingsStore.getState()).toMatchObject({ open: false, section: null });
  });
});
