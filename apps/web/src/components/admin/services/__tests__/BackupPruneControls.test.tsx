import { afterEach, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { cleanup, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";
import { BackupPruneControls } from "../BackupPruneControls";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));
vi.mock("../../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(expired = false) {
  const proof = {
    inventoryDigest: "a".repeat(64),
    policyRevision: "b".repeat(64),
    previewedAt: new Date(Date.now() - (expired ? 960000 : 0)).toISOString(),
    expiresAt: new Date(Date.now() + (expired ? -60000 : 900000)).toISOString(),
    authenticator: "c".repeat(64),
  };
  const preview = {
      proof,
      cutoff: "2026-09-01T00:00:00.000Z",
      retentionDays: 30,
      policySource: "database",
      candidates: [
        {
          backupId: "old",
          createdAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-31T00:00:00.000Z",
          totalBytes: 1000,
          corrupt: false,
        },
      ],
      retainedCount: 2,
      corruptBackups: [],
    },
    requests: { input: string; init: RequestInit }[] = [];
  let mutations = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith("/prune/preview")) return Response.json(preview);
    if (String(input).endsWith("/prune")) {
      mutations++;
      return mutations === 1
        ? Response.json({ error: "Connection interrupted" }, { status: 503 })
        : Response.json({ ok: true, jobId: "pruned" }, { status: 202 });
    }
    return Response.json({});
  });
  render(
    <AdminJobEffectsProvider>
      <BackupPruneControls />
    </AdminJobEffectsProvider>,
    { wrapper: createQueryWrapper() },
  );
  return { requests, proof };
}
it("previews before confirmation and preserves the exact proof and key after a lost response", async () => {
  const { requests, proof } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preview expired backups" }));
  expect(await screen.findByText(/30 days.*database/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Prune backups" })).toBeDisabled();
  expect(requests.filter((request) => request.input.endsWith("/prune"))).toHaveLength(0);
  fireEvent.change(screen.getByRole("textbox", { name: "Confirmation" }), {
    target: { value: "PRUNE EXPIRED BACKUPS" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Prune backups" }));
  await waitFor(() =>
    expect(requests.filter((request) => request.input.endsWith("/prune"))).toHaveLength(1),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Prune backups" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Prune backups" }));
  await waitFor(() =>
    expect(requests.filter((request) => request.input.endsWith("/prune"))).toHaveLength(2),
  );
  const writes = requests.filter((request) => request.input.endsWith("/prune"));
  expect(writes.map((request) => JSON.parse(String(request.init.body)))).toEqual(
    [1, 2].map(() => ({ proof, confirmation: "PRUNE EXPIRED BACKUPS" })),
  );
  expect(new Headers(writes[0].init.headers).get("idempotency-key")).toBeTruthy();
  expect(new Headers(writes[0].init.headers).get("idempotency-key")).toBe(
    new Headers(writes[1].init.headers).get("idempotency-key"),
  );
});
it("refuses an expired preview and links to the single source-aware policy editor", async () => {
  setup(true);
  expect(screen.getByRole("link", { name: "Edit backup retention policy" })).toHaveAttribute(
    "href",
    "/admin/settings#backup-retention",
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview expired backups" }));
  await screen.findByText(/30 days.*database/);
  fireEvent.change(screen.getByRole("textbox", { name: "Confirmation" }), {
    target: { value: "PRUNE EXPIRED BACKUPS" },
  });
  expect(screen.getByRole("button", { name: "Prune backups" })).toBeDisabled();
});
