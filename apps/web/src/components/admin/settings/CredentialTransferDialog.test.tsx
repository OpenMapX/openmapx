import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/test";
import { CredentialTransferDialog } from "./CredentialTransferDialog";
import { credentialPreviewStorageKey, retainCredentialPreview } from "./credential-preview-storage";

vi.mock("@/lib/admin/accountAdmin", () => ({
  useAccountAdmin: () => ({ actorId: "synthetic-admin" }),
}));
vi.mock("../activity/activityQueries", () => ({
  useActivityClient: () => ({ apiUrl: "http://synthetic.test/api", client: {} }),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
it("restores only reviewed public preview metadata after fresh sign-in navigation", async () => {
  retainCredentialPreview(
    credentialPreviewStorageKey("http://synthetic.test/api", "synthetic-admin"),
    {
      previewId: "00000000-0000-4000-8000-000000000001",
      intentFingerprint: "a".repeat(64),
      expectedCurrentRevisionId: null,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      entries: [{ scope: "integration", id: "example", key: "TOKEN", status: "selected" }],
      applyable: true,
    },
  );
  render(<CredentialTransferDialog onClose={() => {}} />);
  expect(
    await screen.findByRole("button", { name: "Confirm selected credential import" }),
  ).not.toBeDisabled();
  expect(screen.queryByLabelText("Transfer passphrase")).toBeNull();
  expect(JSON.stringify(sessionStorage)).not.toContain("passphrase");
});
it("rejects a large encrypted file before reading and requires explicit selection and passphrase", async () => {
  render(
    <CredentialTransferDialog
      onClose={() => {}}
      inventory={[{ scope: "integration", id: "example", key: "TOKEN" }]}
    />,
  );
  expect(screen.getByRole("button", { name: "Confirm encrypted export" })).toBeDisabled();
  const label = screen.getByText("Choose encrypted credential file"),
    input = label.querySelector("input");
  if (!input) throw Error("File input missing");
  const text = vi.fn();
  fireEvent.change(input, { target: { files: [{ size: 1048577, text }] } });
  expect(await screen.findByText("Encrypted file must be at most1MiB.")).toBeVisible();
  expect(text).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "integration/example/TOKEN" }));
  fireEvent.change(screen.getByLabelText("Transfer passphrase"), {
    target: { value: "synthetic passphrase" },
  });
  expect(screen.getByRole("button", { name: "Confirm encrypted export" })).not.toBeDisabled();
});
