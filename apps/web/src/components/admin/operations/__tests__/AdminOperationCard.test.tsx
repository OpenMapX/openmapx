// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor } from "@/test";
import { AdminOperationCard } from "../AdminOperationCard";
import { type AdminOperationContract, initialFormValues } from "../adminOperationsApi";

const responses: unknown[] = [];
const fetchCalls: Array<[string, RequestInit | undefined]> = [];
vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  fetchCalls.push([url, init]);
  return responses.shift();
});

const updateContract: AdminOperationContract = {
  id: "update",
  version: 1,
  group: "osm",
  title: "Full Update Pipeline",
  description: "Refreshes OSM data.",
  risk: "normal",
  fields: [
    { name: "region", label: "Region", kind: "text", placeholder: "e.g. europe/germany" },
    { name: "failFast", label: "Fail fast", kind: "boolean" },
  ],
  defaults: { region: "", failFast: false },
};

const cleanContract: AdminOperationContract = {
  id: "clean",
  version: 1,
  group: "osm",
  title: "Cleanup Data",
  description: "Removes data files.",
  risk: "destructive",
  confirmation: { title: "Confirm data cleanup", message: "This removes local data files." },
  fields: [{ name: "target", label: "Target", kind: "text", required: true }],
  defaults: { target: "all" },
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  responses.length = 0;
  fetchCalls.length = 0;
});

describe("initialFormValues", () => {
  it("seeds every field from the contract defaults", () => {
    expect(initialFormValues(updateContract)).toEqual({ region: "", failFast: false });
    expect(initialFormValues(cleanContract)).toEqual({ target: "all" });
  });
});

describe("AdminOperationCard", () => {
  it("previews the server effect, then queues on confirm", async () => {
    responses.push(
      jsonResponse(200, {
        ok: true,
        input: { region: "europe/germany", failFast: true },
        preview: ["Update OSM data for europe/germany", "Stop at the first failing step"],
        risk: "normal",
      }),
      jsonResponse(200, { ok: true, jobId: "job-9" }),
    );
    const onQueued = vi.fn();
    const onError = vi.fn();
    render(
      <AdminOperationCard
        apiUrl="http://api.test"
        operation={updateContract}
        onQueued={onQueued}
        onError={onError}
      />,
      { wrapper: createQueryWrapper() },
    );

    await userEvent.type(screen.getByLabelText("Region"), "europe/germany");
    await userEvent.click(screen.getByLabelText("Fail fast"));
    await userEvent.click(screen.getByRole("button", { name: "Queue Full Update Pipeline" }));

    expect(await screen.findByText("Update OSM data for europe/germany")).toBeTruthy();
    expect(fetchCalls[0]?.[0]).toBe("http://api.test/api/admin/operations/update/preview");
    expect(JSON.parse(String(fetchCalls[0]?.[1]?.body))).toEqual({
      region: "europe/germany",
      failFast: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onQueued).toHaveBeenCalledWith("job-9", updateContract));
    expect(fetchCalls[1]?.[0]).toBe("http://api.test/api/admin/operations/update/run");
    expect(onError).not.toHaveBeenCalled();
  });

  it("shows server validation issues on the offending field", async () => {
    responses.push(
      jsonResponse(400, {
        ok: false,
        error: "region: Use lowercase path segments",
        issues: [{ path: "region", message: "Use lowercase path segments" }],
      }),
    );
    const onError = vi.fn();
    render(
      <AdminOperationCard
        apiUrl="http://api.test"
        operation={updateContract}
        onQueued={vi.fn()}
        onError={onError}
      />,
      { wrapper: createQueryWrapper() },
    );
    await userEvent.type(screen.getByLabelText("Region"), "Europe");
    await userEvent.click(screen.getByRole("button", { name: "Queue Full Update Pipeline" }));
    expect(await screen.findByText("Use lowercase path segments")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the confirmation warning for destructive operations", async () => {
    responses.push(
      jsonResponse(200, {
        ok: true,
        input: { target: "all" },
        preview: ["Remove local data files for target all"],
        risk: "destructive",
        confirmation: cleanContract.confirmation,
      }),
    );
    render(
      <AdminOperationCard
        apiUrl="http://api.test"
        operation={cleanContract}
        onQueued={vi.fn()}
        onError={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );
    await userEvent.click(screen.getByRole("button", { name: "Queue Cleanup Data" }));
    expect(await screen.findByText("Confirm data cleanup")).toBeTruthy();
    expect(screen.getByText("This removes local data files.")).toBeTruthy();
    expect(screen.getByText("Remove local data files for target all")).toBeTruthy();
  });

  it("disables queueing while a required field is blank", async () => {
    render(
      <AdminOperationCard
        apiUrl="http://api.test"
        operation={cleanContract}
        onQueued={vi.fn()}
        onError={vi.fn()}
      />,
      { wrapper: createQueryWrapper() },
    );
    const button = screen.getByRole("button", { name: "Queue Cleanup Data" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.clear(screen.getByLabelText(/Target/));
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
