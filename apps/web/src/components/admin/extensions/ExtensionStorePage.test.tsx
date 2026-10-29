import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import {
  act,
  cleanup,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test";
import { catalogEntry, deferred, installed, preview } from "@/test/extensionAdmin";
import { job } from "../activity/__tests__/fixtures";
import { AdminToastProvider } from "../shared/AdminToast";
import { ExtensionStorePage } from "./ExtensionStorePage";

let apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
let calls: { url: URL; init: RequestInit }[] = [];
let intercept: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
function mount() {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  caches.push(qc);
  const view = (visible = true) => (
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>
        <AdminToastProvider>{visible && <ExtensionStorePage />}</AdminToastProvider>
      </AdminJobEffectsProvider>
    </QueryClientProvider>
  );
  return { qc, view, ...render(view()) };
}
beforeEach(() => {
  apiUrl = "http://admin.test";
  calls = [];
  intercept = () => undefined;
  vi.stubGlobal("fetch", (raw: string, init: RequestInit) => {
    const url = new URL(raw, window.location.origin);
    calls.push({ url, init });
    const result = intercept(url, init);
    if (result) return result;
    const path = url.pathname;
    if (path.endsWith("/catalog"))
      return Response.json({ entries: [catalogEntry()], total: 1, revocationDataStale: false });
    if (path.endsWith("/installed")) return Response.json({ extensions: [installed()] });
    if (path.endsWith("/sources"))
      return Response.json(
        init.method && init.method !== "GET"
          ? { ok: true }
          : {
              sources: [
                { url: "https://catalog.test/index.json", label: "Default index", isDefault: true },
                { url: "https://custom.test/index.json", label: "Custom index", isDefault: false },
              ],
            },
      );
    if (path.endsWith("/install-preview")) return Response.json(preview());
    if (path.includes("/jobs/")) return Response.json(job());
    if (path.endsWith("/refresh-catalog")) return Response.json({ entries: 1 });
    return Response.json({ jobId: "job-1" }, { status: 202 });
  });
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
});
async function openUrl() {
  fireEvent.click(await screen.findByRole("button", { name: "Install from URL" }));
  return screen.findByLabelText("extension.json URL");
}
async function reviewUrl(value = "https://manifest.test/a.json") {
  const input = await openUrl();
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Review security" }));
}
const previewCalls = () => calls.filter((c) => c.url.pathname.endsWith("/install-preview"));
const installCalls = () => calls.filter((c) => c.url.pathname.endsWith("/install"));
describe("actual extension forms and SDK ownership", () => {
  it("keeps removal reachable when the update comparison is unavailable", async () => {
    intercept = (u) =>
      u.pathname.endsWith("/installed")
        ? Response.json({ extensions: [installed({ hasUpdate: null, latestVersion: null })] })
        : undefined;
    vi.stubGlobal("confirm", () => true);
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    await screen.findByText("Update status unavailable");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(1));
  });
  it.each(["displayed", "pending"])(
    "keeps stale inventory/removal and retires a %s update preview after failed refetch",
    async (state) => {
      const pending = deferred<Response>();
      const refresh = deferred<Response>();
      const { qc } = mount();
      fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
      const update = await screen.findByRole("button", { name: "Update" });
      if (state === "pending")
        intercept = (u) => (u.pathname.endsWith("/install-preview") ? pending.promise : undefined);
      fireEvent.click(update);
      await waitFor(() => expect(previewCalls()).toHaveLength(1));
      if (state === "displayed") await screen.findByText("Review extension security");
      intercept = (u) => (u.pathname.endsWith("/installed") ? refresh.promise : undefined);
      let refetch!: Promise<void>;
      act(() => {
        refetch = qc.refetchQueries({ queryKey: ["admin", "extensions", apiUrl, "installed"] });
      });
      await waitFor(() =>
        expect(calls.filter((c) => c.url.pathname.endsWith("/installed"))).toHaveLength(2),
      );
      await act(async () => {
        refresh.resolve(Response.json({ error: "Unavailable" }, { status: 500 }));
        await refetch;
      });
      await screen.findByText(/Showing last loaded installed extensions/);
      if (state === "pending") await act(async () => pending.resolve(Response.json(preview())));
      await waitFor(() => expect(screen.queryByText("Review extension security")).toBeNull());
      expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
      expect(screen.queryByText(/→ 2/)).toBeNull();
      expect(screen.getByText("Update status unavailable")).toBeInTheDocument();
      vi.stubGlobal("confirm", () => true);
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
      await waitFor(() => expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(1));
      expect(calls.filter((c) => c.url.pathname.includes("/update/"))).toHaveLength(0);
    },
  );
  it("does not show an empty success after refetch failure of a previously empty inventory", async () => {
    intercept = (u) =>
      u.pathname.endsWith("/installed") ? Response.json({ extensions: [] }) : undefined;
    const { qc } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    await screen.findByText(/No extensions installed/);
    intercept = (u) =>
      u.pathname.endsWith("/installed")
        ? Response.json({ error: "Unavailable" }, { status: 500 })
        : undefined;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["admin", "extensions", apiUrl, "installed"] });
    });
    await screen.findByText(/Showing last loaded installed extensions/);
    expect(screen.queryByText(/No extensions installed/)).toBeNull();
  });
  it("never uses another origin's cached inventory when the new origin fails", async () => {
    const { view, rerender } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    await screen.findByRole("button", { name: "Uninstall" });
    apiUrl = "http://second.test";
    intercept = (u) =>
      u.pathname.endsWith("/installed")
        ? Response.json({ error: "Unavailable" }, { status: 500 })
        : undefined;
    rerender(view());
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    await screen.findByText("Failed to load installed extensions.");
    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
    expect(screen.queryByText(/Showing last loaded/)).toBeNull();
  });
  it("preserves the full commit and gives its caption a wrapping rule", async () => {
    mount();
    await reviewUrl();
    const caption = await screen.findByText(`Commit ${"a".repeat(40)}`);
    expect(caption).toHaveStyle({ overflowWrap: "anywhere" });
  });
  it("renders independent revocation/staleness, unknown version and the existing critical guard", async () => {
    intercept = (u) =>
      u.pathname.endsWith("/catalog")
        ? Response.json({
            entries: [
              catalogEntry({
                status: "revoked",
                critical: { reason: "Blocked", maxVersion: "opaque" },
              }),
            ],
            total: 1,
            revocationDataStale: true,
          })
        : undefined;
    mount();
    await screen.findByText("Version unknown");
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText(/Revoked/)).toBeInTheDocument();
    expect(screen.getByText(/Revocation data is stale/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  });
  it.each(["Installed", "Sources"])("shows %s read errors before empty/success UI", async (tab) => {
    intercept = (u) =>
      u.pathname.endsWith(tab === "Installed" ? "/installed" : "/sources")
        ? Response.json({ error: "Unavailable" }, { status: 500 })
        : undefined;
    mount();
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    await screen.findByText(
      tab === "Installed"
        ? "Failed to load installed extensions."
        : "Failed to load extension sources.",
    );
    expect(screen.queryByText(/No extensions installed/)).toBeNull();
  });
  it("does not label all default source content verified", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
    await screen.findByText("Default catalog");
    expect(screen.queryByText("Verified (default)")).toBeNull();
  });
  it("shows full ports and rating and confirms the exact preview selector/fingerprint once", async () => {
    mount();
    await reviewUrl();
    await screen.findByText("127.0.0.1:8080 → container 80/tcp");
    expect(screen.getByText("[::]:5353 → container 53/udp")).toBeInTheDocument();
    expect(screen.getByText(/APP_MODE/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm ports and install" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(installCalls()).toHaveLength(1));
    expect(JSON.parse(String(installCalls()[0].init.body))).toEqual({
      manifestUrl: "https://manifest.test/a.json",
      hostPortConfirmation: "b".repeat(64),
    });
    expect(installCalls()[0].url.origin).toBe(previewCalls()[0].url.origin);
  });
  it.each(["input-aba", "close-reopen", "tab", "origin-aba"])(
    "retires a delayed preview across %s",
    async (change) => {
      const pending = deferred<Response>();
      intercept = (u) => (u.pathname.endsWith("/install-preview") ? pending.promise : undefined);
      const { view, rerender } = mount();
      if (change === "tab") fireEvent.click(await screen.findByRole("button", { name: "Install" }));
      else await reviewUrl();
      await waitFor(() => expect(previewCalls()).toHaveLength(1));
      if (change === "input-aba") {
        fireEvent.change(screen.getByLabelText("extension.json URL"), {
          target: { value: "https://manifest.test/b.json" },
        });
        fireEvent.change(screen.getByLabelText("extension.json URL"), {
          target: { value: "https://manifest.test/a.json" },
        });
      }
      if (change === "close-reopen") {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await openUrl();
      }
      if (change === "tab") {
        fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
        fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
      }
      if (change === "origin-aba") {
        apiUrl = "http://second.test";
        rerender(view());
        apiUrl = "http://admin.test";
        rerender(view());
      }
      await act(async () => pending.resolve(Response.json(preview())));
      expect(screen.queryByText("Review extension security")).toBeNull();
      expect(installCalls()).toHaveLength(0);
    },
  );
  it("retires an already displayed confirmation on origin replacement and return", async () => {
    const { view, rerender } = mount();
    await reviewUrl();
    await screen.findByText("Review extension security");
    apiUrl = "http://second.test";
    rerender(view());
    apiUrl = "http://admin.test";
    rerender(view());
    expect(screen.queryByText("Review extension security")).toBeNull();
  });
  it.each(["success", "error"])(
    "suppresses late source %s effects after input ABA but retains old-origin cache effects",
    async (outcome) => {
      const pending = deferred<Response>();
      intercept = (u, i) =>
        u.pathname.endsWith("/sources") && i.method === "POST" ? pending.promise : undefined;
      const { qc } = mount();
      fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
      fireEvent.click(await screen.findByRole("button", { name: "Add source" }));
      const label = screen.getByLabelText("Label");
      const url = screen.getByLabelText("Catalog URL (HTTPS)");
      fireEvent.change(label, { target: { value: "A" } });
      fireEvent.change(url, { target: { value: "https://new.test/index.json" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(calls.some((c) => c.init.method === "POST")).toBe(true));
      fireEvent.change(label, { target: { value: "B" } });
      fireEvent.change(label, { target: { value: "A" } });
      const installedKey = ["admin", "extensions", apiUrl, "installed"];
      qc.setQueryData(installedKey, { extensions: [] });
      await act(async () =>
        pending.resolve(
          Response.json(outcome === "success" ? { ok: true } : { error: "Rejected old source" }, {
            status: outcome === "success" ? 200 : 400,
          }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByText(outcome === "success" ? "Source added" : "Rejected old source"),
        ).toBeNull(),
      );
      expect(screen.getByLabelText("Label")).toHaveValue("A");
      if (outcome === "success")
        await waitFor(() => expect(qc.getQueryState(installedKey)?.isInvalidated).toBe(true));
    },
  );
  it("uses explicit update wording and a server port mismatch never retries or approves a new preview", async () => {
    intercept = (u) =>
      u.pathname.includes("/update/")
        ? Response.json({ error: "Host port confirmation does not match" }, { status: 400 })
        : undefined;
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await screen.findByText("Review extension security");
    fireEvent.click(screen.getByRole("button", { name: "Confirm ports and update" }));
    await screen.findByText("Host port confirmation does not match");
    expect(calls.filter((c) => c.url.pathname.includes("/update/"))).toHaveLength(1);
    expect(previewCalls()).toHaveLength(1);
  });
  it("prevents repeated uninstall clicks while its accepted request is pending", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("confirm", () => true);
    intercept = (_u, i) => (i.method === "DELETE" ? pending.promise : undefined);
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
    const remove = await screen.findByRole("button", { name: "Uninstall" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(1));
    await act(async () => pending.resolve(Response.json({ jobId: "job-1" }, { status: 202 })));
  });
  it("retires a displayed preview when its catalog snapshot changes", async () => {
    const { qc } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await screen.findByText("Review extension security");
    act(() =>
      qc.setQueryData(["admin", "extensions", apiUrl, "catalog", { q: "", trust: "", type: "" }], {
        entries: [catalogEntry({ critical: { reason: "New advisory" }, status: "revoked" })],
        total: 1,
        revocationDataStale: false,
      }),
    );
    await waitFor(() => expect(screen.queryByText("Review extension security")).toBeNull());
    expect(installCalls()).toHaveLength(0);
  });
  it.each(["success", "error"])(
    "keeps the newest input session's preview when an older preview %s arrives later",
    async (outcome) => {
      const old = deferred<Response>();
      const fresh = deferred<Response>();
      let count = 0;
      intercept = (u) =>
        u.pathname.endsWith("/install-preview")
          ? ++count === 1
            ? old.promise
            : fresh.promise
          : undefined;
      mount();
      await reviewUrl();
      await waitFor(() => expect(previewCalls()).toHaveLength(1));
      fireEvent.change(screen.getByLabelText("extension.json URL"), {
        target: { value: "https://manifest.test/new.json" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review security" }));
      await waitFor(() => expect(previewCalls()).toHaveLength(2));
      await act(async () =>
        fresh.resolve(
          Response.json(
            preview({
              extension: { id: "new", name: "Fresh extension", version: "3" },
              confirmation: "c".repeat(64),
            }),
          ),
        ),
      );
      await screen.findByText("Fresh extension v3");
      await act(async () =>
        old.resolve(
          Response.json(outcome === "success" ? preview() : { error: "Old preview rejected" }, {
            status: outcome === "success" ? 200 : 400,
          }),
        ),
      );
      expect(screen.getByText("Fresh extension v3")).toBeInTheDocument();
      expect(screen.queryByText("Old preview rejected")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Confirm ports and install" }));
      await waitFor(() => expect(installCalls()).toHaveLength(1));
      expect(JSON.parse(String(installCalls()[0].init.body))).toEqual({
        manifestUrl: "https://manifest.test/new.json",
        hostPortConfirmation: "c".repeat(64),
      });
    },
  );
  it.each(["success", "error"])(
    "suppresses a disposed page's late install %s toast while accepted work stays observed",
    async (outcome) => {
      const pending = deferred<Response>();
      intercept = (u) => (u.pathname.endsWith("/install") ? pending.promise : undefined);
      const { view, rerender } = mount();
      await reviewUrl();
      fireEvent.click(await screen.findByRole("button", { name: "Confirm ports and install" }));
      await waitFor(() => expect(installCalls()).toHaveLength(1));
      rerender(view(false));
      rerender(view());
      await screen.findByRole("button", { name: "Install from URL" });
      await act(async () =>
        pending.resolve(
          Response.json(
            outcome === "success" ? { jobId: "job-1" } : { error: "Old install rejected" },
            { status: outcome === "success" ? 202 : 400 },
          ),
        ),
      );
      expect(screen.queryByText(/Install queued|Old install rejected/)).toBeNull();
      if (outcome === "success")
        await waitFor(() =>
          expect(calls.some((c) => c.url.pathname.includes("/jobs/job-1"))).toBe(true),
        );
    },
  );
  it("rejects a response for a different selected row", async () => {
    intercept = (u) =>
      u.pathname.endsWith("/install-preview")
        ? Response.json(
            preview({ extension: { id: "other", name: "Other extension", version: "2" } }),
          )
        : undefined;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await screen.findByText("The preview does not match the selected extension");
    expect(screen.queryByText("Review extension security")).toBeNull();
    expect(installCalls()).toHaveLength(0);
  });
});

describe("destructive target exclusion survives tab disposal", () => {
  it.each(["success", "error"] as const)(
    "retains an uninstall guard through Installed→Browse→Installed until %s, without blocking another ID",
    async (outcome) => {
      vi.stubGlobal("confirm", () => true);
      const pending = deferred<Response>();
      const deletes: string[] = [];
      intercept = (u, i) => {
        if (u.pathname.endsWith("/installed"))
          return Response.json({
            extensions: [installed(), installed({ id: "other", name: "Other extension" })],
          });
        if (i.method === "DELETE") {
          const id = decodeURIComponent(u.pathname.split("/").at(-1) ?? "");
          deletes.push(id);
          if (id === "demo")
            return deletes.filter((x) => x === "demo").length === 1
              ? pending.promise
              : Response.json({ error: "Duplicate reached transport" }, { status: 400 });
          return Response.json({ jobId: "other-job" }, { status: 202 });
        }
        if (u.pathname.includes("/jobs/"))
          return Response.json(job({ id: u.pathname.split("/").at(-1) }));
        return undefined;
      };
      mount();
      fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
      const button = (name: string) =>
        within(screen.getByRole("row", { name: new RegExp(name) })).getByRole("button", {
          name: "Uninstall",
        });
      await screen.findByText("Demo extension");
      fireEvent.click(button("Demo extension"));
      await waitFor(() => expect(deletes).toEqual(["demo"]));
      fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
      fireEvent.click(screen.getByRole("tab", { name: "Installed" }));
      await screen.findByText("Demo extension");
      fireEvent.click(button("Demo extension"));
      await act(async () => {});
      expect(deletes).toEqual(["demo"]);
      expect(button("Demo extension")).toBeDisabled();
      expect(button("Other extension")).not.toBeDisabled();
      fireEvent.click(button("Other extension"));
      await waitFor(() => expect(deletes).toEqual(["demo", "other"]));
      await screen.findByText("Removal queued for Other extension. Check Activity for completion.");
      expect(button("Demo extension")).toBeDisabled();
      await act(async () =>
        pending.resolve(
          Response.json(
            outcome === "success" ? { jobId: "original-job" } : { error: "Old uninstall rejected" },
            { status: outcome === "success" ? 202 : 400 },
          ),
        ),
      );
      await waitFor(() => expect(button("Demo extension")).not.toBeDisabled());
      expect(screen.queryByText("Old uninstall rejected")).toBeNull();
      expect(
        screen.queryByText("Removal queued for Demo extension. Check Activity for completion."),
      ).toBeNull();
      expect(deletes).toEqual(["demo", "other"]);
      if (outcome === "success")
        await waitFor(() =>
          expect(calls.some((c) => c.url.pathname.endsWith("/jobs/original-job"))).toBe(true),
        );
    },
  );
  it.each(["success", "error"] as const)(
    "retains source removal through Sources→Browse→Sources until %s, without blocking another URL",
    async (outcome) => {
      const pending = deferred<Response>();
      const deletes: string[] = [];
      const first = "https://custom.test/index.json",
        second = "https://other.test/index.json";
      intercept = (u, i) => {
        if (!u.pathname.endsWith("/sources")) return undefined;
        if (i.method === "DELETE") {
          const url = JSON.parse(String(i.body)).url;
          deletes.push(url);
          if (url === first)
            return deletes.filter((x) => x === first).length === 1
              ? pending.promise
              : Response.json({ error: "Duplicate reached transport" }, { status: 400 });
          return Response.json({ ok: true });
        }
        return Response.json({
          sources: [
            { url: first, label: "First catalog", isDefault: false },
            { url: second, label: "Second catalog", isDefault: false },
          ],
        });
      };
      mount();
      fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
      const button = (label: string) =>
        within(screen.getByRole("row", { name: new RegExp(label) })).getByRole("button", {
          name: "Remove source",
        });
      await screen.findByText("First catalog");
      fireEvent.click(button("First catalog"));
      await waitFor(() => expect(deletes).toEqual([first]));
      fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
      fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
      await screen.findByText("First catalog");
      fireEvent.click(button("First catalog"));
      await act(async () => {});
      expect(deletes).toEqual([first]);
      expect(button("First catalog")).toBeDisabled();
      expect(button("Second catalog")).not.toBeDisabled();
      fireEvent.click(button("Second catalog"));
      await waitFor(() => expect(deletes).toEqual([first, second]));
      await screen.findByText("Source removed");
      expect(button("First catalog")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByText("Source removed")).toBeNull());
      await act(async () =>
        pending.resolve(
          Response.json(
            outcome === "success" ? { ok: true } : { error: "Old source removal rejected" },
            { status: outcome === "success" ? 200 : 400 },
          ),
        ),
      );
      await waitFor(() => expect(button("First catalog")).not.toBeDisabled());
      expect(screen.queryByText("Old source removal rejected")).toBeNull();
      expect(screen.queryByText("Source removed")).toBeNull();
      expect(deletes).toEqual([first, second]);
    },
  );
});
