// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminPageHeader } from "../AdminPageHeader";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

describe("AdminPageHeader", () => {
  it("renders an accessible back link for detail pages", () => {
    const markup = renderToStaticMarkup(
      <AdminPageHeader title="User details" backHref="/admin/users" backLabel="Back to users" />,
    );
    expect(markup).toContain('href="/admin/users"');
    expect(markup).toContain('aria-label="Back to users"');
  });
});
