// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPageHeader } from "../AdminPageHeader";

describe("AdminPageHeader", () => {
  it("renders the title", () => {
    const markup = renderToStaticMarkup(<AdminPageHeader title="Users" />);
    expect(markup).toContain("Users");
  });

  it("renders the subtitle when provided", () => {
    const markup = renderToStaticMarkup(
      <AdminPageHeader title="Users" subtitle="Accounts, roles, bans" />,
    );
    expect(markup).toContain("Accounts, roles, bans");
  });

  it("omits the subtitle when not provided", () => {
    const withSubtitle = renderToStaticMarkup(
      <AdminPageHeader title="Users" subtitle="A subtitle" />,
    );
    const withoutSubtitle = renderToStaticMarkup(<AdminPageHeader title="Users" />);
    // The subtitle text renders only when a subtitle is passed; the title always renders.
    expect(withSubtitle).toContain("A subtitle");
    expect(withoutSubtitle).not.toContain("A subtitle");
    expect(withoutSubtitle).toContain("Users");
  });

  it("renders an actions node when provided", () => {
    const markup = renderToStaticMarkup(
      <AdminPageHeader title="Users" actions={<button type="button">Create</button>} />,
    );
    expect(markup).toContain("Create");
  });
});
