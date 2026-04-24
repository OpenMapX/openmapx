type VitestTestCallback = () => void | Promise<void>;
type VitestMockImplementation = (...args: unknown[]) => unknown;

interface VitestExpectation {
  not: VitestExpectation;
  toBe(expected: unknown): void;
  toBeDefined(): void;
  toBeNull(): void;
  toContain(expected: unknown): void;
  toEqual(expected: unknown): void;
}

interface VitestMockFunction {
  (...args: unknown[]): unknown;
  mockImplementation(implementation: VitestMockImplementation): VitestMockFunction;
  mockResolvedValue(value: unknown): VitestMockFunction;
  mockReturnValue(value: unknown): VitestMockFunction;
}

declare module "vitest" {
  export const describe: (name: string, callback: VitestTestCallback) => void;
  export const expect: (actual: unknown) => VitestExpectation;
  export const it: (name: string, callback: VitestTestCallback) => void;
  export const vi: {
    fn(implementation?: VitestMockImplementation): VitestMockFunction;
    mock(id: string, factory: () => unknown): void;
    mocked<T>(item: T): T;
  };
}
