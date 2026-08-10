type VitestTestCallback = () => void | Promise<void>;
type VitestMockImplementation = (...args: unknown[]) => unknown;
type VitestEachArguments<T> = T extends readonly [...infer Values] ? Values : [T];

interface VitestTestFunction {
  (name: string, callback: VitestTestCallback): void;
  each<T>(
    cases: readonly T[],
  ): (name: string, callback: (...args: VitestEachArguments<T>) => void | Promise<void>) => void;
}

interface VitestExpectation {
  not: VitestExpectation;
  toBe(expected: unknown): void;
  toBeCloseTo(expected: number, numDigits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeTypeOf(expected: string): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(times: number): void;
  toHaveBeenCalledWith(...args: unknown[]): void;
  toHaveBeenLastCalledWith(...args: unknown[]): void;
  toHaveAccessibleName(expected: string | RegExp): void;
  toHaveAttribute(name: string, value?: unknown): void;
  toHaveFocus(): void;
  toHaveStyle(expected: Record<string, string> | string): void;
  toHaveTextContent(expected: string | RegExp): void;
  toHaveValue(expected?: unknown): void;
  toBeChecked(): void;
  toBeDisabled(): void;
  toBeInTheDocument(): void;
  toBeVisible(): void;
  toThrow(expected?: unknown): void;
}

interface VitestMockFunction {
  (...args: unknown[]): unknown;
  mock: { calls: unknown[][] };
  mockImplementation(implementation: VitestMockImplementation): VitestMockFunction;
  mockResolvedValue(value: unknown): VitestMockFunction;
  mockRejectedValue(value: unknown): VitestMockFunction;
  mockRejectedValueOnce(value: unknown): VitestMockFunction;
  mockReturnValue(value: unknown): VitestMockFunction;
  mockReset(): VitestMockFunction;
  mockClear(): VitestMockFunction;
  mockRestore(): VitestMockFunction;
}

type VitestMockFactory = (importOriginal: <T = unknown>() => Promise<T>) => unknown;

declare module "vitest" {
  export const describe: VitestTestFunction;
  const expectFn: {
    (actual: unknown): VitestExpectation;
    any(expected: unknown): unknown;
    objectContaining(expected: Record<string, unknown>): unknown;
    stringContaining(expected: string): unknown;
  };
  export const expect: typeof expectFn;
  export const it: VitestTestFunction;
  export const beforeEach: (callback: VitestTestCallback) => void;
  export const afterEach: (callback: VitestTestCallback) => void;
  export const vi: {
    fn(implementation?: VitestMockImplementation): VitestMockFunction;
    mock(id: string, factory: VitestMockFactory): void;
    mocked<T>(item: T): T;
    spyOn<T, K extends keyof T>(object: T, method: K): VitestMockFunction;
    importActual<T = unknown>(id: string): Promise<T>;
    stubGlobal(name: string, value: unknown): void;
    unstubAllGlobals(): void;
    clearAllMocks(): void;
    restoreAllMocks(): void;
    useFakeTimers(options?: { shouldAdvanceTime?: boolean }): void;
    setSystemTime(now?: string | number | Date): void;
    useRealTimers(): void;
    advanceTimersByTime(ms: number): void;
    advanceTimersByTimeAsync(ms: number): Promise<void>;
  };
}
