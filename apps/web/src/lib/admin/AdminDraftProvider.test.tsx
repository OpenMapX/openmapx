import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@/test";
import { AdminDraftProvider } from "./AdminDraftProvider";
import { allowAdminDocumentExit } from "./adminDocumentExit";
import { useAdminDraft } from "./useAdminDraft";

const baseline = { label: "saved", password: "never" };
function Form() {
  const draft = useAdminDraft({ id: "sample", baseline, editableKeys: ["label"], signature: "v1" });
  return (
    <>
      <input
        aria-label="Label"
        value={String(draft.values.label)}
        onChange={(e) => draft.setValues({ ...draft.values, label: e.target.value })}
      />
      <button type="button" onClick={() => draft.discard()}>
        Discard
      </button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const exit = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
it("retains only ordinary allowlisted values across tab and soft map navigation", () => {
  const view = (show: boolean) => (
    <AdminDraftProvider>{show ? <Form /> : <div>Map</div>}</AdminDraftProvider>
  );
  const { rerender } = render(view(true));
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "draft" } });
  rerender(view(false));
  expect(exit()).toBe(true);
  rerender(view(true));
  expect(screen.getByLabelText("Label")).toHaveValue("draft");
  fireEvent.click(screen.getByText("Discard"));
  expect(exit()).toBe(false);
});
it("bypasses only the immediate download and restores warning for later real exits", () => {
  render(
    <AdminDraftProvider>
      <Form />
    </AdminDraftProvider>,
  );
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "draft" } });
  allowAdminDocumentExit("download");
  expect(exit()).toBe(false);
  expect(exit()).toBe(true);
  const reset = allowAdminDocumentExit("download");
  reset();
  expect(exit()).toBe(true);
  vi.useFakeTimers();
  allowAdminDocumentExit("download");
  vi.advanceTimersByTime(1100);
  expect(exit()).toBe(true);
});

function ManyForm({ id }: { id: string }) {
  const draft = useAdminDraft({
    id,
    baseline: { label: "saved" },
    editableKeys: ["label"],
    signature: "v1",
  });
  return (
    <input
      aria-label={id}
      value={String(draft.values.label)}
      onChange={(event) =>
        draft.setValues((previous) => ({ ...previous, label: event.target.value }))
      }
    />
  );
}
it("still accepts an edit after an old clean entry is evicted from the cache", () => {
  render(
    <AdminDraftProvider>
      {Array.from({ length: 40 }, (_, id) => (
        <ManyForm key={id} id={`form-${id}`} />
      ))}
    </AdminDraftProvider>,
  );
  fireEvent.change(screen.getByLabelText("form-0"), { target: { value: "edited after eviction" } });
  expect(screen.getByLabelText("form-0")).toHaveValue("edited after eviction");
  expect(exit()).toBe(true);
});
