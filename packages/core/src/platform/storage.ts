export interface StorageAdapter {
  getString(key: string): string | null;
  setString(key: string, value: string): void;
  remove(key: string): void;
}

const noopStorage: StorageAdapter = {
  getString: () => null,
  setString: () => {},
  remove: () => {},
};

let storage: StorageAdapter = noopStorage;

export function configureStorage(adapter: StorageAdapter): void {
  storage = adapter;
}

export function getStorage(): StorageAdapter {
  return storage;
}
