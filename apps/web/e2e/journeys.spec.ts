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

test("a three-stop driving trip starts from the planner, announces and passes the intermediate stop", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    (window as unknown as { __spokenCues: string[] }).__spokenCues = spoken;
    const synth = window.speechSynthesis;
    if (synth) {
      synth.speak = (utterance: SpeechSynthesisUtterance) => {
        if (utterance.text) spoken.push(utterance.text);
        queueMicrotask(() => {
          utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
        });
      };
      synth.cancel = () => {};
      synth.getVoices = () => [];
    }
  });

  // Two ~300 m eastbound legs in the fixture area, with the nav simulator enabled.
  const multiStopUrl =
    "/?panel=directions&mode=driving&navsim=1&wp=52.5100,13.3800,Origin&wp=52.5100,13.3845,Midstop&wp=52.5100,13.3890,Goal";
  await page.goto(multiStopUrl);

  await expect(page.getByText(/Origin→ Midstop/)).toBeVisible();
  await expect(page.getByText(/Midstop→ Goal/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Details" })).toBeVisible();

  await page.getByRole("button", { name: "Start" }).click();

  await expect(page.getByTestId("ground-nav-chrome")).toBeVisible();
  // Speed up simulation so both legs finish within a few seconds.
  await page.getByRole("button", { name: "4×" }).click();

  // First leg announces the intermediate stop in both banner and voice.
  await expect(page.getByTestId("ground-nav-banner")).toContainText("Arrive at stop 1");
  await expect
    .poll(() =>
      page.evaluate(() =>
        ((window as unknown as { __spokenCues?: string[] }).__spokenCues ?? []).some((text) =>
          text.includes("Arrive at stop 1"),
        ),
      ),
    )
    .toBe(true);

  // Passing the intermediate stop advances to leg 2 (final arrival) without ending early.
  await expect(page.getByTestId("ground-nav-banner")).toContainText("You have arrived", {
    timeout: 20_000,
  });

  // Reaching the final destination shows the arrival card.
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 20_000 });
});
