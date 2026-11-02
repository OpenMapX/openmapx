/**
 * The app's single owner of browser history.
 *
 * Mobile users expect the system Back gesture to step out of whatever they
 * opened — a sheet, a dialog, a place card — before it leaves the app. That
 * only works if opening those surfaces adds history entries. Two kinds are
 * written here:
 * - navigation entries, for the URL-encoded app state (`writeNavigation`);
 * - layer entries, the same URL again, for a transient surface that Back
 *   should dismiss without changing that state (`openBackLayer`).
 *
 * Closing something never traverses history itself. A `history.back()` from
 * app code is a popstate like any other to the Next.js router, and it cancels
 * a route navigation in flight — a drawer link that closes the drawer and
 * opens another page would silently stay on the map. So a closed surface
 * leaves its entry where it is: a closed layer's entry is marked dead, a
 * closed panel's entry is rewritten to what is open now. A later Back that
 * lands somewhere showing exactly what was already shown keeps going, and the
 * next surface to open reuses such an entry instead of stacking on it.
 *
 * Each entry carries `omx` metadata in `history.state`, beside Next.js's own
 * keys, which are always spread through unchanged.
 */

/** Ordered surfaces the URL has open, outermost first. See `navigationPath` in deepLink. */
export type NavigationPath = readonly string[];

interface EntryMeta {
  /** Entries this app pushed beneath this one. 0 for an entry it never pushed. */
  depth: number;
  /** The navigation path of the entry right below, for a navigation entry this module pushed. */
  below?: NavigationPath;
  /** The layer this entry was pushed for. */
  layer?: string;
  /** The page load that wrote this entry; layer ids and reuse only mean something within it. */
  doc?: string;
}

interface Layer {
  /** Depth of the layer's own entry; null until its push has actually run. */
  depth: number | null;
  onBack: () => void;
  /** Its owner closed it; its entry, if any, is left for Back to step over. */
  dead: boolean;
}

export interface BackLayerHandle {
  /** The owner closed the layer itself. */
  release(): void;
}

export interface NavigationWrite {
  url: string;
  path: NavigationPath;
  /** Path of the URL currently in the address bar. */
  currentPath: NavigationPath;
}

export type HistoryStep = "replace" | "push";

/**
 * Applies the entry a Back/Forward landed on. Returns whether that changed
 * what is open; Back keeps going while nothing changes.
 */
export type HistoryRestoreListener = () => boolean;

const STATE_KEY = "omx";
/** A step-over whose popstate never arrives must not wedge every later write. */
const POP_TIMEOUT_MS = 1000;
const DOCUMENT_ID = Math.random().toString(36).slice(2);

const layers = new Map<string, Layer>();
const restoreListeners = new Set<HistoryRestoreListener>();
let queue: Array<() => void> = [];
/**
 * A step over a leftover entry, in flight. `unchanged` keeps stepping until
 * something changes; `stale` only clears a leftover layer entry reached from
 * another page, whose map is still mounting and cannot say what changed.
 */
let pending: { reason: "unchanged" | "stale"; timer: ReturnType<typeof setTimeout> } | null = null;
/** The entry last seen current: the one a traversal leaves. */
let last: { meta: EntryMeta; pathname: string } | null = null;
let layerSeq = 0;
let listening = false;

export function samePath(a: NavigationPath, b: NavigationPath): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/** Whether `prefix` is `path` with one or more innermost surfaces closed. */
export function isStrictPrefix(prefix: NavigationPath, path: NavigationPath): boolean {
  return prefix.length < path.length && prefix.every((segment, index) => segment === path[index]);
}

function segmentKind(segment: string): string {
  const colon = segment.indexOf(":");
  return colon === -1 ? segment : segment.slice(0, colon);
}

/**
 * How a change of navigation path is recorded.
 *
 * Opening something deeper or different is a new entry. Closing rewrites the
 * current one, so a later Back cannot reopen what the user just closed.
 * Switching between siblings (another place in the same list, another
 * category chip) rewrites too: tapping through pins on a map is browsing, not
 * drilling in.
 */
