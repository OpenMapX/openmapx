import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { deferred } from "@/test/extensionAdmin";
import { job } from "../activity/__tests__/fixtures";
import { StandaloneInstallDialog } from "./StandaloneInstallDialog";

let apiUrl = "https://admin.example";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const queries: ReturnType<typeof createTestQueryClient>[] = [];
let calls: { url: URL; init: RequestInit }[] = [];
let intercept: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined = () =>
  undefined;
const previewJob = "ddc83a2c-cd99-47c5-8eaf-ff20a2291d37",
  installJob = "b864063e-a930-4239-85f6-5d0672c368da";
const inspection = {
  inspectionId: "4093ebdd-04d2-4cda-970e-2bcc7407c8cf",
  sourceKind: "source",
  integrationId: "map-example",
  version: "1.0.0",
  contentDigest: "c".repeat(64),
  commit: "a".repeat(40),
  stageId: null,
  archiveSha256: null,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  denials: [],
};
beforeEach(() => {
  apiUrl = "https://admin.example";
  calls = [];
  intercept = () => undefined;
  vi.stubGlobal("fetch", async (raw: string, init: RequestInit) => {
    const url = new URL(raw, window.location.origin);
    calls.push({ url, init });
    const handled = intercept(url, init);
    if (handled) return handled;
    if (url.pathname.endsWith("/preview"))
      return Response.json(
        { jobId: previewJob, operationId: "d0865fbe-1458-4cae-90a0-bb395fdb14b5" },
        { status: 202 },
      );
    if (url.pathname.endsWith("/install"))
      return Response.json(
        { jobId: installJob, operationId: "c67d1e20-566d-4cd1-8d13-899dcfc57880" },
        { status: 202 },
      );
    const id = url.pathname.endsWith(previewJob) ? previewJob : installJob;
    return Response.json(
      job({
        id,
        status: "success",
        cancelable: false,
        result: id === previewJob ? inspection : { outcome: "committed" },
      }),
    );
  });
});
afterEach(() => {
  cleanup();
  queries.splice(0).forEach((query) => {
    query.clear();
  });
  vi.unstubAllGlobals();
});
function mount() {
  const qc = createTestQueryClient();
  queries.push(qc);
  return render(
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>
        <StandaloneInstallDialog />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
}
it("reviews a fixed source commit before sending the retained inspection to install", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Install standalone integration" }));
  fireEvent.change(screen.getByLabelText("Repository HTTPS URL"), {
    target: { value: "https://github.com/public/example.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  expect(await screen.findByText(`Resolved commit: ${inspection.commit}`)).toBeVisible();
  expect(screen.getByRole("button", { name: "Install integration" })).not.toBeDisabled();
  const preview = calls.find((call) => call.url.pathname.endsWith("/preview"))!;
  expect(JSON.parse(String(preview.init.body))).toEqual({
    source: { kind: "source", repository: "https://github.com/public/example.git" },
  });
  expect(new Headers(preview.init.headers).get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/);
  fireEvent.click(screen.getByRole("button", { name: "Install integration" }));
  expect(await screen.findByText("Standalone integration installed.")).toBeVisible();
  const install = calls.find((call) => call.url.pathname.endsWith("/install"))!;
  expect(JSON.parse(String(install.init.body))).toEqual({
    inspectionId: inspection.inspectionId,
    expectedContentDigest: inspection.contentDigest,
  });
  expect(calls.filter((call) => call.url.pathname.endsWith("/install"))).toHaveLength(1);
});
it("retires a prior inspection when source changes and never installs it", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Install standalone integration" }));
  fireEvent.change(screen.getByLabelText("Repository HTTPS URL"), {
    target: { value: "https://github.com/public/example.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  await screen.findByText(`Resolved commit: ${inspection.commit}`);
  fireEvent.change(screen.getByLabelText("Repository HTTPS URL"), {
    target: { value: "https://github.com/public/other.git" },
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull(),
  );
  expect(calls.some((call) => call.url.pathname.endsWith("/install"))).toBe(false);
});

it("ignores a late accepted preview after closing and reopening the dialog", async () => {
  const held = deferred<Response>();
  intercept = (url) => (url.pathname.endsWith("/preview") ? held.promise : undefined);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Install standalone integration" }));
  fireEvent.change(screen.getByLabelText("Repository HTTPS URL"), {
    target: { value: "https://github.com/public/example.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  await waitFor(() =>
    expect(calls.some((call) => call.url.pathname.endsWith("/preview"))).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "Install standalone integration" }));
  await act(async () =>
    held.resolve(
      Response.json(
        { jobId: previewJob, operationId: "d0865fbe-1458-4cae-90a0-bb395fdb14b5" },
        { status: 202 },
      ),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review source" })).not.toBeDisabled(),
  );
  expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull();
});
it("allocates a fresh inspection request when explicitly reviewing an existing preview again", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Install standalone integration" }));
  fireEvent.change(screen.getByLabelText("Repository HTTPS URL"), {
    target: { value: "https://github.com/public/example.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  await screen.findByText(`Resolved commit: ${inspection.commit}`);
  const first = calls.find((call) => call.url.pathname.endsWith("/preview"))!;
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  await waitFor(() =>
    expect(calls.filter((call) => call.url.pathname.endsWith("/preview"))).toHaveLength(2),
  );
  const second = calls.filter((call) => call.url.pathname.endsWith("/preview"))[1]!;
  expect(new Headers(second.init.headers).get("idempotency-key")).not.toBe(
    new Headers(first.init.headers).get("idempotency-key"),
  );
});
it("retries a lost preview acknowledgement using the already-uploaded immutable file", async () => {
  const stageId = "3524c227-2876-42ec-a25d-3bc9e2b87872",
    sha256 = "d".repeat(64);
  let previewAttempts = 0;
  const stage = {
    stageId,
    purpose: "integration-artifact",
    direction: "upload",
    state: "created",
    bytes: 0,
    sha256: null,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    cleanup: "pending",
  };
  intercept = (url, init) => {
    if (url.pathname.endsWith("/artifact-transfers")) return Response.json(stage);
    if (url.pathname.endsWith("/content") && init.method === "PUT")
      return Response.json({ ...stage, state: "uploaded", bytes: 3, sha256 });
    if (url.pathname.endsWith("/preview") && previewAttempts++ === 0)
      return Promise.reject(new TypeError("preview-transport-lost"));
    if (url.pathname.endsWith(previewJob))
      return Response.json(
        job({
          id: previewJob,
          status: "success",
          cancelable: false,
          result: {
            ...inspection,
            sourceKind: "uploaded-artifact",
            stageId,
            archiveSha256: sha256,
            commit: null,
          },
        }),
      );
    return undefined;
  };
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Install standalone integration" }));
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Install source" }));
  fireEvent.click(await screen.findByRole("option", { name: "Upload archive" }));
  const file = new File([new Uint8Array([0, 1, 255])], "fixture.tar.gz");
  fireEvent.change(screen.getByLabelText("Integration archive"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  await waitFor(() =>
    expect(calls.filter((call) => call.url.pathname.endsWith("/preview"))).toHaveLength(1),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review source" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review source" }));
  expect(await screen.findByRole("button", { name: "Install integration" })).not.toBeDisabled();
  const uploads = calls.filter((call) => call.init.method === "PUT");
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.init.body).toBe(file);
  const previews = calls.filter((call) => call.url.pathname.endsWith("/preview"));
  expect(previews).toHaveLength(2);
  expect(new Headers(previews[0]!.init.headers).get("idempotency-key")).toBe(
    new Headers(previews[1]!.init.headers).get("idempotency-key"),
  );
});
