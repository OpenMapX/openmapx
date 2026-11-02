import { isBackNavigationIdle } from "@/lib/backNavigation";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for history to stop moving: jsdom delivers a traversal's popstate on a
 * later task, and a Back that crossed only leftover entries steps on by itself.
 * Uses real timers; call it with fake timers off.
 */
export async function settleHistory(): Promise<void> {
  await sleep(5);
  for (let waited = 0; !isBackNavigationIdle() && waited < 1500; waited += 5) await sleep(5);
  await sleep(5);
}
