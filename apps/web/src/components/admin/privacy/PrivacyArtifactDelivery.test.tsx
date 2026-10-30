import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyArtifactDelivery } from "./PrivacyArtifactDelivery";
import { privacyDetail } from "./privacyFixtures.test-support";
import { renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
describe("assisted artifact delivery availability", () => {
  it("shows a ready artifact action while denying an unsupported download configuration before ceremony", async () => {
    const detail = privacyDetail();
    detail.request.state = "ready";
    detail.capabilities.assistedDelivery = true;
    detail.artifacts = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        state: "ready",
        filename: "export.zip",
        plaintextBytes: 8,
        expiresAt: "2030-01-01T00:00:00Z",
        readyAt: "2026-10-01T00:00:00Z",
      },
    ];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderPrivacyComponent(detail, (client) => (
      <PrivacyArtifactDelivery detail={detail} client={client} />
    ));
    await waitFor(() =>
      expect(screen.getByText(/privacyAdmin.workflows.downloadUnavailable/)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "privacyAdmin.workflows.startAssistedDelivery" }),
    ).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps representative delivery unavailable without explicit authority and recipient authorization", async () => {
    const detail = privacyDetail();
    detail.artifacts = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        state: "revoked",
        filename: "revoked.zip",
        plaintextBytes: 8,
        expiresAt: "2030-01-01T00:00:00Z",
      },
    ];
    renderPrivacyComponent(detail, (client) => (
      <PrivacyArtifactDelivery detail={detail} client={client} />
    ));
    expect(screen.getByText("privacyAdmin.workflows.artifactNotAuthorized")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "privacyAdmin.workflows.startAssistedDelivery" }),
    ).toBeDisabled();
  });
});
