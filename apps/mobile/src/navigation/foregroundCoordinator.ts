import type { NavigationCoordinator } from "./NavigationCoordinator";

/**
 * The coordinator the visible app composed, if this process has one.
 *
 * The operating system delivers location batches to the background task in
 * whichever process is alive. When that is the app the user is looking at, the
 * batch belongs to the coordinator wired to the page, so progress reaches the
 * WebView as it happens. Only a process started without the app (a headless
 * launch) falls back to the coordinator that persists and defers.
 *
 * Both share one repository, processors and executor, so either path advances
 * the same session in the same order.
 */
const listeners = new Set<() => void>();
export function onForegroundCoordinatorChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let current: NavigationCoordinator | null = null;

export function registerForegroundCoordinator(coordinator: NavigationCoordinator): () => void {
  current = coordinator;
  for (const listener of listeners) listener();
  return () => {
    if (current === coordinator) {
      current = null;
      for (const listener of listeners) listener();
    }
  };
}

export function foregroundCoordinator(): NavigationCoordinator | null {
  return current;
}
