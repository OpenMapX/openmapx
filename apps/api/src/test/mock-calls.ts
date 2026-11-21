import { assert } from "vitest";

/**
 * The argument at position `arg` of a mock's call number `call`, counting back
 * from the last call for a negative one. The test fails when the mock was not
 * called that often or that call omitted the argument.
 */
export function callArg<Args extends readonly unknown[], A extends number>(
  fn: { readonly mock: { readonly calls: readonly Args[] } },
  call: number,
  arg: A,
): Exclude<Args[A], undefined> {
  const args = fn.mock.calls.at(call);
  assert.isDefined(args, `the mock has no call ${call} of ${fn.mock.calls.length}`);
  const value: Args[A] = args[arg];
  assert.isDefined(value, `call ${call} of the mock has no argument ${arg}`);
  return value;
}
