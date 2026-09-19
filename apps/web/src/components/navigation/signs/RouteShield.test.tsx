import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteShield } from "./RouteShield";

describe("RouteShield", () => {
  it("renders the German motorway palette for a ref with a space", () => {
    const html = renderToStaticMarkup(<RouteShield roadRef="A 57" country="DE" />);
    expect(html).toContain("A 57");
    expect(html).toContain('aria-label="A 57"');
    expect(html).toContain('data-bg="#154889"');
  });

  it("uses the green palette for US interstates", () => {
    const html = renderToStaticMarkup(<RouteShield roadRef="I-95" country="US" />);
    expect(html).toContain('data-bg="#006b3f"');
  });

  it("matches the country code in either case", () => {
    // The origin reverse geocode answers in lower case.
    const html = renderToStaticMarkup(<RouteShield roadRef="I-95" country="us" />);
    expect(html).toContain('data-bg="#006b3f"');
  });

  it("uses the yellow palette for federal refs", () => {
    const html = renderToStaticMarkup(<RouteShield roadRef="B 9" country="DE" />);
    expect(html).toContain('data-bg="#f4c542"');
  });

  it("falls back to the EU default palette without a country", () => {
    const html = renderToStaticMarkup(<RouteShield roadRef="A 57" country={null} />);
    expect(html).toContain('data-bg="#154889"');
  });
});
