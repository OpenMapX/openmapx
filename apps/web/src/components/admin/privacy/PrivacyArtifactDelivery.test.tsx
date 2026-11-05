import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDraftProvider } from "@/lib/admin/AdminDraftProvider";
import * as documentExit from "@/lib/admin/adminDocumentExit";
import { PRIVACY_ADMIN_RESUME_KEY } from "@/lib/admin/privacyReauthentication";
import { useAdminDraft } from "@/lib/admin/useAdminDraft";
import { PrivacyArtifactDelivery } from "./PrivacyArtifactDelivery";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

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

function DirtyDraft() {
  const draft = useAdminDraft({
    id: "privacy-exit",
    baseline: { label: "saved" },
    editableKeys: ["label"],
    signature: "v1",
  });
  return (
    <input
      aria-label="Admin draft"
      value={String(draft.values.label)}
      onChange={(event) => draft.setValues({ label: event.target.value })}
    />
  );
}
it("does not start or retain a privacy reauthentication challenge when the admin chooses Stay", async () => {
  sessionStorage.clear();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("showSaveFilePicker", vi.fn());
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
  const fetcher = vi.fn(async () =>
    privacyJson({
      challengeId: "11111111-1111-4111-8111-111111111111",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      loginPath: "/auth/privacy/admin",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  renderPrivacyComponent(detail, (client) => (
    <AdminDraftProvider>
      <DirtyDraft />
      <PrivacyArtifactDelivery detail={detail} client={client} />
    </AdminDraftProvider>
  ));
  fireEvent.change(screen.getByLabelText("Admin draft"), { target: { value: "unsaved" } });
  fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.deliveryReason"), {
    target: { value: "operator requested" },
  });
  const start = screen.getByRole("button", {
    name: "privacyAdmin.workflows.startAssistedDelivery",
  });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  fireEvent.click(await screen.findByRole("button", { name: "Stay" }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).toBeNull();
  expect(start).not.toBeDisabled();
  const navigate = vi.spyOn(documentExit, "navigateAdminDocument").mockImplementation(() => {});
  fireEvent.click(start);
  fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/auth/privacy/admin", "reauthentication"),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).not.toBeNull();
  navigate.mockRestore();
  sessionStorage.clear();
});
