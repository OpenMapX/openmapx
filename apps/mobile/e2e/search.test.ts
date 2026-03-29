import { by, device, element, expect } from "detox";

describe("Search", () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it("should show search bar on home screen", async () => {
    await expect(element(by.id("search-input"))).toBeVisible();
  });

  it("should show autocomplete results when typing", async () => {
    await element(by.id("search-input")).tap();
    await element(by.id("search-input")).typeText("Berlin");
    await waitFor(element(by.id("autocomplete-list")))
      .toBeVisible()
      .withTimeout(5000);
  });

  it("should navigate to place detail on result tap", async () => {
    await element(by.id("search-input")).tap();
    await element(by.id("search-input")).typeText("Berlin");
    await waitFor(element(by.id("autocomplete-list")))
      .toBeVisible()
      .withTimeout(5000);
    await element(by.id("autocomplete-item-0")).tap();
    await waitFor(element(by.id("place-detail-content")))
      .toBeVisible()
      .withTimeout(5000);
  });
});
