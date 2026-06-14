import { describe, expect, it, vi } from "vitest";
import { render } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { NlpUnmappedNotice } from "./NlpFilterChips";

describe("NlpUnmappedNotice", () => {
  it("renders nothing when there are no unmapped attributes", () => {
    const { container } = render(<NlpUnmappedNotice attributes={[]} />);
    expect(container.firstChild).toBe(null);
  });

  it("shows the translated prefix and joins the unmapped attributes", () => {
    const { container } = render(<NlpUnmappedNotice attributes={["best", "instagrammable"]} />);
    // mockNextIntl's t(key) returns the namespaced key, so the prefix is stable.
    expect(container.textContent).toContain("search.couldNotFilterBy");
    expect(container.textContent).toContain("best, instagrammable");
  });

  it("renders a single attribute without a separator", () => {
    const { container } = render(<NlpUnmappedNotice attributes={["cozy"]} />);
    expect(container.textContent).toContain("search.couldNotFilterBy cozy");
    expect(container.textContent).not.toContain(",");
  });
});
