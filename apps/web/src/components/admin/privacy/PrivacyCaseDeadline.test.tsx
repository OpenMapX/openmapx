import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrivacyCaseDecisionForms } from "./PrivacyCaseDecisionForms";
import { privacyDetail } from "./privacyFixtures.test-support";
import { renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

describe("case deadlines", () => {
  it("shows the deadlines in the request's time zone, the zone the line names", () => {
    const base = privacyDetail();
    // Midnight UTC is 14:00 the same day only at UTC+14, so the browser's own
    // zone can never produce this text.
    const detail = {
      ...base,
      request: {
        ...base.request,
        timeZone: "Pacific/Kiritimati",
        originalDueAt: "2026-10-01T00:00:00.000Z",
        dueAt: "2026-10-15T00:00:00.000Z",
      },
    };
    renderPrivacyComponent(detail, (client) => (
      <PrivacyCaseDecisionForms detail={detail} client={client} />
    ));
    expect(
      screen.getByText(/^Original deadline: 10\/01\/2026, 02:00\sPM · Pacific\/Kiritimati$/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Current deadline: 10\/15\/2026, 02:00\sPM · Pacific\/Kiritimati$/),
    ).toBeInTheDocument();
  });
});
