import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { PlatformConfiguration } from "./PlatformConfiguration";

const mocks = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), apply: vi.fn(), job: vi.fn() }));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: {
    useSession: () => ({ data: { user: { id: "admin-a", role: "admin" } } }),
    admin: {},
  },
}));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  getAdminPlatformConfiguration: mocks.get,
  previewAdminPlatformConfiguration: mocks.preview,
  applyAdminPlatformConfiguration: mocks.apply,
  getAdminActivityJob: mocks.job,
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
}));
vi.mock("../activity/JobDetail", () => ({
  JobDetail: ({ jobId }: { jobId: string }) => <div>Job {jobId}</div>,
}));
const values = {
  domain: "maps.example.test",
  acmeEmail: "admin@example.test",
  releaseSelector: "main",
  defaultRegion: null,
  backupRetentionDays: 30,
};
const sources = {
  domain: "host",
  acmeEmail: "host",
  releaseSelector: "host",
  defaultRegion: "host",
  backupRetentionDays: "host",
};
const initial = {
  expectedCurrentRevisionId: null,
  configuration: { version: 1 },
  values,
  sources,
};
const confirmations = {
  domain: false,
  dnsTls: false,
  oauth: false,
  passkeys: false,
  alternateLogin: false,
};
const preview = {
  ...initial,
  version: 1,
  actorId: "admin-a",
  previewId: "17aa76e8-0359-43d1-8741-307cebb13b90",
  authPolicyRevision: "a".repeat(64),
  sourceRevision: "17aa76e8-0359-43d1-8741-307cebb13b90",
  affectedServiceIds: ["ops-agent"],
  oldOrigin: "https://maps.example.test",
  newOrigin: "https://maps.example.test",
  originConsumers: {
    routingHost: values.domain,
    corsOrigin: "https://maps.example.test",
    authUrl: "https://maps.example.test",
    passkeyRpId: values.domain,
    passkeyOrigin: "https://maps.example.test",
    webApiUrl: "https://maps.example.test",
    tilesPublicUrl: "https://maps.example.test",
  },
  requiredConfirmation: confirmations,
  warnings: [],
  previewFingerprint: "b".repeat(64),
};
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function mount() {
  const cache = createTestQueryClient();
  caches.push(cache);
  return render(
    <QueryClientProvider client={cache}>
      <PlatformConfiguration />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.get.mockResolvedValue({ status: 200, data: { ...initial, pending: [] } });
  mocks.job.mockResolvedValue({
    status: 200,
    data: { id: "original-job", source: "application", status: "running", finishedAt: null },
  });
  mocks.preview.mockResolvedValue({
    status: 200,
    data: { preview, expiresAt: new Date(Date.now() + 600000).toISOString() },
  });
  mocks.apply.mockResolvedValue({ status: 202, data: { ok: true, jobId: "original-job" } });
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((c) => {
    c.clear();
  });
});
it("locks host fields until explicit adoption, previews without saving and binds apply to that preview", async () => {
  mount();
  const retention = await screen.findByLabelText("Backup retention (days)");
  expect(retention).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Manage Backup retention (days) in UI" }));
  fireEvent.change(retention, { target: { value: "60" } });
  expect(mocks.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("Review platform changes");
  expect(mocks.preview.mock.calls[0][0]).toMatchObject({
    expectedCurrentRevisionId: null,
    changes: { version: 1, backupRetentionDays: { source: "database", value: 60 } },
  });
  expect(mocks.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  expect(mocks.apply.mock.calls[0][0]).toEqual({
    expectedCurrentRevisionId: null,
    previewFingerprint: preview.previewFingerprint,
    confirmations,
  });
  expect(await screen.findByText("Job original-job")).toBeVisible();
});
it("invalidates a preview on edit and preserves the draft on conflict", async () => {
  mocks.preview.mockResolvedValue({ status: 409, data: { error: "changed" } });
  mount();
  await screen.findByLabelText("Domain");
  fireEvent.click(screen.getByRole("button", { name: "Manage Domain in UI" }));
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "new.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByText(/Preview unavailable/)).toBeVisible();
  expect(screen.getByLabelText("Domain")).toHaveValue("new.example.test");
  mocks.preview.mockResolvedValue({
    status: 200,
    data: { preview, expiresAt: new Date(Date.now() + 600000).toISOString() },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("Review platform changes");
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "other.example.test" } });
  expect(screen.queryByRole("button", { name: "Apply reviewed changes" })).toBeNull();
  expect(mocks.apply).not.toHaveBeenCalled();
});
it("reconnects to pending work and does not offer another apply", async () => {
  mocks.get.mockResolvedValue({
    status: 200,
    data: { ...initial, pending: [{ jobId: "retained-job", status: "running" }] },
  });
  mount();
  expect(await screen.findByText("Job retained-job")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
});

it("requires all origin acknowledgments and the exact preview sign-in proof", async () => {
  mocks.preview.mockResolvedValue({
    status: 200,
    data: {
      preview: {
        ...preview,
        requiredConfirmation: {
          domain: true,
          dnsTls: true,
          oauth: true,
          passkeys: true,
          alternateLogin: true,
        },
        newOrigin: "https://new.example.test",
      },
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  });
  mount();
  await screen.findByLabelText("Domain");
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  const apply = await screen.findByRole("button", { name: "Apply reviewed changes" });
  expect(apply).toBeDisabled();
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  expect(apply).toBeDisabled();
  expect(screen.getByRole("link", { name: "Open reviewed admin address" })).toHaveAttribute(
    "href",
    "https://new.example.test/admin",
  );
  expect(mocks.apply).not.toHaveBeenCalled();
});
it("cannot apply an expired preview", async () => {
  mocks.preview.mockResolvedValue({
    status: 200,
    data: { preview, expiresAt: new Date(Date.now() - 1000).toISOString() },
  });
  mount();
  await screen.findByLabelText("Domain");
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(await screen.findByText(/This preview expired/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
});

it("retains the exact unexpired actor-bound preview across the alternate-login return", async () => {
  mount();
  await screen.findByLabelText("Domain");
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("Review platform changes");
  cleanup();
  mount();
  expect(await screen.findByText("Review platform changes")).toBeVisible();
  expect(mocks.preview).toHaveBeenCalledTimes(1);
});
