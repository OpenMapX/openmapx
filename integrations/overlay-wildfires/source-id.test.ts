import { describe, expect, it } from "vitest";
import { isSourceId } from "./source-id.js";

describe("isSourceId", () => {
  it.each(["us-nifc-fires", "nasa-firms-viirs-fires", "eu.effis:2"])("accepts %s", (id) => {
    expect(isSourceId(id)).toBe(true);
  });

  it.each(["", "us nifc", "<script>", "a,b", 42, null])("rejects %s", (value) => {
    expect(isSourceId(value)).toBe(false);
  });
});
