import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyBackupReview } from "./PrivacyBackupReview";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
const backup = {
  backupId: "synthetic-backup",
  createdAt: "2026-10-01T00:00:00Z",
  platformVersion: "1",
  formatVersion: 2,
  manifestDigest: "a".repeat(64),
  verified: true,
  expired: false,
  volumes: [],
};
describe("trusted backup review", () => {
  it("submits only the trusted inventory ID and no caller-controlled digest or decision", async () => {
    const detail = privacyDetail(),
      bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, rawInit: unknown) => {
        const init = rawInit as RequestInit | undefined;
        if (init?.method === "POST") {
          bodies.push(JSON.parse(String(init?.body)));
          return privacyJson({ code: "BACKUP_REVIEW_IMMUTABLE" }, 409);
        }
        return privacyJson(
          String(url).endsWith("/backups")
            ? { backups: [backup], warningCount: 0 }
            : { reviews: [] },
        );
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyBackupReview detail={detail} client={client} />
    ));
    await waitFor(() =>
      expect(screen.getByLabelText("privacyAdmin.workflows.backupSelection")).not.toBeDisabled(),
    );
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.backupSelection"));
    fireEvent.click(await screen.findByRole("option", { name: /synthetic-backup/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "privacyAdmin.workflows.recordBackupReview" }),
    );
    await waitFor(() => expect(bodies).toEqual([{ backupId: "synthetic-backup" }]));
  });
  it("retains good inventory during an outage and disables new review instead of showing empty inventory", async () => {
    const detail = privacyDetail();
    let failed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).endsWith("/backups")
          ? failed
            ? privacyJson({ code: "BACKUP_REVIEW_UNAVAILABLE" }, 503)
            : privacyJson({ backups: [backup], warningCount: 0 })
          : privacyJson({ reviews: [] }),
      ),
    );
    const { qc } = renderPrivacyComponent(detail, (client) => (
      <PrivacyBackupReview detail={detail} client={client} />
    ));
    await waitFor(() =>
      expect(screen.getByLabelText("privacyAdmin.workflows.backupSelection")).not.toBeDisabled(),
    );
    failed = true;
    await qc.refetchQueries({
      queryKey: ["admin", "privacy", "http://privacy.test", "synthetic-worker", "backups"],
    });
    await screen.findByText("privacyAdmin.workflows.backupUnavailable");
    expect(screen.getByLabelText("privacyAdmin.workflows.backupSelection")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("privacyAdmin.noBackups")).not.toBeInTheDocument();
    expect(
      qc.getQueryData(["admin", "privacy", "http://privacy.test", "synthetic-worker", "backups"]),
    ).toMatchObject({ backups: [backup] });
  });
});
