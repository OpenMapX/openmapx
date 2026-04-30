#!/bin/sh
set -e

# Replace the NEXT_PUBLIC_API_URL build-time placeholder with the runtime value.
#
# packages/core reads process.env.NEXT_PUBLIC_API_URL directly in client code,
# so Next.js inlines it at build time. This is the only env var that still needs
# the placeholder/sed approach — all other NEXT_PUBLIC_* vars are served via the
# EnvProvider React context (built server-side from real process.env per request).

# Idempotency marker so container restarts skip the find/sed walk after the
# first run. The marker records the substituted URL so a runtime URL change
# triggers a re-substitution against the still-baked placeholder.
MARKER_FILE=/app/.api-url-substituted
WANT_MARKER="${NEXT_PUBLIC_API_URL:-__placeholder__}"
CURRENT_MARKER=""
if [ -f "$MARKER_FILE" ]; then
  CURRENT_MARKER=$(cat "$MARKER_FILE" 2>/dev/null || echo "")
fi

if [ -n "$NEXT_PUBLIC_API_URL" ] && [ "$CURRENT_MARKER" != "$WANT_MARKER" ]; then
  find /app/apps/web/.next -name '*.js' -exec sed -i "s|__NEXT_PUBLIC_API_URL__|${NEXT_PUBLIC_API_URL}|g" {} + 2>/dev/null || true
  find /app/apps/web/.next -name '*.html' -exec sed -i "s|__NEXT_PUBLIC_API_URL__|${NEXT_PUBLIC_API_URL}|g" {} + 2>/dev/null || true
  echo "$WANT_MARKER" > "$MARKER_FILE" 2>/dev/null || true
fi

exec "$@"
