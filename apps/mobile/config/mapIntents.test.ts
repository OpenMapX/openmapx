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

describe("Android sign-in callback registration", () => {
  it("claims only the verified HTTPS callback path on the compiled web host", () => {
    expect(config.android?.intentFilters).toContainEqual({
      action: "VIEW",
      autoVerify: true,
      category: ["DEFAULT", "BROWSABLE"],
      data: [{ scheme: "https", host: "openmapx.com", path: "/mobile-auth/callback" }],
    });
  });
});
