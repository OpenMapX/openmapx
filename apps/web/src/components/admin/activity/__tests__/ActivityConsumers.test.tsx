import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/test";
import { JobDetail } from "../JobDetail";
import { JobList } from "../JobList";
import { FakeEventSource, job, log, stage, timestamp } from "./fixtures";

let apiUrl = "http://api.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const clients: QueryClient[] = [];
function mount(component: React.ReactNode, mutationRetry = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: mutationRetry, retryDelay: 1 },
    },
  });
  clients.push(client);
  return {
    client,
    ...render(<QueryClientProvider client={client}>{component}</QueryClientProvider>),
  };
}

beforeEach(() => {
  apiUrl = "http://api.test";
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", undefined);
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Activity generated SDK consumers", () => {
  it("rejects list HTTP failure rather than displaying an error envelope as jobs", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Denied" }, { status: 403 }));
    mount(<JobList />);
    expect(await screen.findByText("Failed to load jobs")).toBeInTheDocument();
  });

  it("keeps filtering, pagination, actor display and credentialed list requests", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      requests.push(input);
      expect(init.credentials).toBe("include");
      const { result: _, logs: __, stages: ___, ...row } = job();
      return Response.json({
        jobs: [
          {
            ...row,
            actor: { id: "actor-1", name: "Ada Admin", email: "ada@example.test" },
            createdBy: "actor-1",
            actorLabel: "Ada Admin",
          },
        ],
        total: 60,
      });
    });
    mount(<JobList />);
    expect(await screen.findByText("Ada Admin")).toBeInTheDocument();
    expect(requests[0]).toBe("http://api.test/api/admin/jobs?limit=25&offset=0");
    fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
    await waitFor(() =>
      expect(requests.some((url) => url.endsWith("limit=25&offset=25"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() =>
      expect(
        requests.some((url) => url.includes("status=failed") && url.includes("offset=0")),
      ).toBe(true),
    );
  });

  it("isolates same IDs by origin and source and encodes the SDK path", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/api/admin/jobs/shared%20%2Fid");
      const source = url.searchParams.get("source") as "application" | "data-manager";
      return Response.json(
        job({
          id: "shared /id",
          source,
          status: "success",
          cancelable: false,
          result: { observed: `${url.origin}:${source}` },
        }),
      );
    });
    const { rerender, client } = mount(<JobDetail jobId="shared /id" source="application" />);
    expect(await screen.findByText(/http:\/\/api.test:application/)).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={client}>
        <JobDetail jobId="shared /id" source="data-manager" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/http:\/\/api.test:data-manager/)).toBeInTheDocument();
    apiUrl = "http://second.test";
    rerender(
      <QueryClientProvider client={client}>
        <JobDetail jobId="shared /id" source="data-manager" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/http:\/\/second.test:data-manager/)).toBeInTheDocument();
  });

  it("renders full application logs and data-manager stages without cross-source cancellation", async () => {
    vi.stubGlobal("fetch", async (input: string) =>
      Response.json(
        input.includes("source=application")
          ? job({ logs: [log("Full wire log", 0)], payload: { nested: ["retained", 1] } })
          : job({
              source: "data-manager",
              status: "partial",
              cancelable: false,
              stages: [stage("job-1")],
              result: ["partial", { nested: true }],
            }),
      ),
    );
    const { client, rerender } = mount(<JobDetail jobId="job-1" source="application" />);
    expect(await screen.findByText("Full wire log")).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={client}>
        <JobDetail jobId="job-1" source="data-manager" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("validate")).toBeInTheDocument();
    expect(screen.getByText("Invalid archives — archive-1: Invalid format")).toBeInTheDocument();
    expect(screen.getByText("1.3s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("does not reuse list cache across API origins", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const { result: _, logs: __, stages: ___, ...row } = job();
      return Response.json({
        jobs: [{ ...row, actor: null, actorLabel: new URL(input).origin }],
        total: 1,
      });
    });
    const { client, rerender } = mount(<JobList />);
    expect(await screen.findByText("http://api.test")).toBeInTheDocument();
    apiUrl = "http://second.test";
    rerender(
      <QueryClientProvider client={client}>
        <JobList />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("http://second.test")).toBeInTheDocument();
    expect(screen.queryByText("http://api.test")).not.toBeInTheDocument();
  });

  it("rejects detail HTTP failures and cancels an in-flight query on unmount", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Missing" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const first = mount(<JobDetail jobId="missing" source="data-manager" />);
    expect(await screen.findByText("Failed to load job details.")).toBeInTheDocument();
    first.unmount();
    let signal: AbortSignal | undefined;
    fetcher.mockImplementation(
      (...args: unknown[]) =>
        new Promise<Response>((_resolve, reject) => {
          signal = (args[1] as RequestInit | undefined)?.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = mount(<JobDetail jobId="pending" source="application" />);
    await waitFor(() => expect(signal).toBeDefined());
    pending.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts list acquisition on unmount and bounds stalled JSON reads", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) throw new Error("Missing query cancellation signal");
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const list = mount(<JobList />);
    await act(async () => {});
    expect(signals).toHaveLength(1);
    list.unmount();
    expect(signals[0]?.aborted).toBe(true);
    mount(<JobDetail jobId="stalled" source="data-manager" />);
    await act(async () => {});
    expect(signals).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Failed to load job details.")).toBeInTheDocument();
  });

  it("cancels the encoded source-specific job once and invalidates jobs only on success", async () => {
    const requests: string[] = [];
    let cancelSucceeds = false;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (init.method === "POST") {
        requests.push(input);
        return cancelSucceeds
          ? Response.json({ ok: true })
          : Response.json({ error: "Cancel rejected" }, { status: 403 });
      }
      return Response.json(job({ id: "cancel /id" }));
    });
    const { client } = mount(<JobDetail jobId="cancel /id" source="application" />, true);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(client.getMutationCache().getAll().at(-1)?.state.status).toBe("error"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toEqual([
      "http://api.test/api/admin/jobs/cancel%20%2Fid/cancel?source=application",
    ]);
    expect(invalidate).not.toHaveBeenCalled();
    cancelSucceeds = true;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "jobs"] }));
    expect(requests).toHaveLength(2);
  });

  it("refreshes list/detail once on a valid end and ignores later frames", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", async (input: string) =>
      input.includes("?limit=") ? Response.json({ jobs: [], total: 0 }) : Response.json(job()),
    );
    const { client } = mount(
      <>
        <JobList />
        <JobDetail jobId="job-1" source="application" />
      </>,
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("Missing native stream");
    act(() => source.emit("snapshot", { job: job() }));
    act(() => source.emit("end", { status: "success" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "jobs"] });
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    act(() => {
      source.emit("end", { status: "success" });
      source.emit("status", { type: "status", status: "running" });
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });

  it("polls after transport fallback and stops polling at terminal state", async () => {
    vi.useFakeTimers();
    let reads = 0;
    vi.stubGlobal("fetch", async () =>
      Response.json(
        job({
          status: ++reads === 1 ? "running" : "success",
          cancelable: reads === 1,
        }),
      ),
    );
    mount(<JobDetail jobId="job-1" source="application" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toBe(2);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(2);
  });

  it("keeps polling a pending cancellation to terminal without repeating the cancel request", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let cancels = 0;
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      if (init.method === "POST") {
        cancels += 1;
        // Real runner pending outcome returns the existing unsuccessful cancel envelope.
        return Response.json(
          { error: "Job cannot be canceled (not running or queued)" },
          { status: 400 },
        );
      }
      reads += 1;
      return Response.json({
        ...job(),
        status: reads === 1 ? "running" : reads < 4 ? "cancel_pending" : "canceled",
        // Deliberately retain an advisory true flag: pending must never offer Cancel.
        cancelable: true,
      });
    });
    mount(<JobDetail jobId="job-1" source="application" />, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toBe(2);
    expect(screen.getByText("cancel_pending")).toBeInTheDocument();
    expect(screen.getByText("Polling")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toBe(4);
    expect(screen.getByText("canceled")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads).toBe(4);
    expect(cancels).toBe(1);
  });

  it("shows refreshed polling results after a malformed frame instead of keeping stale streamed data", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let read = 0;
    vi.stubGlobal("fetch", async () =>
      Response.json(
        job({
          status: read++ ? "success" : "running",
          cancelable: read === 1,
          finishedAt: read > 1 ? timestamp : null,
        }),
      ),
    );
    const { client } = mount(<JobDetail jobId="job-1" source="application" />);
    await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("Missing native stream");
    act(() => source.emit("snapshot", { job: job() }));
    act(() => source.emit("progress", { progress: "invalid" }));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["admin", "jobs"] });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument(),
    );
  });
});

it("shows unknown observation and independent retained diagnostics while cancellation is pending", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      job({
        status: "cancel_pending",
        cancelable: false,
        result: {
          observation: { state: "unknown", reason: "transport", nextCheckAt: timestamp },
          serviceBatch: {
            outcome: "partial",
            completedServiceIds: ["tileserver"],
            failedServiceIds: ["valhalla"],
            skippedServiceIds: [],
          },
          diagnostics: {
            truncated: true,
            tail: [{ stream: "stderr", message: "retained final diagnostic" }],
          },
        },
        logs: [],
      }),
    ),
  );
  mount(<JobDetail jobId="job-1" source="application" />);
  expect(
    await screen.findByText("Outcome unknown; checking retained operation status."),
  ).toBeInTheDocument();
  expect(screen.getByText("Retained diagnostics")).toBeInTheDocument();
  expect(screen.getByText("retained final diagnostic")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
});
