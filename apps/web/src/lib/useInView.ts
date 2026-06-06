import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Returns `[ref, inView]`. `inView` latches to `true` the first time the
 * ref'd element scrolls within `rootMargin` of the viewport and stays true
 * thereafter. Use it to defer expensive work (queries, heavy renders) for
 * content below the fold until the user actually approaches it.
 *
 * SSR / environments without `IntersectionObserver` render eagerly (inView
 * becomes true on mount) so nothing is permanently hidden.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  rootMargin = "200px",
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return; // latched — stop observing once seen
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView];
}
