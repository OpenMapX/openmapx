import { assert, expect, it } from "vitest";
import { captureOvertureCatalogue } from "../../src/jobs/overture/attribution-capture.js";

it("captures exact trusted acquisition metadata without expanding display credits", () => {
  const a = captureOvertureCatalogue("2026-10-13T00:00:00.000Z");
  expect(a.find((r) => r.sourceId === "foursquare")).toMatchObject({
    retrievedAt: "2026-10-13T00:00:00.000Z",
    attributionText: expect.stringContaining("Foursquare data was transformed"),
  });
  const [first] = a;
  assert.isDefined(first);
  first.name = "Mutated";
  expect(captureOvertureCatalogue("2026-10-13T00:00:00.000Z")[0]?.name).toBe("Overture Maps");
});
