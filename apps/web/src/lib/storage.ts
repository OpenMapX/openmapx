import type { StorageAdapter } from "@openmapx/core";

export const localStorageAdapter: StorageAdapter = {
  getString: (key) => (typeof window !== "undefined" ? localStorage.getItem(key) : null),
  setString: (key, value) => {
    if (typeof window !== "undefined") localStorage.setItem(key, value);
  },
  remove: (key) => {
    if (typeof window !== "undefined") localStorage.removeItem(key);
  },
};
