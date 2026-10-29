import type { ManeuverSign } from "@openmapx/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "in") return `In ${String(values?.distance ?? "")}`;
    if (key === "then") return `Then ${String(values?.instruction ?? "")}`;
    if (key === "thenLabel") return "Then";
    if (key === "exitNumber") return `Exit ${String(values?.number ?? "")}`;
    if (key === "toward") return `toward ${String(values?.places ?? "")}`;
    return key;
  },
}));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatMeasurementDistance: (m: number, sys: string) =>
    sys === "imperial" ? `${m} ft` : `${m} m`,
  // Passthrough: the lanes already carry valid/active flags in these tests.
  resolveGuidanceLanes: (lanes?: unknown[]) => lanes ?? [],
  visibleToward: (list: string[], max = 3) => list.slice(0, max),
  signHeadline: (sign?: { exitToward?: string[]; exitNames?: string[] }) =>
    sign?.exitToward?.length ? sign.exitToward : (sign?.exitNames ?? []),
  refKind: () => "motorway",
}));

import { lowercaseFirstWord, ManeuverBanner } from "./ManeuverBanner";

describe("lowercaseFirstWord", () => {
  it("lowercases the leading verb so it reads mid-sentence after 'Then'", () => {
    expect(lowercaseFirstWord("Take exit 21.")).toBe("take exit 21.");
    expect(lowercaseFirstWord("Keep left to stay on A 57")).toBe("keep left to stay on A 57");
    expect(lowercaseFirstWord("Über die Brücke")).toBe("über die Brücke");
  });

  it("leaves refs/acronyms (no lowercase second letter) untouched", () => {
    expect(lowercaseFirstWord("B 477 toward …")).toBe("B 477 toward …");
    expect(lowercaseFirstWord("")).toBe("");
  });
});

