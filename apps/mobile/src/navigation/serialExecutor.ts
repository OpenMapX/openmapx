/**
 * One queue, one task at a time, in submission order.
 *
 * Web commands and location callbacks arrive on independent schedules and both
 * mutate the same session. Serialising them here — rather than relying on each
 * caller to be careful — is what makes the repository's compare-and-swap a
 * backstop instead of the primary defence.
 */
export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  /** Non-zero only while a task body is running synchronously. */
  private depth = 0;

  /**
   * Queues a task and resolves with its result.
   *
   * A rejected task settles its own promise and is otherwise invisible: the
   * queue keeps its order and keeps going, because one failed location batch
   * must not stall every later command.
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.depth > 0) {
      // A task that queues onto its own executor would wait for itself. Failing
      // here turns a hang into a stack trace at the offending call site.
      return Promise.reject(new Error("serial executor cannot be entered from inside a task"));
    }

    const result = this.tail.then(() => {
      this.depth += 1;
      try {
        return task();
      } finally {
        this.depth -= 1;
      }
    });
    // The tail absorbs rejection so one failure cannot poison the queue; the
    // returned promise still rejects for the caller that submitted the task.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once everything queued so far has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
