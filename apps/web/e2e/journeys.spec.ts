import { COLORS, DIRECTIONS_URL, expect, expectMapShare, expectRouteDrawn, test } from "./support";

test("cold start renders the basemap with WebGL2", async ({ page }) => {
  await page.goto("/");

  const webgl2 = await page.evaluate(() =>
    Boolean(document.createElement("canvas").getContext("webgl2")),
  );
  expect(webgl2, "WebGL2 is available").toBe(true);
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expectMapShare(page, COLORS.lightWater, 0.9);
  await expect(page.getByText("© OpenStreetMap contributors")).toBeVisible();
});

test("search opens the place card and drops a pin", async ({ page }) => {
  await page.goto("/");
  await expectMapShare(page, COLORS.lightWater, 0.9);

  await page.getByPlaceholder("Search OpenMapX").fill("Fixture");
  await page.getByRole("option", { name: /Fixture Harbour/ }).click();

  await expect(page.getByRole("heading", { name: "Fixture Harbour, Testport" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".maplibregl-marker").first()).toBeVisible();
  await expect(page).toHaveURL(/13\.405/);
});

test("a directions link draws the route and its card", async ({ page }) => {
  await page.goto(DIRECTIONS_URL);

  await expect(page.getByText("Best route")).toBeVisible();
  await expect(page.getByText("4.2 km")).toBeVisible();
  await expect(page.getByText("14 min").first()).toBeVisible();
  await expectRouteDrawn(page);
});

test("style switches keep the route on the map", async ({ page }) => {
  await page.goto(DIRECTIONS_URL);
  await expectRouteDrawn(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expectMapShare(page, COLORS.darkWater, 0.5);
  await expectRouteDrawn(page);

  await page
    .getByRole("button", { name: /layers/i })
    .first()
    .click();
  await page.getByRole("button", { name: "Satellite" }).click();
  await expectMapShare(page, COLORS.satellite, 0.5);
  await expectRouteDrawn(page);

  await page.getByRole("button", { name: "Default" }).click();
  await expectMapShare(page, COLORS.darkWater, 0.5);
  await expectRouteDrawn(page);
});
