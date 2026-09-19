import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "exitNumber") return `Exit ${String(values?.number ?? "")}`;
    if (key === "toward") return `toward ${String(values?.places ?? "")}`;
    return key;
  },
}));

import { ExitSignStrip } from "./ExitSignStrip";

const a57Sign = {
  exitNumbers: ["20"],
  exitBranches: ["A 46"],
  exitToward: ["Neuss-Zentrum"],
  exitNames: ["Kreuz Neuss-West"],
};

describe("ExitSignStrip", () => {
  it("shows the exit number, the shield and the toward places, not the interchange name", () => {
    const html = renderToStaticMarkup(<ExitSignStrip sign={a57Sign} country="DE" />);
    expect(html).toContain(">Exit 20<");
    expect(html).toContain('aria-label="A 46"');
    expect(html).toContain("Neuss-Zentrum");
    expect(html).not.toContain("Kreuz Neuss-West");
  });

  it("falls back to the exit name when there is no toward list", () => {
    const html = renderToStaticMarkup(
      <ExitSignStrip
        sign={{ exitNumbers: ["20"], exitNames: ["Kreuz Neuss-West"] }}
        country="DE"
      />,
    );
    expect(html).toContain("Kreuz Neuss-West");
  });

  it("caps the toward list at three towns", () => {
    const html = renderToStaticMarkup(
      <ExitSignStrip sign={{ exitToward: ["Köln", "Bonn", "Aachen", "Heinsberg"] }} country="DE" />,
    );
    expect(html).toContain("Aachen");
    expect(html).not.toContain("Heinsberg");
  });

  it("renders nothing for an empty sign", () => {
    expect(renderToStaticMarkup(<ExitSignStrip sign={{}} country="DE" />)).toBe("");
  });
});
