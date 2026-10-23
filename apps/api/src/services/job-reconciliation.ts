import { jobRunner } from "./job-runner";

let timer: ReturnType<typeof setInterval> | undefined;
let pass: Promise<void> | undefined;
let observer: AbortController | undefined;
export async function reconcileAdminJobs(options?: { limit?: number }): Promise<void> {
  if (pass) return pass;
  observer = new AbortController();
  pass = jobRunner.reconcile(options, observer.signal);
  try {
    await pass;
  } finally {
    pass = undefined;
  }
}
export function startAdminJobReconciliation(): void {
  if (timer) return;
  const run = () => {
    void reconcileAdminJobs().catch(() => {
      /* Next bounded pass retries reads. */
    });
  };
  timer = setInterval(run, 5_000);
  timer.unref?.();
  run();
}
export async function stopAdminJobReconciliation(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  observer?.abort();
  await pass;
}
