import { Blob } from "node:buffer";

/** Platform boundary double: writable bytes commit only on successful close. */
export function createPlatformOpfs(moveSupported: boolean) {
  const files = new Map<string, Uint8Array>();
  const failures = new Map<string, "create" | "write" | "close" | "move">();
  const directory = {
    async getDirectoryHandle(name: string) {
      if (name !== "offline-packages") throw new Error("unexpected OPFS directory");
      return directory;
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException("missing file", "NotFoundError");
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing file", "NotFoundError");
        files.set(name, new Uint8Array());
      }
      let currentName = name;
      const committed = () => {
        const bytes = files.get(currentName);
        if (!bytes) throw new DOMException("missing file", "NotFoundError");
        return bytes;
      };
      return {
        ...(moveSupported
          ? {
              async move(next: string) {
                if (failures.get(currentName) === "move") throw new Error("move rejected");
                files.set(next, committed().slice());
                files.delete(currentName);
                currentName = next;
              },
            }
          : {}),
        async getFile() {
          return new Blob([committed().slice()]);
        },
        async createWritable(options?: { keepExistingData?: boolean }) {
          if (failures.get(currentName) === "create") throw new Error("create rejected");
          let pending = options?.keepExistingData ? committed().slice() : new Uint8Array();
          let position = 0;
          let ended = false;
          const assertOpen = () => {
            if (ended) throw new Error("writable ended");
          };
          return {
            async seek(offset: number) {
              assertOpen();
              position = offset;
            },
            async write(value: ArrayBuffer | Blob) {
              assertOpen();
              if (failures.get(currentName) === "write")
                throw new DOMException("quota", "QuotaExceededError");
              const bytes = new Uint8Array(
                value instanceof Blob ? await value.arrayBuffer() : value,
              );
              const next = new Uint8Array(Math.max(pending.length, position + bytes.length));
              next.set(pending);
              next.set(bytes, position);
              pending = next;
              position += bytes.length;
            },
            async truncate(size: number) {
              assertOpen();
              const next = new Uint8Array(size);
              next.set(pending.subarray(0, size));
              pending = next;
            },
            async close() {
              assertOpen();
              ended = true;
              if (failures.get(currentName) === "close") throw new Error("close rejected");
              files.set(currentName, pending.slice());
            },
            async abort() {
              ended = true;
            },
          };
        },
      };
    },
  };
  return { files, failures, storage: { getDirectory: async () => directory } };
}
