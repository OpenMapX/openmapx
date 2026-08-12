import type * as maplibregl from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { createWildfirePopupController } from "./popup-controller";

function popup() {
  return { remove: vi.fn() } as unknown as maplibregl.Popup;
}

describe("wildfire popup lease coordinator", () => {
  it("ignores cleanup from an old same-source mount after its popup is replaced", () => {
    const controller = createWildfirePopupController();
    const oldMountLease = {};
    const newMountLease = {};
    const oldPopup = popup();
    const newPopup = popup();

    controller.open(oldMountLease, oldPopup);
    controller.open(newMountLease, newPopup);
    controller.close(oldMountLease);

    expect(oldPopup.remove).toHaveBeenCalledTimes(1);
    expect(newPopup.remove).not.toHaveBeenCalled();

    controller.close(newMountLease);
    controller.close(newMountLease);
    expect(newPopup.remove).toHaveBeenCalledTimes(1);
  });

  it("replaces a different layer lease and disposes the current popup exactly once", () => {
    const controller = createWildfirePopupController();
    const firmsLease = {};
    const noaaLease = {};
    const firmsPopup = popup();
    const noaaPopup = popup();

    controller.open(firmsLease, firmsPopup);
    controller.open(noaaLease, noaaPopup);
    controller.close(firmsLease);
    controller.closeAll();
    controller.close(noaaLease);
    controller.closeAll();

    expect(firmsPopup.remove).toHaveBeenCalledTimes(1);
    expect(noaaPopup.remove).toHaveBeenCalledTimes(1);
  });
});
