import { by, device, element } from "detox";

describe("Layers", () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it("should open layer selector", async () => {
    await element(by.id("layer-selector-button")).tap();
    await waitFor(element(by.id("layer-selector-sheet")))
      .toBeVisible()
      .withTimeout(3000);
  });

  it("should switch to satellite view", async () => {
    await element(by.id("layer-selector-button")).tap();
    await waitFor(element(by.id("layer-selector-sheet")))
      .toBeVisible()
      .withTimeout(3000);
    await element(by.id("layer-option-satellite")).tap();
  });
});