export function historyStep(current: NavigationPath, next: NavigationPath): HistoryStep {
  if (samePath(current, next) || isStrictPrefix(next, current)) return "replace";
  const lastIndex = current.length - 1;
  if (
    current.length > 0 &&
    current.length === next.length &&
    samePath(current.slice(0, lastIndex), next.slice(0, lastIndex)) &&
    segmentKind(current[lastIndex]) === segmentKind(next[lastIndex])
  ) {
    return "replace";
  }
  return "push";
}

function readMeta(state: unknown = window.history.state): EntryMeta {
  const meta = (state as Record<string, unknown> | null)?.[STATE_KEY];
  if (!meta || typeof meta !== "object") return { depth: 0 };
  const { depth, below, layer, doc } = meta as Partial<EntryMeta>;
  return {
    depth: typeof depth === "number" && Number.isFinite(depth) ? depth : 0,
    ...(Array.isArray(below) ? { below: below.filter((s) => typeof s === "string") } : {}),
    ...(typeof layer === "string" ? { layer } : {}),
    ...(typeof doc === "string" ? { doc } : {}),
  };
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function remember(meta: EntryMeta): void {
  last = { meta, pathname: window.location.pathname };
}

function writeEntry(mode: "push" | "replace", meta: EntryMeta, url: string): void {
  // Spreading the current state keeps Next.js's router keys; its patched
  // history methods then pass the call straight through.
  const state = { ...(window.history.state ?? {}), [STATE_KEY]: meta };
  if (mode === "push") window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
  remember(meta);
}

function isLive(id: string | undefined): boolean {
  const layer = id ? layers.get(id) : undefined;
  return Boolean(layer && !layer.dead);
}

/**
 * An entry that shows nothing the entry below does not: a closed layer's, or
 * a panel entry rewritten after its panel closed. The next surface to open
 * takes it over instead of stacking another entry on top.
 */
function isRedundant(meta: EntryMeta, currentPath: NavigationPath | null): boolean {
  if (meta.doc !== DOCUMENT_ID || meta.depth === 0) return false;
  if (meta.layer) return !isLive(meta.layer);
  return Boolean(meta.below && currentPath && samePath(meta.below, currentPath));
}

/** Anything at or above this depth was in forward history, which a write there discarded. */
function pruneFrom(depth: number): void {
  for (const [id, layer] of layers) {
    if (layer.depth !== null && layer.depth >= depth) layers.delete(id);
  }
}

function run(op: () => void): void {
  if (pending) queue.push(op);
  else op();
}

function drain(): void {
  while (!pending && queue.length > 0) queue.shift()?.();
}

function stepOver(reason: "unchanged" | "stale"): void {
  pending = { reason, timer: setTimeout(settleTimeout, POP_TIMEOUT_MS) };
  window.history.back();
}

function settleTimeout(): void {
  pending = null;
  remember(readMeta());
  drain();
}

function notifyRestore(): boolean {
  let changed = false;
  for (const listener of [...restoreListeners]) changed = listener() || changed;
  return changed;
}

function closeLayersAbove(depth: number): boolean {
  let closed = false;
  const above = [...layers].filter(([, layer]) => layer.depth !== null && layer.depth > depth);
  above.sort(([, a], [, b]) => (b.depth ?? 0) - (a.depth ?? 0));
  for (const [id, layer] of above) {
    layers.delete(id);
    if (layer.dead) continue;
    layer.onBack();
    closed = true;
  }
  return closed;
}

function onPopState(event: PopStateEvent): void {
  const meta = readMeta(event.state);
  const left = last ?? { meta, pathname: window.location.pathname };
  remember(meta);
  const reason = pending?.reason;
  if (pending) {
    clearTimeout(pending.timer);
    pending = null;
  }

  const back = meta.depth < left.meta.depth;
  let changed = back && closeLayersAbove(meta.depth);
  // On another page the router takes it from here.
  const samePage = window.location.pathname === left.pathname;
  if (samePage) changed = notifyRestore() || changed;

  // Back should always visibly do something. Landing on an entry that shows
  // what was already shown — the one under a dialog closed by its own button,
  // or under a panel entry rewritten when the panel closed — means this Back
  // only crossed leftovers, so it keeps going.
  const leftOurs = left.meta.doc === DOCUMENT_ID;
  if (!changed && samePage && back && leftOurs && reason !== "stale") {
    stepOver("unchanged");
    return;
  }
  // A leftover layer entry reached from another page (whose own entry this
  // module never saw) is stepped over too, unless this was a Forward.
  const staleLayer = meta.layer !== undefined && !isLive(meta.layer);
  if (!changed && staleLayer && meta.depth <= left.meta.depth) {
    stepOver("stale");
    return;
  }
  drain();
}

function ensureListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  remember(readMeta());
  window.addEventListener("popstate", onPopState);
}

