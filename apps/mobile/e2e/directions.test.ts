import { by, device, element } from "detox";

describe("Directions", () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it("should open directions panel", async () => {
    await element(by.id("directions-button")).tap();
    await waitFor(element(by.id("directions-panel")))
      .toBeVisible()
      .withTimeout(3000);
  });

  it("should show mode selector", async () => {
    await element(by.id("directions-button")).tap();
    await waitFor(element(by.id("mode-selector")))
      .toBeVisible()
      .withTimeout(3000);
  });
});
