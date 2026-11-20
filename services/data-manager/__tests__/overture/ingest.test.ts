import type postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateOvertureContributors } from "../../src/jobs/overture/ingest.js";

const mocks = { unsafe: vi.fn() };
const sql = { unsafe: mocks.unsafe } as unknown as postgres.Sql;

describe("Overture staged-release contributor validation", () => {
  beforeEach(() => {
    mocks.unsafe.mockReset();
  });

  it("accepts a staged release whose contributors all have manifest attribution", async () => {
    mocks.unsafe.mockResolvedValue([
      { dataset: "AllThePlaces" },
      { dataset: "Foursquare" },
      // A locale-aware database collation can place lowercase `meta` before
      // `Microsoft`; the pull contract uses JavaScript code-point ordering.
      { dataset: "meta" },
      { dataset: "Microsoft" },
      { dataset: "Overture" },
    ]);

    await expect(validateOvertureContributors(sql, "overture_places__staging")).resolves.toEqual([
      "AllThePlaces",
      "Foursquare",
      "Microsoft",
      "Overture",
      "meta",
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

    await expect(validateOvertureContributors(sql, "overture_places__staging")).rejects.toThrow(
      /unsupported contributor dataset\(s\): Unattributed New Dataset/,
    );
  });
});