/**
 * Records the app's URL state. `build` runs when the write actually happens —
 * possibly after a step-over in flight lands — so it must read state then.
 */
export function writeNavigation(build: () => NavigationWrite): void {
  if (typeof window === "undefined") return;
  ensureListening();
  run(() => {
    const { url, path, currentPath } = build();
    const meta = readMeta();

    // A live layer is on top: URL changes underneath it are recorded on its
    // entry, and a newly opened surface goes above it, so Back closes that
    // first and the layer after.
    const step = isLive(meta.layer)
      ? samePath(currentPath, path)
        ? "replace"
        : "push"
      : historyStep(currentPath, path);

    if (step === "push") {
      const reuse = isRedundant(meta, currentPath);
      const depth = reuse ? meta.depth : meta.depth + 1;
      pruneFrom(depth);
      const entry = { depth, below: currentPath, doc: DOCUMENT_ID };
      writeEntry(reuse ? "replace" : "push", entry, url);
      return;
    }
    if (url !== currentUrl() || !window.history.state?.[STATE_KEY]) {
      writeEntry("replace", meta, url);
    }
  });
}

/**
 * Gives a transient surface its own history entry; Back then calls `onBack`
 * instead of leaving the page. `onBack` should close the surface the same way
 * its own close control does.
 */
export function openBackLayer(onBack: () => void): BackLayerHandle {
  ensureListening();
  layerSeq += 1;
  const id = `layer-${layerSeq}`;
  const layer: Layer = { depth: null, onBack, dead: false };
  layers.set(id, layer);
  run(() => {
    if (layer.dead) {
      layers.delete(id);
      return;
    }
    const meta = readMeta();
    // Only a closed layer's entry is taken over here: a layer has no
    // navigation path to judge a panel entry by.
    const reuse = meta.layer !== undefined && isRedundant(meta, null);
    const depth = reuse ? meta.depth : meta.depth + 1;
    pruneFrom(depth);
    layer.depth = depth;
    writeEntry(reuse ? "replace" : "push", { depth, layer: id, doc: DOCUMENT_ID }, currentUrl());
  });
  return {
    release: () => {
      layer.dead = true;
    },
  };
}

/** Called when Back/Forward lands on an entry of the current page. */
export function subscribeHistoryRestore(listener: HistoryRestoreListener): () => void {
  ensureListening();
  restoreListeners.add(listener);
  return () => {
    restoreListeners.delete(listener);
  };
}

/** Test seam: whether a step-over is still in flight. */
export function isBackNavigationIdle(): boolean {
  return !pending;
}

/** Test seam: forget all in-memory bookkeeping. */
export function resetBackNavigationForTests(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
  queue = [];
  layers.clear();
  restoreListeners.clear();
  last = null;
  if (typeof window !== "undefined" && listening) remember(readMeta());
}
