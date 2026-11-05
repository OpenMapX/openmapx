export type AdminDraftDiscardReason = "discard" | "reauthentication";
export type AdminDraftDiscard = { id?: string; reason: AdminDraftDiscardReason };
export interface AdminDraftOwner {
  apiUrl: string;
  actorId: string;
  role: string;
}
type Values = Record<string, unknown>;
type Entry = { baseline: Values; edits: Map<string, { value: unknown; baseline: unknown }> };
type SessionRead = {
  data?: { user?: { id?: string; role?: string | null }; session?: { id?: string } } | null;
  isPending: boolean;
  error?: unknown;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ordinary allowlisted values only. Owned by one root React provider, never persisted. */
export class AdminDraftStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private discardListeners = new Set<(event: AdminDraftDiscard) => void>();
  subscribeDiscard = (listener: (event: AdminDraftDiscard) => void) => {
    this.discardListeners.add(listener);
    return () => {
      this.discardListeners.delete(listener);
    };
  };
  private version = 0;
  private owner: AdminDraftOwner | null = null;
  private origin: string | undefined;
  private session: SessionRead["data"] | undefined;
  generation = 0;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  authoritySnapshot = () => JSON.stringify([this.generation, this.scopeKey]);
  private emit() {
    this.version++;
    this.listeners.forEach((fn) => {
      fn();
    });
  }
  get authority() {
    return this.owner;
  }
  get scopeKey() {
    return this.owner ? JSON.stringify([this.owner.actorId, this.owner.role]) : null;
  }
  get dirty() {
    return [...this.entries.values()].some((entry) => entry.edits.size > 0);
  }
  dirtyCount = () => [...this.entries.values()].filter((entry) => entry.edits.size > 0).length;
  get cleanCount() {
    return [...this.entries.values()].filter((entry) => entry.edits.size === 0).length;
  }
  private trim() {
    let count = this.cleanCount;
    for (const [id, entry] of this.entries) {
      if (count <= 32) break;
      if (!entry.edits.size) {
        this.entries.delete(id);
        count--;
      }
    }
  }
  clear() {
    this.entries.clear();
    this.generation++;
    this.emit();
  }
  setOrigin(apiUrl: string) {
    if (this.origin !== undefined && this.origin !== apiUrl) {
      this.owner = null;
      this.session = undefined;
      this.clear();
    }
    this.origin = apiUrl;
  }
  bind(owner: AdminDraftOwner) {
    if (
      this.session === null ||
      (this.session?.user?.id &&
        (this.session.user.id !== owner.actorId ||
          (this.session.user.role && this.session.user.role !== owner.role)))
    )
      return;
    this.setOrigin(owner.apiUrl);
    if (JSON.stringify(this.owner) !== JSON.stringify(owner)) {
      this.clear();
      this.owner = owner;
    }
  }
  observeSession(read: SessionRead) {
    if (read.isPending || read.error || read.data === undefined) return;
    const next = read.data;
    if (next === null) {
      if (this.session !== null || this.owner) this.clear();
      this.owner = null;
      this.session = null;
      return;
    }
    if (!next.user?.id || !next.session?.id) return;
    const replaced =
      (this.session?.session?.id && this.session.session.id !== next.session.id) ||
      (this.owner &&
        (this.owner.actorId !== next.user.id ||
          (next.user.role && this.owner.role !== next.user.role)));
    if (replaced) {
      this.clear();
      this.owner = null;
    }
    this.session = next;
  }
  has(id: string) {
    return this.entries.has(id);
  }
  read(id: string) {
    const entry = this.entries.get(id);
    const values: Values = { ...entry?.baseline };
    const conflicts: string[] = [];
    for (const [key, edit] of entry?.edits ?? []) {
      values[key] = edit.value;
      if (!equal(edit.baseline, entry?.baseline[key])) conflicts.push(key);
    }
    return { values, dirtyKeys: [...(entry?.edits.keys() ?? [])], conflicts };
  }
  reconcile(
    id: string,
    baseline: Values,
    editableKeys: readonly string[],
    generation = this.generation,
  ) {
    if (generation !== this.generation) return;
    const allowed = new Set(editableKeys);
    const next = Object.fromEntries(Object.entries(baseline).filter(([key]) => allowed.has(key)));
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { baseline: next, edits: new Map() };
      this.entries.set(id, entry);
      this.trim();
      this.emit();
      return;
    }
    let changed = !equal(entry.baseline, next);
    entry.baseline = next;
    for (const [key, edit] of entry.edits)
      if (!Object.hasOwn(next, key) || equal(edit.value, next[key])) {
        entry.edits.delete(key);
        changed = true;
      }
    if (changed) this.emit();
  }
  update(id: string, values: Values, generation = this.generation) {
    if (generation !== this.generation) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(entry.baseline, key)) continue;
      if (equal(value, entry.baseline[key])) entry.edits.delete(key);
      else
        entry.edits.set(key, {
          value,
          baseline: entry.edits.has(key) ? entry.edits.get(key)?.baseline : entry.baseline[key],
        });
    }
    this.emit();
  }
  acknowledge(id: string, submitted: Values, generation = this.generation) {
    if (generation !== this.generation) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const [key, value] of Object.entries(submitted)) {
      if (!Object.hasOwn(entry.baseline, key)) continue;
      entry.baseline[key] = value;
      const edit = entry.edits.get(key);
      if (equal(edit?.value, value)) entry.edits.delete(key);
      else if (edit) edit.baseline = value;
    }
    this.trim();
    this.emit();
  }
  discard(id?: string, keys?: readonly string[], reason: AdminDraftDiscardReason = "discard") {
    for (const [key, entry] of this.entries)
      if (!id || id === key) {
        if (keys) for (const field of keys) entry.edits.delete(field);
        else entry.edits.clear();
      }
    this.trim();
    this.discardListeners.forEach((listener) => {
      listener({ id, reason });
    });
    this.emit();
  }
  keepEdits(id: string, keys?: readonly string[]) {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const [key, edit] of entry.edits)
      if (!keys || keys.includes(key)) edit.baseline = entry.baseline[key];
    this.emit();
  }
}
