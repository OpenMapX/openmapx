import { useEffect, useRef, useState } from "react";
import {
  createShellRuntime,
  type ShellRuntime,
  type ShellRuntimeOptions,
} from "./createShellRuntime";

/**
 * The shell runtime for one mounted shell, disposed when the shell unmounts.
 *
 * React can run the cleanup and set-up of an effect again without unmounting:
 * after a Fast Refresh, and in Strict Mode. The cleanup then disposes the
 * runtime the shell still holds, so the set-up composes a fresh one and tells
 * `onRecomposed`. The fresh bridge has no channel to the page that is already
 * loaded, so the caller reloads the page.
 *
 * The options are read once: the compiled configuration and the device locale
 * do not change while the process runs, and the callbacks read live state
 * through refs.
 */
export function useShellRuntime(
  options: ShellRuntimeOptions,
  onRecomposed: () => void,
): ShellRuntime {
  const initial = useRef({ options, onRecomposed });
  const [runtime, setRuntime] = useState(() => createShellRuntime(options));
  useEffect(() => {
    if (runtime.isDisposed()) {
      setRuntime(createShellRuntime(initial.current.options));
      initial.current.onRecomposed();
      return;
    }
    return () => runtime.dispose();
  }, [runtime]);
  return runtime;
}
