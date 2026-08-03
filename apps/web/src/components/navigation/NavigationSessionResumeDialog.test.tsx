import type { NavigationSessionSnapshot } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { NavigationSessionResumeDialog } from "./NavigationSessionResumeDialog";

const snapshot = {
  route: { distance: 1000, summary: "via Main Street" },
} as NavigationSessionSnapshot;

function renderDialog(onResume = vi.fn(), onDiscard = vi.fn()) {
  return {
    onResume,
    onDiscard,
    ...render(
      <NextIntlClientProvider locale="en" messages={en}>
        <NavigationSessionResumeDialog
          snapshot={snapshot}
          coverage={{ kind: "route-line-only", packageIds: [] }}
          onResume={onResume}
          onDiscard={onDiscard}
        />
      </NextIntlClientProvider>,
    ),
  };
}

describe("NavigationSessionResumeDialog", () => {
  it("requires explicit confirmation before resuming", () => {
    renderDialog();
    expect(screen.getByTestId("navigation-session-resume-dialog")).toBeDefined();
    expect(screen.getByTestId("navigation-session-resume-dialog").textContent).toContain(
      "The route line is available, but the local map is not covered here.",
    );
  });

  it("calls resume and discard actions", () => {
    const { onResume, onDiscard } = renderDialog();
    screen.getByTestId("navigation-session-resume").click();
    screen.getByTestId("navigation-session-discard").click();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
