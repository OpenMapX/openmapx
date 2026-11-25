import { test as base, expect, type Page } from "playwright/test";

type Rgb = readonly [number, number, number];

/** Colours the fixtures and the OpenMapX styles paint, read back from the canvas. */
export const COLORS = {
  /** `water` fill in `openmapx-streets.json`; every fixture tile is one water polygon. */
  lightWater: [0x90, 0xda, 0xee],
  /** `water` fill in `openmapx-dark.json`. */
  darkWater: [0x15, 0x33, 0x3f],
  /** The fixture server's satellite tiles. */
  satellite: [34, 85, 51],
  /** The active route line (`ROUTE_COLORS.active`). */
  route: [0x1a, 0x73, 0xe8],
} as const satisfies Record<string, Rgb>;

/**
 * Collects page errors and console errors for the whole test and fails it if
 * any appeared. That includes the map's own report of an app layer missing
 * after a style change (`[map] "…" should be on the map and is not`), and the
 * browser's line for every request the fixture server answered 404.
 */
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
      });
      await use(errors);
      expect(errors, "page and console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Where the map canvas sits in the viewport. */
export async function mapBox(page: Page) {
  const box = await page.locator("canvas.maplibregl-canvas").boundingBox();
  if (!box) throw new Error("The map canvas is not on the page");
  return box;
}

/**
 * Count pixels in a viewport rectangle within `tolerance` of a colour, from a
 * real screenshot. The PNG is decoded by the page itself, so the journeys need
 * no image library and no hook into the app.
 */
export async function countPixels(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  color: Rgb,
  tolerance = 12,
): Promise<number> {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ data, color, tolerance }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D context");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      // This runs serialized in the page, so it cannot import a helper. Image
      // data always holds four channels per pixel; a missing one is a bug.
      const near = (at: number, target: number) => {
        const value = pixels[at];
        if (value === undefined) throw new Error(`No channel at ${at} of ${pixels.length}`);
        return Math.abs(value - target) <= tolerance;
      };
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (near(index, color[0]) && near(index + 1, color[1]) && near(index + 2, color[2])) {
          count += 1;
        }
      }
      return count;
    },
    { data: png.toString("base64"), color, tolerance },
  );
}

/** The share of the map canvas painted `color`, between 0 and 1. */
export async function mapShare(page: Page, color: Rgb): Promise<number> {
  const box = await mapBox(page);
  const count = await countPixels(page, box, color);
  return count / (Math.round(box.width) * Math.round(box.height));
}

/** Waits until the map shows a colour over at least `share` of its canvas. */
export async function expectMapShare(page: Page, color: Rgb, share: number): Promise<void> {
  await expect
    .poll(() => mapShare(page, color), { message: `map share of rgb(${color})` })
    .toBeGreaterThan(share);
}

/** Waits until at least `minimum` pixels of the map show the active route line. */
export async function expectRouteDrawn(page: Page, minimum = 400): Promise<void> {
  await expect
    .poll(async () => countPixels(page, await mapBox(page), COLORS.route, 24), {
      message: "route line pixels",
    })
    .toBeGreaterThan(minimum);
}

/** A driving route between two points in the fixture area, as a deep link. */
export const DIRECTIONS_URL =
  "/?panel=directions&mode=driving&waypoint=52.51,13.38,Start&waypoint=52.53,13.43,Goal";
