import { describe, expect, it, vi } from "vitest";
import { buildWebVisibilityScript } from "./webVisibility";

describe("buildWebVisibilityScript", () => {
  it.each(["background", "inactive", "active"] as const)(
    "maps %s to document visibility",
    (state) => {
      const document = { dispatchEvent: vi.fn() };
      const run = new Function("document", "Event", buildWebVisibilityScript(state));
      run(document, class Event {});
      expect(document).toHaveProperty("hidden", state !== "active");
      expect(document).toHaveProperty("visibilityState", state === "active" ? "visible" : "hidden");
      expect(document.dispatchEvent).toHaveBeenCalledTimes(1);
      run(document, class Event {});
      expect(document.dispatchEvent).toHaveBeenCalledTimes(1);
    },
  );
});
