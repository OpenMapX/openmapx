import { expect, it } from "vitest";
import { NO_SOURCES, upstreamCredits } from "../features/record.js";

it("keeps distinct captured terms and required notices for the same upstream publisher", () => {
  const licensing = (namespace: string) => ({
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "Town data",
        license: { kind: "custom", namespace, id: "LicenseRef-Town", name: "Town terms" },
      },
    ],
  });
  const credits = upstreamCredits(
    [
      {
        id: "feed",
        attribution: { provider: "Feed" },
        upstream: [
          { publisher: "Town", attribution: "Credit A", licensing: licensing("town:a") },
          { publisher: "Town", attribution: "Credit B", licensing: licensing("town:b") },
          { publisher: "Town", attribution: "Credit A", licensing: licensing("town:a") },
        ],
      },
    ],
    NO_SOURCES,
  );
  expect(credits).toEqual([
    {
      sourceId: "feed",
      name: "Feed – Town",
      publisher: { name: "Town" },
      attributionText: "Credit A",
      licensing: licensing("town:a"),
    },
    {
      sourceId: "feed",
      name: "Feed – Town",
      publisher: { name: "Town" },
      attributionText: "Credit B",
      licensing: licensing("town:b"),
    },
  ]);
});
