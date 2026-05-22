#!/usr/bin/env python3
"""Stub garbage-collect.py for the Phase E9 live-MOTIS pipeline test.

The real upstream script prunes orphan downloads; we accept the same flag
and return success. Accepts `--non-interactive` for parity with the call
site in `internal.ts`.
"""
from __future__ import annotations

import sys


if __name__ == "__main__":
    # Touch sys.argv so a strict linter doesn't flag it as unused.
    _ = sys.argv
    raise SystemExit(0)
