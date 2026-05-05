import { type NextRequest, NextResponse } from "next/server";

/**
 * Web Share Target endpoint. The manifest's share_target.action points here, so
 * the OS dispatches incoming shares (text/URL/title) into this handler.
 *
 * We extract a usable search query — preferring `text`, falling back to
 * `url` then `title` — and redirect to the home page with a `q` query param
 * that the client picks up via ShareIntentHandler.
 */

/** Returns the trimmed value, or null for missing/empty/whitespace-only params. */
function nonBlank(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickQuery(params: URLSearchParams): string | null {
  const text = nonBlank(params, "text");
  const url = nonBlank(params, "url");
  const title = nonBlank(params, "title");

  // If text contains a URL, prefer that — many share sources (browsers, RSS)
  // bundle "title — url" into text.
  const urlInText = text?.match(/https?:\/\/\S+/)?.[0] ?? null;
  // ?? rather than ||: all values are guaranteed non-empty by nonBlank, so
  // there's no falsy-string trap; this just expresses "fall through if missing".
  return urlInText ?? text ?? url ?? title ?? null;
}

export function GET(request: NextRequest) {
  const query = pickQuery(request.nextUrl.searchParams);
  const target = new URL("/", request.nextUrl.origin);
  if (query) target.searchParams.set("q", query);
  return NextResponse.redirect(target, 303);
}
