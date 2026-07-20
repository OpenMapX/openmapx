#!/usr/bin/env python3
"""Stub generate-attribution.py for the Phase E9 live-MOTIS pipeline test.

Writes an empty `out/license.json` so the gen-attribution stage sees the
file the real upstream script would produce.
"""
from __future__ import annotations

import json
from pathlib import Path


def main() -> int:
    out_dir = Path("out")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "license.json").write_text(json.dumps([]) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
