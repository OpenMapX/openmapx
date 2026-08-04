import type { Review } from "@openmapx/core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewCard } from "./ReviewCard";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@openmapx/mangrove-client", () => ({
  fingerprintPem: () => "fingerprint",
}));

const reviewBase: Review = {
  id: "review-1",
  subject: { lat: 50, lng: 6, name: "Test place" },
  author: { kid: "public-key", nickname: "Reviewer" },
  createdAt: "2026-08-04T12:00:00.000Z",
};

function renderReviewImage(src: string): string {
  const existingStyles = new Set(document.head.querySelectorAll("style"));
  const { container } = render(
    <ReviewCard review={{ ...reviewBase, images: [{ src, label: "Review image" }] }} />,
  );
  const emittedStyles = [...document.head.querySelectorAll("style")]
    .filter((style) => !existingStyles.has(style))
    .map((style) => style.textContent ?? "")
    .join("\n");
  return `${container.innerHTML}\n${emittedStyles}`;
}

afterEach(() => cleanup());

describe("ReviewCard image safety", () => {
  it("routes an https review image through the backend proxy", () => {
    const markup = renderReviewImage("https://images.example/review.png");

    expect(markup).toContain("/api/image-proxy?url=https%3A%2F%2Fimages.example%2Freview.png");
    expect(markup).not.toContain('url("https://images.example/review.png")');
  });

  it("drops a protocol-relative image instead of rendering it in CSS", () => {
    const markup = renderReviewImage("//evil.example/x.png");

    expect(markup).not.toContain("background-image");
    expect(markup).not.toContain("evil.example");
  });

  it("drops a CSS-breakout image instead of serializing attacker CSS", () => {
    const markup = renderReviewImage('x"); } body { background: red; } a { content: url("');

    expect(markup).not.toContain("background-image");
    expect(markup).not.toContain("body {");
  });

  it("does not make a javascript image source an anchor href", () => {
    const markup = renderReviewImage("javascript:alert(1)");

    expect(markup).not.toContain('href="javascript:');
  });
});
