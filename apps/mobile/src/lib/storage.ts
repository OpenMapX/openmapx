import type { StorageAdapter } from "@openmapx/core";
import { createMMKV } from "react-native-mmkv";

const mmkv = createMMKV();

export const mmkvStorageAdapter: StorageAdapter = {
  getString: (key) => mmkv.getString(key) ?? null,
  setString: (key, value) => mmkv.set(key, value),
  remove: (key) => {
    mmkv.remove(key);
  },
};
