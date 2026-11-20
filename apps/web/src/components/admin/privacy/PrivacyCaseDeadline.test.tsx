import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PrivacyCaseDecisionForms } from "./PrivacyCaseDecisionForms";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

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

  it("reads the extension fields in the request's time zone, the zone their labels name", async () => {
    const base = privacyDetail();
    const detail = { ...base, request: { ...base.request, timeZone: "Pacific/Kiritimati" } };
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        writes.push(JSON.parse(String((init as RequestInit | undefined)?.body)));
        return privacyJson({ request: detail.request });
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyCaseDecisionForms detail={detail} client={client} />
    ));
    fireEvent.change(screen.getByLabelText("Extend response until (Pacific/Kiritimati)"), {
      target: { value: "2026-11-01T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Actually notified at (Pacific/Kiritimati)"), {
      target: { value: "2026-10-01T00:30" },
    });
    fireEvent.change(screen.getByLabelText("Extension reason code"), {
      target: { value: "documented-reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record notified extension" }));

    // UTC+14 again: no browser zone turns these wall clocks into these instants.
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      extendedUntil: "2026-10-31T20:00:00.000Z",
      extensionNotifiedAt: "2026-09-30T10:30:00.000Z",
    });
    vi.unstubAllGlobals();
  });
});
