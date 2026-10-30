import { QueryClientProvider } from "@tanstack/react-query";
import { cloneElement, isValidElement, type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { ComposePreview } from "./ComposePreview";
import { ManagedDawarichSetup } from "./ManagedDawarichSetup";
import { ServiceLogsDrawer } from "./ServiceLogsDrawer";

let apiUrl = "http://admin.test";
const toast = vi.fn();
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => toast }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function mount(child: ReactNode, strict = false) {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: 2, retryDelay: 1 },
  });
  caches.push(qc);
  const view = (next: ReactNode) =>
    strict ? (
      <StrictMode>
        <QueryClientProvider client={qc}>{next}</QueryClientProvider>
      </StrictMode>
    ) : (
      <QueryClientProvider client={qc}>{next}</QueryClientProvider>
    );
  const rendered = render(view(child));
  return {
    ...rendered,
    qc,
    replace: (next = child) =>
      rendered.rerender(view(isValidElement(next) ? cloneElement(next) : next)),
  };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const hardlinks = {
  applied: false,
  linked: 1,
  skipped: 2,
  pruned: 3,
  entries: 6,
  via: "typed-ops",
};
const ready = {
  installed: true,
  selected: false,
  running: false,
  healthy: false,
  publicOrigin: "https://timeline.test",
  oauthClient: {
    present: true,
    clientId: null,
    redirectUriMatches: true,
    settingsMatch: false,
    recoveryRequired: true,
  },
  secrets: {
    databasePassword: "consistent",
    secretKeyBase: "missing",
    oidcClientSecret: "conflict",
  },
  configReady: false,
  readyToStart: false,
  needsApply: true,
};
function composeFetch(write: (url: string, init: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    init.method === "POST"
      ? write(url, init)
      : new Response("services:\n  synthetic: {}\n", { headers: { "content-type": "text/yaml" } }),
  );
}
function logs(id = "service /one", open = true) {
  return <ServiceLogsDrawer open={open} onClose={() => {}} serviceId={id} serviceName={id} />;
}
beforeEach(() => {
  apiUrl = "http://admin.test";
  toast.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("Compose generated consumers", () => {
  it("shows finite YAML, rejects 200 domain failure and retains same unresolved key", async () => {
    const writes: RequestInit[] = [];
    composeFetch(async (_url, init) => {
      writes.push(init);
      return Response.json({ ok: writes.length !== 1, stdout: "complete stdout", hardlinks });
    });
    mount(<ComposePreview />);
    expect(await screen.findByText(/synthetic: \{\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compose Up" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Compose up failed", "error"));
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Compose Up" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Compose up completed"));
    fireEvent.click(screen.getByRole("button", { name: "Compose Up" }));
    await waitFor(() => expect(writes).toHaveLength(3));
    const keys = writes.map((init) => new Headers(init.headers).get("idempotency-key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });
  it("shows bounded down guidance once with no success or fallback", async () => {
    const paths: string[] = [];
    composeFetch(async (url) => {
      paths.push(new URL(url).pathname);
      return Response.json({ ok: false, error: "Use typed service controls" }, { status: 503 });
    });
    mount(<ComposePreview />);
    await screen.findByText(/synthetic: \{\}/);
    fireEvent.click(screen.getByRole("button", { name: "Compose Down" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Use typed service controls", "error"));
    expect(paths).toEqual(["/api/admin/compose/down"]);
  });
  it.each([true, false])(
    "fences old origin completion/error (%s) and never reuses its intent",
    async (ok) => {
      const old = pending<Response>();
      const writes: { url: string; key: string | null }[] = [];
      composeFetch(async (url, init) => {
        writes.push({ url, key: new Headers(init.headers).get("idempotency-key") });
        return writes.length === 1
          ? old.promise
          : Response.json({ ok: false, stdout: "", hardlinks });
      });
      const view = mount(<ComposePreview />);
      await screen.findByText(/synthetic: \{\}/);
      fireEvent.click(screen.getByRole("button", { name: "Compose Up" }));
      apiUrl = "http://replacement.test";
      view.replace();
      await screen.findByRole("button", { name: "Compose Up" });
      await act(async () => {
        old.resolve(
          Response.json(ok ? { ok: true, stdout: "old", hardlinks } : { error: "old diagnostic" }, {
            status: ok ? 200 : 500,
          }),
        );
      });
      expect(toast).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Compose Up" }));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1].key).not.toBe(writes[0].key);
      expect(writes[1].url).toBe("http://replacement.test/api/admin/compose/up");
    },
  );
  it("rejects a non-YAML preview instead of showing its body", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ secret: "never-show" }));
    mount(<ComposePreview />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Service request failed");
    expect(document.body.textContent).not.toContain("never-show");
  });
});
describe("generated log sessions", () => {
  it("decodes split UTF8/newlines, preserves blank output and keeps the last1000 lines", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("α\n\nline\nlast😀");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    });
    const view = mount(logs());
    expect(await screen.findByText("4 lines")).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe("α\n\nline\nlast😀");
    expect(stream.locked).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/api/admin/services/service%20%2Fone/logs");
    expect(new URL(calls[0].url).searchParams.get("lines")).toBe("200");
    expect(new Headers(calls[0].init.headers).get("idempotency-key")).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(Array.from({ length: 1005 }, (_, i) => `line-${i}\n`).join(""), {
          headers: { "content-type": "text/plain" },
        }),
    );
    view.replace(logs("large"));
    await screen.findByText("1000 lines");
    const lines = document.querySelector("pre")?.textContent?.split("\n");
    expect(lines).toHaveLength(1000);
    expect(lines?.[0]).toBe("line-5");
    expect(lines?.at(-1)).toBe("line-1004");
  });
  it.each(["origin", "service", "close", "unmount"])(
    "aborts stalled observation on %s and clears replacement content",
    async (kind) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let canceled = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          canceled++;
        },
      });
      const calls: RequestInit[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        calls.push(init);
        return calls.length === 1
          ? new Response(stream, { headers: { "content-type": "text/plain" } })
          : new Promise<Response>(() => {});
      });
      const view = mount(logs());
      await act(async () => {
        controller.enqueue(new TextEncoder().encode("old-line\n"));
      });
      await screen.findByText("old-line");
      if (kind === "origin") {
        apiUrl = "http://replacement.test";
        view.replace();
      }
      if (kind === "service") view.replace(logs("replacement"));
      if (kind === "close") view.replace(logs("service /one", false));
      if (kind === "unmount") view.unmount();
      await waitFor(() => expect(calls[0].signal?.aborted).toBe(true));
      expect(canceled).toBe(1);
      expect(stream.locked).toBe(false);
      if (kind === "origin" || kind === "service") {
        expect(document.querySelector("pre")?.textContent).toBe("");
        expect(screen.getByText("following")).toBeInTheDocument();
      }
    },
  );
  it("fences late headers/error/finally and uses a new key for each opened session", async () => {
    const old = pending<Response>();
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? old.promise : new Promise<Response>(() => {});
    });
    const view = mount(logs());
    apiUrl = "http://replacement.test";
    view.replace();
    await act(async () => {
      old.resolve(Response.json({ error: "old error" }, { status: 404 }));
    });
    expect(screen.getByText("following")).toBeInTheDocument();
    expect(screen.queryByText(/old error/)).not.toBeInTheDocument();
    expect(new Headers(calls[1].headers).get("idempotency-key")).not.toBe(
      new Headers(calls[0].headers).get("idempotency-key"),
    );
  });
  it.each(["empty", "missing", "json", "wrong-media"])("handles %s body safely", async (kind) => {
    vi.stubGlobal("fetch", async () =>
      kind === "json"
        ? Response.json({ error: "Logs unavailable" }, { status: 409 })
        : new Response(kind === "missing" ? null : kind === "empty" ? "" : "secret-value", {
            headers: { "content-type": kind === "wrong-media" ? "text/yaml" : "text/plain" },
          }),
    );
    mount(logs());
    if (kind === "empty")
      expect(await screen.findByText("No log output available.")).toBeInTheDocument();
    else {
      expect(await screen.findByText(/Error:/)).toHaveTextContent(
        kind === "json" ? "Logs unavailable" : "Service request failed",
      );
      expect(document.body.textContent).not.toContain("secret-value");
    }
  });
  it("has no finite 30 second deadline and cancels the reader when closed", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    });
    const view = mount(logs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText("following")).toBeInTheDocument();
    view.unmount();
    await act(async () => {});
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
describe("managed Dawarich view ownership", () => {
  it.each(["stalled", "failed"])(
    "keeps the newer A status after A→B→A and a late success with %s refresh",
    async (refresh) => {
      const old = pending<Response>();
      const stalled = pending<Response>();
      const originA = apiUrl;
      const originB = "http://replacement.test";
      const keyA = ["admin", "services", originA, "dawarich"];
      const current = {
        ...ready,
        publicOrigin: "https://current.test",
        oauthClient: { ...ready.oauthClient, recoveryRequired: false, settingsMatch: true },
        readyToStart: true,
      };
      let readsA = 0;
      let readsB = 0;
      let writes = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (init.method === "POST") {
          writes++;
          return old.promise;
        }
        if (new URL(url).origin === originB) {
          readsB++;
          return Response.json({ ...ready, publicOrigin: "https://replacement.test" });
        }
        readsA++;
        if (readsA <= 2) return Response.json(readsA === 1 ? ready : current);
        return refresh === "stalled"
          ? stalled.promise
          : Response.json({ code: "DAWARICH_PROVISIONING_FAILED" }, { status: 503 });
      });
      const view = mount(<ManagedDawarichSetup />);
      await screen.findByText(/OIDC recovery is incomplete/);
      fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
      await waitFor(() => expect(writes).toBe(1));
      apiUrl = originB;
      view.replace();
      await screen.findByText("https://replacement.test");
      // Another status effect makes inactive A stale before its replacement reads it.
      await view.qc.invalidateQueries({ queryKey: keyA });
      apiUrl = originA;
      view.replace();
      await screen.findByText(current.publicOrigin);
      fireEvent.change(screen.getByRole("textbox", { name: "Public hostname (optional)" }), {
        target: { value: "replacement-input.test" },
      });
      fireEvent.click(screen.getByText("OIDC secret recovery"));
      fireEvent.change(screen.getByRole("textbox", { name: "Type confirmation" }), {
        target: { value: "replacement confirmation" },
      });
      view.qc.setQueryData(["admin", "overview", originA], {});
      view.qc.setQueryData(["admin", "overview", originB], {});
      const publications: unknown[] = [];
      const unsubscribe = view.qc.getQueryCache().subscribe((event) => {
        if (JSON.stringify(event.query.queryKey) === JSON.stringify(keyA)) {
          publications.push(event.query.state.data);
        }
      });
      try {
        await act(async () => {
          old.resolve(Response.json({ ...ready, publicOrigin: "https://obsolete.test" }));
        });
        await waitFor(() => expect(readsA).toBe(3));
        expect(view.qc.getQueryState(["admin", "overview", originA])?.isInvalidated).toBe(true);
        expect(view.qc.getQueryState(["admin", "overview", originB])?.isInvalidated).toBe(false);
        expect(readsB).toBe(1);
        if (refresh === "failed") {
          await waitFor(() => expect(view.qc.getQueryState(keyA)?.status).toBe("error"));
          expect(screen.getByText(/Managed Dawarich provisioning failed/)).toBeInTheDocument();
        } else {
          expect(view.qc.getQueryState(keyA)?.fetchStatus).toBe("fetching");
        }
        expect(publications.length).toBeGreaterThan(0);
        for (const data of publications) expect(data).toEqual(current);
        expect(view.qc.getQueryData(keyA)).toEqual(current);
        expect(screen.getByText(current.publicOrigin)).toBeInTheDocument();
        expect(screen.queryByText(/OIDC recovery is incomplete/)).not.toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Public hostname (optional)" })).toHaveValue(
          "replacement-input.test",
        );
        expect(screen.getByRole("textbox", { name: "Type confirmation" })).toHaveValue(
          "replacement confirmation",
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["stalled", "failed"])(
    "keeps canonical status when newer rotation precedes older provision success and %s refresh",
    async (refresh) => {
      const old = pending<Response>();
      const rotation = pending<Response>();
      const stalled = pending<Response>();
      const key = ["admin", "services", apiUrl, "dawarich"];
      const current = {
        ...ready,
        publicOrigin: "https://current.test",
        oauthClient: { ...ready.oauthClient, recoveryRequired: false, settingsMatch: true },
        readyToStart: true,
      };
      const writes: string[] = [];
      let reads = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (init.method === "POST") {
          writes.push(new URL(url).pathname);
          return url.endsWith("/provision") ? old.promise : rotation.promise;
        }
        reads++;
        if (reads <= 2) return Response.json(reads === 1 ? ready : current);
        return refresh === "stalled"
          ? stalled.promise
          : Response.json({ code: "DAWARICH_PROVISIONING_FAILED" }, { status: 503 });
      });
      const view = mount(<ManagedDawarichSetup />);
      await screen.findByText(/OIDC recovery is incomplete/);
      fireEvent.click(screen.getByText("OIDC secret recovery"));
      fireEvent.change(screen.getByRole("textbox", { name: "Type confirmation" }), {
        target: { value: "ROTATE DAWARICH OIDC SECRET" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
      fireEvent.click(screen.getByRole("button", { name: "Rotate OIDC secret" }));
      await waitFor(() =>
        expect(writes).toEqual([
          "/api/admin/dawarich/provision",
          "/api/admin/dawarich/rotate-oidc-secret",
        ]),
      );
      await act(async () => {
        rotation.resolve(Response.json({ ...current, publicOrigin: "https://rotation.test" }));
      });
      await screen.findByText(current.publicOrigin);
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Type confirmation" })).toHaveValue(""),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Type confirmation" }), {
        target: { value: "replacement confirmation" },
      });
      const publications: unknown[] = [];
      const unsubscribe = view.qc.getQueryCache().subscribe((event) => {
        if (JSON.stringify(event.query.queryKey) === JSON.stringify(key)) {
          publications.push(event.query.state.data);
        }
      });
      try {
        await act(async () => {
          old.resolve(Response.json({ ...ready, publicOrigin: "https://obsolete.test" }));
        });
        await waitFor(() => expect(reads).toBe(3));
        if (refresh === "failed") {
          await waitFor(() => expect(view.qc.getQueryState(key)?.status).toBe("error"));
          expect(screen.getByText(/Managed Dawarich provisioning failed/)).toBeInTheDocument();
        } else {
          expect(view.qc.getQueryState(key)?.fetchStatus).toBe("fetching");
        }
        expect(publications.length).toBeGreaterThan(0);
        for (const data of publications) expect(data).toEqual(current);
        expect(view.qc.getQueryData(key)).toEqual(current);
        expect(screen.getByText(current.publicOrigin)).toBeInTheDocument();
        expect(screen.queryByText(/OIDC recovery is incomplete/)).not.toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Type confirmation" })).toHaveValue(
          "replacement confirmation",
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([true, false])(
    "old rotation %s cannot clear replacement confirmation or publish feedback",
    async (ok) => {
      const old = pending<Response>();
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
        init.method === "POST" ? old.promise : Response.json(ready),
      );
      const view = mount(<ManagedDawarichSetup />);
      await screen.findByText(/OIDC recovery is incomplete/);
      fireEvent.click(screen.getByText("OIDC secret recovery"));
      const input = screen.getByRole("textbox", { name: "Type confirmation" });
      fireEvent.change(input, { target: { value: "ROTATE DAWARICH OIDC SECRET" } });
      fireEvent.click(screen.getByRole("button", { name: "Rotate OIDC secret" }));
      fireEvent.change(input, { target: { value: "replacement input" } });
      await act(async () => {
        old.resolve(
          Response.json(ok ? ready : { code: "DAWARICH_DATABASE_SECRET_CONFLICT" }, {
            status: ok ? 200 : 409,
          }),
        );
      });
      expect(screen.getByRole("textbox", { name: "Type confirmation" })).toHaveValue(
        "replacement input",
      );
      expect(screen.queryByText(/database password copies conflict/)).not.toBeInTheDocument();
      apiUrl = "http://replacement.test";
      view.replace();
      expect(screen.getByRole("textbox", { name: "Public hostname (optional)" })).toHaveValue("");
    },
  );
});

