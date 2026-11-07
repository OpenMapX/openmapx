// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPageHeader } from "../AdminPageHeader";

describe("AdminPageHeader", () => {
  it("renders an accessible back link for detail pages", () => {
    const markup = renderToStaticMarkup(
      <AdminPageHeader title="User details" backHref="/admin/users" backLabel="Back to users" />,
    );
    expect(markup).toContain('href="/admin/users"');
    expect(markup).toContain('aria-label="Back to users"');
  });
});
