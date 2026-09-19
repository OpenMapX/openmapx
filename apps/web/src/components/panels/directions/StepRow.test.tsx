import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const { StepRow } = await import("./StepRow");

const base = {
  instruction: "Take exit 20 toward Neuss-Zentrum",
  distance: 400,
  duration: 30,
  units: "metric" as const,
};

describe("StepRow", () => {
  it("renders the instruction and duration line", () => {
    const html = renderToStaticMarkup(<StepRow {...base} />);
    expect(html).toContain("Take exit 20 toward Neuss-Zentrum");
    expect(html).not.toContain('data-testid="exit-sign-strip"');
  });

  it("renders the compact sign strip when a sign is given", () => {
    const html = renderToStaticMarkup(
      <StepRow
        {...base}
        sign={{ exitNumbers: ["20"], exitToward: ["Neuss-Zentrum"] }}
        country="DE"
      />,
    );
    expect(html).toContain('data-testid="exit-sign-strip"');
    expect(html).toContain("Neuss-Zentrum");
  });

  it("renders lane guidance cells when lanes are given", () => {
    const html = renderToStaticMarkup(
      <StepRow
        {...base}
        lanes={[
          { indications: ["straight"], valid: false },
          { indications: ["right"], valid: true, active: "right" },
        ]}
        maneuver={{ type: "turn", modifier: "right" }}
      />,
    );
    expect(html).toContain('data-valid="true"');
    expect(html).toContain('data-valid="false"');
  });
});
