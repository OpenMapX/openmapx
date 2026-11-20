/** Whether every value is greater than the one before it: sorted with no duplicates. */
export function strictlyAscending(values: readonly string[] | readonly number[]): boolean {
  return values.every((value: string | number, index: number) => {
    const previous = values[index - 1];
    return previous === undefined || previous < value;
  });
}
