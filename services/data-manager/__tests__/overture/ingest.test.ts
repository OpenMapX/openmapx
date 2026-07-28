import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unsafe: vi.fn(),
}));

vi.mock("../../src/db/index.js", () => ({
  sql: { unsafe: mocks.unsafe },
}));

import { validateOvertureContributors } from "../../src/jobs/overture/ingest.js";

describe("Overture staged-release contributor validation", () => {
  beforeEach(() => {
    mocks.unsafe.mockReset();
  });

  it("accepts a staged release whose contributors all have manifest attribution", async () => {
    mocks.unsafe.mockResolvedValue([
      { dataset: "AllThePlaces" },
      { dataset: "Foursquare" },
      { dataset: "Meta" },
      { dataset: "Overture" },
    ]);

    await expect(validateOvertureContributors("overture_places__staging")).resolves.toEqual([
      "AllThePlaces",
      "Foursquare",
      "Meta",
      "Overture",
    ]);
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM "overture_places__staging".places'),
      [],
    );
  });

  it("blocks activation when the staged release exposes an unknown contributor", async () => {
    mocks.unsafe.mockResolvedValue([
      { dataset: "Foursquare" },
      { dataset: "Unattributed New Dataset" },
    ]);

    await expect(validateOvertureContributors("overture_places__staging")).rejects.toThrow(
      /unsupported contributor dataset\(s\): Unattributed New Dataset/,
    );
  });
});
