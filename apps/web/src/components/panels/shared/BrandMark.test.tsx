import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("routes external brand images through the backend image proxy", () => {
    const markup = renderToStaticMarkup(
      <BrandMark
        branding={{
          name: "Entur Mobility",
          logoUrl: "https://api.entur.io/mobility/assets/operator.svg",
        }}
      />,
    );

    expect(markup).toContain(
      "http://localhost:3001/api/image-proxy?url=https%3A%2F%2Fapi.entur.io%2Fmobility%2Fassets%2Foperator.svg",
    );
    expect(markup).not.toContain('src="https://api.entur.io');
  });
});
