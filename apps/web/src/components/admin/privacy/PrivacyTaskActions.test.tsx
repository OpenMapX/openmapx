import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyTaskActions } from "./PrivacyTaskActions";
import { privacyDetail } from "./privacyFixtures.test-support";
import { privacyJson, renderPrivacyComponent } from "./privacyTestClient.test-support";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(() => vi.unstubAllGlobals());
describe("operator task actions", () => {
  it("submits an explicit zero record count as complete without treating assignment as completion", async () => {
    const detail = privacyDetail();
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, rawInit: unknown) => {
        const init = rawInit as RequestInit | undefined;
        if (String(url).includes("/operators?"))
          return privacyJson({
            operators: [{ id: "synthetic-worker", name: "Caseworker" }],
            nextCursor: null,
          });
        writes.push(JSON.parse(String(init?.body)));
        return privacyJson({ ok: true });
      }),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    fireEvent.mouseDown(screen.getByLabelText("privacyAdmin.workflows.taskDecision"));
    fireEvent.click(
      await screen.findByRole("option", { name: "privacyAdmin.workflows.taskStates.complete" }),
    );
    const button = screen.getByRole("button", {
      name: "privacyAdmin.workflows.recordTaskDecision",
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("privacyAdmin.workflows.recordCount"), {
      target: { value: "0" },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(writes).toEqual([{ version: 3, status: "complete", recordCount: 0 }]),
    );
  });
  it("fails closed when server actions deny collector completion", () => {
    const detail = privacyDetail();
    detail.tasks[0]!.actions = [];
    detail.tasks[0]!.status = "running";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => privacyJson({ operators: [], nextCursor: null })),
    );
    renderPrivacyComponent(detail, (client) => (
      <PrivacyTaskActions detail={detail} client={client} />
    ));
    expect(
      screen.getByRole("button", { name: "privacyAdmin.workflows.recordTaskDecision" }),
    ).toBeDisabled();
  });
});
