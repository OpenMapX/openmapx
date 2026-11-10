import { ApiClientError } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { savedWriteError } from "./savedWriteError";

describe("savedWriteError", () => {
  it("maps declared account-limit conflicts to their messages", () => {
    expect(
      savedWriteError(new ApiClientError(409, { error: "limit", code: "SAVED_LIST_LIMIT" }, null)),
    ).toEqual({ key: "listLimitReached", values: { count: 500 } });
    expect(
      savedWriteError(new ApiClientError(409, { error: "limit", code: "SAVED_PLACE_LIMIT" }, null)),
    ).toEqual({ key: "placeLimitReached", values: { count: 50_000 } });
  });

  it("falls back to the generic message for anything undeclared", () => {
    for (const error of [
      new ApiClientError(409, { error: "limit", code: "SOMETHING_ELSE" }, null),
      new ApiClientError(500, { error: "Internal server error" }, null),
      new TypeError("network"),
    ]) {
      expect(savedWriteError(error)).toEqual({ key: "saveFailed" });
    }
  });
});
