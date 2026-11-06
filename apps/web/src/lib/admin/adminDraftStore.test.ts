import { describe, expect, it } from "vitest";
import { AdminDraftStore } from "./adminDraftStore";

const actor = { apiUrl: "https://a.test", actorId: "admin", role: "admin" };
function fixture() {
  const store = new AdminDraftStore();
  store.bind(actor);
  store.reconcile("form", { x: "old", y: "clean" }, ["x", "y"]);
  return store;
}
describe("ordinary admin drafts", () => {
  it("keeps edits across remounts and refreshes only clean keys", () => {
    const s = fixture();
    s.update("form", { x: "mine" });
    s.reconcile("form", { x: "old", y: "other admin" }, ["x", "y"]);
    expect(s.read("form").values).toEqual({ x: "mine", y: "other admin" });
    expect(s.read("form").dirtyKeys).toEqual(["x"]);
  });
  it("requires conflict review against the baseline at first edit", () => {
    const s = fixture();
    s.update("form", { x: "mine" });
    s.reconcile("form", { x: "theirs", y: "clean" }, ["x", "y"]);
    expect(s.read("form").conflicts).toEqual(["x"]);
    s.keepEdits("form");
    expect(s.read("form").conflicts).toEqual([]);
    s.discard("form");
    expect(s.read("form").values.x).toBe("theirs");
  });
  it("drops removed or host-owned keys and never admits a non-allowlisted value", () => {
    const s = fixture();
    s.update("form", { x: "mine", password: "secret" });
    s.reconcile("form", { x: "host", y: "clean", password: "secret" }, ["y"]);
    expect(s.read("form").values).toEqual({ y: "clean" });
    expect(s.dirty).toBe(false);
  });
  it("acknowledges only submitted values still current and fences old authority callbacks", () => {
    const s = fixture(),
      generation = s.generation;
    s.update("form", { x: "first" });
    s.update("form", { x: "second" });
    s.acknowledge("form", { x: "first" }, generation);
    expect(s.read("form").dirtyKeys).toEqual(["x"]);
    s.acknowledge("form", { x: "second" }, generation);
    expect(s.dirty).toBe(false);
    s.bind({ ...actor, apiUrl: "https://b.test" });
    s.bind(actor);
    s.reconcile("form", { x: "fresh" }, ["x"]);
    s.update("form", { x: "replacement" });
    s.acknowledge("form", { x: "replacement" }, generation);
    expect(s.dirty).toBe(true);
  });
  it("keeps all dirty entries while bounding only clean cache entries", () => {
    const s = fixture();
    for (let i = 0; i < 40; i++) {
      s.reconcile(`dirty-${i}`, { x: 0 }, ["x"]);
      s.update(`dirty-${i}`, { x: 1 });
    }
    for (let i = 0; i < 40; i++) s.reconcile(`clean-${i}`, { x: 0 }, ["x"]);
    for (let i = 0; i < 40; i++) expect(s.read(`dirty-${i}`).values.x).toBe(1);
    expect(s.cleanCount).toBeLessThanOrEqual(32);
  });
  it("ignores failed/pending session reads but clears confirmed logout and replacement", () => {
    const s = fixture();
    s.update("form", { x: "mine" });
    s.observeSession({ data: null, isPending: false, error: new Error("offline") });
    expect(s.dirty).toBe(true);
    s.observeSession({ data: null, isPending: true, error: null });
    expect(s.dirty).toBe(true);
    s.observeSession({
      data: { user: { id: "admin", role: "admin" }, session: { id: "one" } },
      isPending: false,
    });
    expect(s.dirty).toBe(true);
    s.observeSession({
      data: { user: { id: "admin", role: "admin" }, session: { id: "two" } },
      isPending: false,
    });
    expect(s.dirty).toBe(false);
    s.bind(actor);
    s.reconcile("form", { x: "old" }, ["x"]);
    s.update("form", { x: "mine" });
    s.observeSession({ data: null, isPending: false, error: null });
    expect(s.dirty).toBe(false);
  });
});

it("discards or reviews only the keys in the active settings panel", () => {
  const s = fixture();
  s.update("form", { x: "mine", y: "also mine" });
  s.reconcile("form", { x: "their x", y: "their y" }, ["x", "y"]);
  s.keepEdits("form", ["x"]);
  expect(s.read("form").conflicts).toEqual(["y"]);
  s.discard("form", ["x"]);
  expect(s.read("form").values).toEqual({ x: "their x", y: "also mine" });
});

it("does not flag its own acknowledged save as a conflict with a newer edit", () => {
  const s = fixture();
  s.update("form", { x: "submitted" });
  s.update("form", { x: "newer" });
  s.acknowledge("form", { x: "submitted" });
  expect(s.read("form").values.x).toBe("newer");
  expect(s.read("form").conflicts).toEqual([]);
});
it("retains a null baseline across repeated edits for conflict detection", () => {
  const s = fixture();
  s.reconcile("form", { x: null }, ["x"]);
  s.update("form", { x: "first" });
  s.reconcile("form", { x: "theirs" }, ["x"]);
  s.update("form", { x: "second" });
  expect(s.read("form").conflicts).toEqual(["x"]);
});

it("notifies metadata consumers of explicit discard separately from a reauthentication exit", () => {
  const store = new AdminDraftStore();
  const events: unknown[] = [];
  const stop = store.subscribeDiscard((event) => events.push(event));
  store.discard("form");
  store.discard(undefined, undefined, "reauthentication");
  stop();
  store.discard();
  expect(events).toEqual([
    { id: "form", reason: "discard" },
    { id: undefined, reason: "reauthentication" },
  ]);
});