describe("ManeuverBanner", () => {
  function bannerWithSign(instruction: string, sign: ManeuverSign) {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ManeuverBanner
        instruction={instruction}
        distanceToManeuver={9200}
        maneuver={{ type: "turn", modifier: "right" }}
        sign={sign}
        country="DE"
        units="metric"
      />,
    );
    return container;
  }

  const exit20: ManeuverSign = {
    exitNumbers: ["20"],
    exitBranches: ["A 46"],
    exitToward: ["Heinsberg", "Aachen", "Neuss-Holzheim"],
    exitNames: ["Kreuz Neuss-West"],
  };

  it("shows the screenshot's destinations only in the full instruction, retaining badges", () => {
    const instruction = "Take exit 20 onto A 46 toward Heinsberg/Aachen/Neuss-Holzheim.";
    const container = bannerWithSign(instruction, exit20);
    const strip = container.querySelector('[data-testid="exit-sign-strip"]');
    expect(strip?.textContent).toBe("Exit 20A 46");
    expect(strip?.querySelector('[aria-label="A 46"]')).not.toBeNull();
    expect(container.textContent).toContain(instruction);
    expect(container.textContent?.match(/Heinsberg/g)).toHaveLength(1);
    expect(container.textContent).not.toContain("Kreuz Neuss-West");
  });

  it("preserves the screenshot's distinct interchange name and keep-left instruction", () => {
    const instruction = "Keep left to take exit 11 onto A 44.";
    const container = bannerWithSign(instruction, {
      exitNumbers: ["11"],
      exitBranches: ["A 44"],
      exitNames: ["Kreuz Holz"],
    });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toContain(
      "Kreuz Holz",
    );
    expect(container.textContent).toContain(instruction);
  });

  it.each([
    "Take exit 20 toward HEINSBERG / AACHEN / NEUSS-HOLZHEIM.",
    "Take exit 20 toward Heinsberg · Aachen · Neuss-Holzheim.",
    "Take exit 20 toward Heinsberg; Aachen; Neuss-Holzheim.",
    "Take exit 20 toward Heinsberg, Aachen, Neuss-Holzheim.",
  ])("recognizes the same destinations with different case or separators: %s", (instruction) => {
    const container = bannerWithSign(instruction, exit20);
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toBe(
      "Exit 20A 46",
    );
    expect(container.textContent).toContain(instruction);
  });

  it("recognizes equivalent Unicode spelling and whitespace without changing the instruction", () => {
    const instruction = "Take exit 20 toward KO\u0308LN / Bad\u00a0  Münstereifel.";
    const container = bannerWithSign(instruction, {
      ...exit20,
      exitToward: ["Köln", "Bad Münstereifel"],
    });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toBe(
      "Exit 20A 46",
    );
    expect(container.textContent).toContain(instruction);
  });

  it("keeps the whole headline when only some destinations are repeated", () => {
    const container = bannerWithSign("Take exit 20 toward Heinsberg/Aachen.", exit20);
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toContain(
      "Heinsberg · Aachen · Neuss-Holzheim",
    );
  });

  it("recognizes a localized instruction and literal punctuation inside place names", () => {
    const instruction = "Rechts halten Richtung Frankfurt (Oder)/Bad Münstereifel.";
    const container = bannerWithSign(instruction, {
      ...exit20,
      exitToward: ["Frankfurt (Oder)", "Bad Münstereifel"],
    });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toBe(
      "Exit 20A 46",
    );
    expect(container.textContent).toContain(instruction);
  });

  it.each([
    ["Köln", "Koln"],
    ["Frankfurt (Oder)", "Frankfurt XOderY"],
  ])("keeps uncertain spelling differences: %s versus %s", (name, otherName) => {
    const container = bannerWithSign(`Take exit 20 toward ${otherName}.`, {
      ...exit20,
      exitToward: [name],
    });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toContain(name);
  });

  it.each(["Aachener Straße", "Aachen-West", "Großaachen", "Aachen’s center"])(
    "keeps a place name when the instruction only contains a longer name: %s",
    (place) => {
      const container = bannerWithSign(`Take exit 20 toward ${place}.`, {
        ...exit20,
        exitToward: ["Aachen"],
      });
      expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toContain(
        "Aachen",
      );
    },
  );

  it("keeps uncertain empty names and unmatched destinations beyond the three-town cap", () => {
    for (const exitToward of [
      ["Heinsberg", ""],
      ["Heinsberg", "Aachen", "Neuss-Holzheim", "Köln"],
    ]) {
      const container = bannerWithSign("Take exit 20 toward Heinsberg/Aachen/Neuss-Holzheim.", {
        ...exit20,
        exitToward,
      });
      expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toContain(
        "Heinsberg",
      );
    }
  });

  it("deduplicates an exit-name fallback without exposing another interchange name", () => {
    const container = bannerWithSign("Take exit 20 toward Kreuz Holz.", {
      exitNumbers: ["20"],
      exitNames: ["Kreuz Holz"],
    });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')?.textContent).toBe("Exit 20");
  });

  it("omits an otherwise empty sign row when its headline repeats the instruction", () => {
    const container = bannerWithSign("Keep right toward Aachen.", { exitToward: ["Aachen"] });
    expect(container.querySelector('[data-testid="exit-sign-strip"]')).toBeNull();
    expect(container.textContent).toContain("Keep right toward Aachen.");
  });

  it("renders the instruction and distance to the maneuver", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        units="metric"
      />,
    );
    expect(html).toContain("Turn right onto Main St");
    expect(html).toContain("300 m");
  });

  it("omits the next-step preview when no next step is given", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        units="metric"
      />,
    );
    expect(html).not.toContain("Then ");
  });

  it("renders a next-step preview when a next step is given", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        nextInstruction="Turn left onto 2nd Ave"
        nextManeuver={{ type: "turn", modifier: "left" }}
        units="metric"
      />,
    );
    expect(html).toContain("Then turn left onto 2nd Ave");
  });

  it("puts lanes in the sub-row and the next maneuver in a compact badge", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        nextInstruction="Turn left onto 2nd Ave"
        nextManeuver={{ type: "turn", modifier: "left" }}
        lanes={[
          { indications: ["through"], valid: false },
          { indications: ["right"], valid: true, active: "right" },
        ]}
        units="metric"
      />,
    );
    // Lanes take the sub-row…
    expect(html).toContain('data-valid="true"');
    // …the follow-up shows as the compact "Then" badge (label only, no full line)…
    expect(html).toContain("Then");
    // …so the full next-step instruction text is not spelled out.
    expect(html).not.toContain("2nd Ave");
  });

  it("renders the sign strip between the headline and the instruction", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Take exit 20 toward Neuss-Zentrum"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        sign={{
          exitNumbers: ["20"],
          exitBranches: ["A 46"],
          exitToward: ["Neuss-Zentrum"],
        }}
        country="DE"
        units="metric"
      />,
    );
    const headlineAt = html.indexOf("In 300 m");
    const stripAt = html.indexOf('data-testid="exit-sign-strip"');
    const instructionAt = html.indexOf("Take exit 20");
    expect(stripAt).toBeGreaterThan(headlineAt);
    expect(instructionAt).toBeGreaterThan(stripAt);
    expect(html).toContain("Exit 20");
    expect(html).toContain("Neuss-Zentrum");
  });

  it("keeps the lane sub-row when both sign and lanes are present", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Take exit 20"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        sign={{ exitNumbers: ["20"] }}
        lanes={[
          { indications: ["through"], valid: false },
          { indications: ["right"], valid: true, active: "right" },
        ]}
        units="metric"
      />,
    );
    expect(html).toContain('data-testid="exit-sign-strip"');
    expect(html).toContain('data-valid="true"');
  });
});
