import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLogo } from "../BrandLogo";

describe("BrandLogo", () => {
  it("renders a proxied Commons URL when the brand has a logo", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    const img = screen.getByRole("img", { name: "Aldi" });
    expect(img.getAttribute("src")).toContain("/api/image-proxy?url=");
    expect(decodeURIComponent(img.getAttribute("src") ?? "")).toContain("Special:FilePath");
  });

  it("never points the browser directly at Commons", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    const src = screen.getByRole("img", { name: "Aldi" }).getAttribute("src") ?? "";
    expect(src.startsWith("https://commons.wikimedia.org")).toBe(false);
  });

  it("falls back to the preset icon when the brand has no logo", () => {
    const { container } = render(
      <BrandLogo
        brand={{ qid: "Q1", name: "Nameless", kind: ["brand"] }}
        presetIconKey="maki-shop"
      />,
    );
    expect(screen.queryByRole("img", { name: "Nameless" })).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });
});
