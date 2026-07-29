import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMPACT_ALERT_SX, CompactAlert } from "../CompactAlert";
import { CompactAlertList, type CompactAlertListItem } from "../CompactAlertList";

const items: CompactAlertListItem[] = [
  {
    id: "one",
    severity: "error",
    message: "First issue",
    href: "/admin/first",
    actionLabel: "View",
  },
  {
    id: "two",
    severity: "warning",
    message: "Second issue",
    href: "/admin/second",
    actionLabel: "Open",
  },
  {
    id: "three",
    severity: "warning",
    message: "Third issue",
    href: "/admin/third",
    actionLabel: "Open",
  },
  {
    id: "four",
    severity: "warning",
    message: "Fourth issue",
    href: "/admin/fourth",
    actionLabel: "Open",
  },
];

describe("CompactAlertList", () => {
  it("keeps standalone information notices compact", () => {
    const markup = renderToStaticMarkup(
      <CompactAlert severity="info" variant="outlined">
        Configuration is managed externally.
      </CompactAlert>,
    );

    expect(markup).toContain("Configuration is managed externally.");
    expect(COMPACT_ALERT_SX).toMatchObject({ py: 0 });
    expect(COMPACT_ALERT_SX["& .MuiAlert-action"]).toMatchObject({
      alignItems: "center",
      pt: 0,
    });
  });

  it("uses the same compact rows and collapse control for every item set", () => {
    const markup = renderToStaticMarkup(
      <CompactAlertList items={items} expanded={false} onExpandedChange={() => undefined} />,
    );

    expect(markup).toContain("First issue");
    expect(markup).toContain('href="/admin/second"');
    expect(markup).not.toContain("Fourth issue");
    expect(markup).toContain("Show 1 more");
  });

  it("shows all rows when expanded", () => {
    const markup = renderToStaticMarkup(
      <CompactAlertList items={items} expanded onExpandedChange={() => undefined} />,
    );

    expect(markup).toContain("Fourth issue");
    expect(markup).toContain("Show less");
  });
});