describe("additional ownership and safe feedback", () => {
  it("shows active managed conflicts and preserves independent readiness rows", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
      init.method === "POST"
        ? Response.json({ code: "DAWARICH_DATABASE_SECRET_CONFLICT" }, { status: 409 })
        : Response.json(ready),
    );
    mount(<ManagedDawarichSetup />);
    await screen.findByText(/OIDC recovery is incomplete/);
    expect(screen.queryByText(/Apply changes to both/)).not.toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("Conflict")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
    expect(await screen.findByText(/database password copies conflict/)).toBeInTheDocument();
  });
  it.each([true, false])(
    "fences provision %s after origin and hostname replacement",
    async (ok) => {
      const old = pending<Response>();
      const writes: { url: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (init.method === "POST") {
          writes.push({ url, body: JSON.parse(String(init.body)) });
          return old.promise;
        }
        return Response.json(ready);
      });
      const view = mount(<ManagedDawarichSetup />);
      await screen.findByText(/OIDC recovery is incomplete/);
      fireEvent.change(screen.getByRole("textbox", { name: "Public hostname (optional)" }), {
        target: { value: "Timeline.Example.Test." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
      await waitFor(() =>
        expect(writes).toEqual([
          {
            url: "http://admin.test/api/admin/dawarich/provision",
            body: { publicHost: "timeline.example.test" },
          },
        ]),
      );
      apiUrl = "http://replacement.test";
      view.replace();
      fireEvent.change(screen.getByRole("textbox", { name: "Public hostname (optional)" }), {
        target: { value: "replacement.example.test" },
      });
      await act(async () => {
        old.resolve(
          Response.json(
            ok ? { ...ready, readyToStart: true } : { code: "DAWARICH_DATABASE_SECRET_CONFLICT" },
            { status: ok ? 200 : 409 },
          ),
        );
      });
      expect(screen.getByRole("textbox", { name: "Public hostname (optional)" })).toHaveValue(
        "replacement.example.test",
      );
      expect(screen.queryByText(/database password copies conflict/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Apply changes to both/)).not.toBeInTheDocument();
    },
  );
  it("cancels/unlocks a late successful log body and never delivers old chunks", async () => {
    const old = pending<Response>();
    let canceled = false;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("stale-log\n"));
      },
      cancel() {
        canceled = true;
      },
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () =>
      ++calls === 1 ? old.promise : new Promise<Response>(() => {}),
    );
    const view = mount(logs());
    view.replace(logs("replacement"));
    await act(async () => {
      old.resolve(new Response(stream, { headers: { "content-type": "text/plain" } }));
    });
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(document.querySelector("pre")?.textContent).toBe("");
    expect(screen.getByText("following")).toBeInTheDocument();
  });
  it("close aborts immediately, clears content, and reopening allocates one new key", async () => {
    const calls: RequestInit[] = [];
    let canceled = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("current-log\n"));
          },
          cancel() {
            canceled++;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    });
    const view = mount(logs());
    await screen.findByText("current-log");
    fireEvent.click(screen.getByRole("button", { name: "Close service logs" }));
    await act(async () => {});
    expect(calls[0].signal?.aborted).toBe(true);
    expect(canceled).toBe(1);
    expect(document.querySelector("pre")?.textContent).toBe("");
    view.replace(logs("service /one", false));
    view.replace(logs());
    await screen.findByText("current-log");
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1].headers).get("idempotency-key")).not.toBe(
      new Headers(calls[0].headers).get("idempotency-key"),
    );
  });
});

