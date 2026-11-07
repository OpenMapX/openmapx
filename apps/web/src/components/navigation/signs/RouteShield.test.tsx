import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RouteShield } from "./RouteShield";

describe("RouteShield", () => {
  it("renders the German motorway palette for a ref with a space", () => {
    render(<RouteShield roadRef="A 57" country="DE" />);
    expect(screen.getByRole("img", { name: "A 57" })).toHaveStyle({
      backgroundColor: "#154889",
    });
  });

  it("uses the green palette for US interstates", () => {
    render(<RouteShield roadRef="I-95" country="US" />);
    expect(screen.getByRole("img", { name: "I-95" })).toHaveStyle({
      backgroundColor: "#006b3f",
    });
  });

  it("matches the country code in either case", () => {
    render(<RouteShield roadRef="I-95" country="us" />);
    expect(screen.getByRole("img", { name: "I-95" })).toHaveStyle({
      backgroundColor: "#006b3f",
    });
  });

  it("uses the yellow palette for federal refs", () => {
    render(<RouteShield roadRef="B 9" country="DE" />);
    expect(screen.getByRole("img", { name: "B 9" })).toHaveStyle({
      backgroundColor: "#f4c542",
    });
  });

  it("falls back to the EU default palette without a country", () => {
    render(<RouteShield roadRef="A 57" country={null} />);
    expect(screen.getByRole("img", { name: "A 57" })).toHaveStyle({
      backgroundColor: "#154889",
    });
  });
});
