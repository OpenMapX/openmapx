#!/bin/sh
set -e

# Replace the NEXT_PUBLIC_API_URL build-time placeholder with the runtime value.
#
# packages/core reads process.env.NEXT_PUBLIC_API_URL directly in client code,
# so Next.js inlines it at build time. This is the only env var that still needs
# the placeholder/sed approach — all other NEXT_PUBLIC_* vars are served via the
# EnvProvider React context (built server-side from real process.env per request).

if [ -n "$NEXT_PUBLIC_API_URL" ]; then
  find /app/apps/web/.next -name '*.js' -exec sed -i "s|__NEXT_PUBLIC_API_URL__|${NEXT_PUBLIC_API_URL}|g" {} + 2>/dev/null || true
  find /app/apps/web/.next -name '*.html' -exec sed -i "s|__NEXT_PUBLIC_API_URL__|${NEXT_PUBLIC_API_URL}|g" {} + 2>/dev/null || true
fi

exec "$@"