it("retains a single log session idempotency key through StrictMode observation replay", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(new ReadableStream(), { headers: { "content-type": "text/plain" } });
  });
  const view = mount(logs(), true);
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0].signal?.aborted).toBe(true);
  expect(new Headers(calls[1].headers).get("idempotency-key")).toBe(
    new Headers(calls[0].headers).get("idempotency-key"),
  );
  view.unmount();
});

it("retains newer rotation feedback when an older provision settles with unchanged inputs", async () => {
  const provision = pending<Response>();
  const rotate = pending<Response>();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (init.method !== "POST") return Response.json(ready);
    return url.endsWith("/provision") ? provision.promise : rotate.promise;
  });
  mount(<ManagedDawarichSetup />);
  await screen.findByText(/OIDC recovery is incomplete/);
  fireEvent.click(screen.getByText("OIDC secret recovery"));
  fireEvent.change(screen.getByRole("textbox", { name: "Type confirmation" }), {
    target: { value: "ROTATE DAWARICH OIDC SECRET" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
  fireEvent.click(screen.getByRole("button", { name: "Rotate OIDC secret" }));
  await act(async () => {
    rotate.resolve(Response.json({ code: "DAWARICH_OAUTH_CLIENT_CONFLICT" }, { status: 409 }));
  });
  expect(screen.getByText(/persisted managed OAuth client is duplicated/)).toBeInTheDocument();
  await act(async () => {
    provision.resolve(
      Response.json({ code: "DAWARICH_DATABASE_SECRET_CONFLICT" }, { status: 409 }),
    );
  });
  expect(screen.getByText(/persisted managed OAuth client is duplicated/)).toBeInTheDocument();
  expect(screen.queryByText(/database password copies conflict/)).not.toBeInTheDocument();
});

it("owns query changes, pause/resume and snapshot reload with distinct logical read identities", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.searchParams.get("follow") === "false")
      return new Response("snapshot-log\n", { headers: { "content-type": "text/plain" } });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("live-log\n"));
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  });
  mount(logs());
  await screen.findByText("live-log");
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Tail lines" }));
  fireEvent.click(await screen.findByRole("option", { name: "500" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0].init.signal?.aborted).toBe(true);
  expect(calls[1].url.searchParams.get("lines")).toBe("500");
  expect(new Headers(calls[1].init.headers).get("idempotency-key")).not.toBe(
    new Headers(calls[0].init.headers).get("idempotency-key"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(calls[1].init.signal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(new Headers(calls[2].init.headers).get("idempotency-key")).not.toBe(
    new Headers(calls[1].init.headers).get("idempotency-key"),
  );
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Log mode" }));
  fireEvent.click(await screen.findByRole("option", { name: "Snapshot" }));
  expect(await screen.findByText("Snapshot complete.")).toBeInTheDocument();
  expect(screen.getByText("snapshot-log")).toBeInTheDocument();
  expect(calls[2].init.signal?.aborted).toBe(true);
  expect(calls[3].url.searchParams.get("follow")).toBe("false");
  expect(calls[3].url.searchParams.has("maxDurationSeconds")).toBe(false);
});
