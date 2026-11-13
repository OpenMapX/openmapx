import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({ exportCase: vi.fn() }));
type ExportOptions = {
  onByteChunk: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
};
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("../users/AdminReauthenticationDialog", async () => {
  const { useEffect } = await import("react");
  return {
    // The ceremony itself is covered elsewhere; here it completes at once.
    AdminReauthenticationDialog: ({
      onCompleted,
    }: {
      onCompleted: (proofs: Array<{ challengeId: string }>) => void;
    }) => {
      useEffect(
        () => onCompleted([{ challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }]),
        [onCompleted],
      );
      return null;
    },
  };
});
vi.mock("@openmapx/core/api-admin-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/api-admin-sdk")>()),
  exportPrivacyAdminCase: sdkMocks.exportCase,
  unwrapAdminResponse: (value: unknown) => value,
}));

import { PrivacyExportDownload } from "./PrivacyExportDownload";
import { privacyDetail } from "./privacyFixtures.test-support";
import { renderPrivacyComponent } from "./privacyTestClient.test-support";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

function exportableDetail() {
  const detail = privacyDetail();
  detail.request.state = "in_progress";
  detail.request.identityMethod = "manual";
  detail.capabilities.export = true;
  detail.capabilities.reasons = {};
  return detail;
}

describe("assisted export download", () => {
  it("opens the picker in its own click and falls back to a browser download when it is refused", async () => {
    const picker = vi.fn(async () => {
      throw new DOMException("No user activation", "SecurityError");
    });
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    sdkMocks.exportCase.mockImplementation(async (...args: unknown[]) => {
      const headers = args[2] as Record<string, string>;
      const options = args[3] as ExportOptions;
      expect(headers["x-admin-reauth-proof"]).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      await options.onByteChunk(new Uint8Array([80, 75]), new AbortController().signal);
      return { status: 200 };
    });
    const createObjectURL = vi.fn(() => "blob:export");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const detail = exportableDetail();
    renderPrivacyComponent(detail, (client) => (
      <PrivacyExportDownload detail={detail} client={client} />
    ));

    fireEvent.click(screen.getByRole("button", { name: "privacyAdmin.workflows.downloadExport" }));
    const save = await screen.findByRole("button", { name: "privacyAdmin.workflows.saveExport" });
    // Nothing is fetched or picked before the explicit save click.
    expect(picker).not.toHaveBeenCalled();
    expect(sdkMocks.exportCase).not.toHaveBeenCalled();
    fireEvent.click(save);

    await screen.findByText("privacyAdmin.workflows.exportDownloaded");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(screen.getByText("privacyAdmin.workflows.exportInBrowser")).toBeVisible();
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
  });
});
