type VitestTestCallback = () => void | Promise<void>;
type VitestMockImplementation = (...args: unknown[]) => unknown;

interface VitestExpectation {
  not: VitestExpectation;
  toBe(expected: unknown): void;
  toBeCloseTo(expected: number, numDigits?: number): void;
  toBeDefined(): void;
  toBeNull(): void;
  toContain(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledWith(...args: unknown[]): void;
  toThrow(expected?: unknown): void;
}

interface VitestMockFunction {
  (...args: unknown[]): unknown;
  mockImplementation(implementation: VitestMockImplementation): VitestMockFunction;
  mockResolvedValue(value: unknown): VitestMockFunction;
  mockReturnValue(value: unknown): VitestMockFunction;
}

declare module "vitest" {
  export const describe: (name: string, callback: VitestTestCallback) => void;
  const expectFn: {
    (actual: unknown): VitestExpectation;
    objectContaining(expected: Record<string, unknown>): unknown;
  };
  export const expect: typeof expectFn;
  export const it: (name: string, callback: VitestTestCallback) => void;
  export const beforeEach: (callback: VitestTestCallback) => void;
  export const afterEach: (callback: VitestTestCallback) => void;
  export const vi: {
    fn(implementation?: VitestMockImplementation): VitestMockFunction;
    mock(id: string, factory: () => unknown): void;
    mocked<T>(item: T): T;
    importActual<T = unknown>(id: string): Promise<T>;
    stubGlobal(name: string, value: unknown): void;
    unstubAllGlobals(): void;
  };
}
