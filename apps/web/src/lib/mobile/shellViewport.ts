/**
 * Keeps the interface at its layout scale inside the installed shell.
 *
 * A native app does not let the whole interface be pinched or double-tapped
 * larger; only the map zooms, and it does that with its own gesture handling,
 * which a viewport scale limit does not affect. Browser visitors keep page zoom,
 * so the root viewport stays zoomable and only the shell narrows it.
 *
 * Android's WebView zoom is switched off natively as well. WKWebView has no
 * such switch, and the signed shell may not inject page scripts beyond its
 * nonce bootstrap, so this lives in the page.
 */

const SCALE_KEYS = /^(initial-scale|minimum-scale|maximum-scale|user-scalable)$/i;
const LOCKED_SCALE = ["initial-scale=1", "minimum-scale=1", "maximum-scale=1", "user-scalable=no"];

/** The viewport content with its scale keys replaced and every other key kept. */
export function lockedViewportContent(content: string | null): string {
  const kept = (content ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !SCALE_KEYS.test(part.split("=")[0]?.trim() ?? ""));
  if (kept.length === 0) kept.push("width=device-width");
  return [...kept, ...LOCKED_SCALE].join(",");
}

/**
 * Applies the lock and keeps it applied if the viewport tag is rewritten or
 * replaced. Returns a function that stops watching; it leaves the tag locked.
 */
export function lockShellViewport(doc: Document): () => void {
  const apply = () => {
    let meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) {
      meta = doc.createElement("meta");
      meta.setAttribute("name", "viewport");
      doc.head.appendChild(meta);
    }
    const current = meta.getAttribute("content");
    const locked = lockedViewportContent(current);
    if (current !== locked) meta.setAttribute("content", locked);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(doc.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content", "name"],
  });
  return () => observer.disconnect();
}
