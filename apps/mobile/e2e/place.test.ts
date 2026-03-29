import { by, device, element, expect } from "detox";

describe("Place Detail", () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it("should show place detail with tabs after search", async () => {
    await element(by.id("search-input")).tap();
    await element(by.id("search-input")).typeText("Eiffel Tower");
    await waitFor(element(by.id("autocomplete-list")))
      .toBeVisible()
      .withTimeout(5000);
    await element(by.id("autocomplete-item-0")).tap();
    await waitFor(element(by.id("place-detail-content")))
      .toBeVisible()
      .withTimeout(5000);
    await expect(element(by.text("Overview"))).toBeVisible();
  });
});
