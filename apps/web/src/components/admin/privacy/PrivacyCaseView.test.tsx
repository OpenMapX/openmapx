import { createApiClient } from "@openmapx/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privacyAdminQueries } from "@/lib/admin/privacyAdmin";
import { createTestQueryClient } from "@/test/query";
import { PrivacyCaseView } from "./PrivacyCaseView";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());

describe("privacy case view", () => {
  it("explains a refused move into work when the server has no identity check", async () => {
    // The page still shows the case as verified, but the server knows better.
    const detail = privacyDetail();
    detail.request.identityMethod = "manual";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privacyJson({ code: "IDENTITY_REQUIRED" }, 409)),
    );
    const api = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <PrivacyCaseView
          detail={detail}
          binding={{
            client: api,
            apiOrigin: "http://privacy.test",
            actorId: "synthetic-worker",
            queries: privacyAdminQueries(api, "http://privacy.test", "synthetic-worker"),
          }}
          section="decisions"
          onSectionChange={() => {}}
          onRefresh={() => {}}
        />
      </QueryClientProvider>,
    );

    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.caseDecision"));
    fireEvent.click(
      await screen.findByRole("option", { name: "privacyAdmin.workflows.caseStates.in_progress" }),
    );
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.decisionReason"), {
      target: { value: "scope-reviewed" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "privacyAdmin.workflows.recordCaseDecision" }),
    );

    expect(
      await screen.findByText(/privacyAdmin\.workflows\.identityRequired/),
    ).toBeInTheDocument();
  });
});
