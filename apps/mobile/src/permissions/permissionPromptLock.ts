/**
 * One operating-system permission prompt at a time, process-wide.
 *
 * The start flow's location and notification prompts, a one-shot location
 * request and voice search's microphone prompt run on independent paths, and
 * none of them belongs on the navigation queue: each waits on the user. Android
 * rejects a permission request made while another is showing, so they queue
 * behind each other here instead. A prompt that fails does not hold up the next.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withPermissionPrompt<T>(prompt: () => Promise<T>): Promise<T> {
  const run = tail.then(prompt, prompt);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
