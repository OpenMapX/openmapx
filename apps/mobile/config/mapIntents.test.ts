import { describe, expect, it } from "vitest";
import config from "../app.config";

describe("Android map chooser registration", () => {
  it("claims VIEW geo links with default and browsable categories, without website verification", () => {
    expect(config.android?.intentFilters).toEqual(
      expect.arrayContaining([
        {
          action: "VIEW",
          category: ["DEFAULT", "BROWSABLE"],
          data: [{ scheme: "geo" }],
        },
      ]),
    );
  });
});
