/** Unit-only Next navigation adapter. Browser history acceptance is verified separately. */
import { useSyncExternalStore } from "react";
import { afterEach } from "vitest";

let entries = ["/admin"],
  index = 0;
const listeners = new Set<() => void>();
const emit = () =>
  listeners.forEach((fn) => {
    fn();
  });
const read = () => entries[index];
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const adminTestHistory = {
  push(url: string) {
    entries = [...entries.slice(0, index + 1), url];
    index++;
    emit();
  },
  replace(url: string) {
    entries[index] = url;
    emit();
  },
  back() {
    index = Math.max(0, index - 1);
    emit();
  },
  reset(url = "/admin") {
    entries = [url];
    index = 0;
    emit();
  },
};
afterEach(() => adminTestHistory.reset());
export const adminNavigationMock = {
  useRouter: () => adminTestHistory,
  usePathname: () => new URL(useSyncExternalStore(subscribe, read, read), "http://test").pathname,
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(subscribe, read, read).split("?")[1]),
};
