#!/usr/bin/env python3
"""Stub fetch.py for the Phase E9 live-MOTIS pipeline test.

Reads a Transitous-style feed file (passed as the first positional arg, e.g.
"feeds/de.json") and copies each `type: url` source's zip from its
`file://` URL into the catalog's `out/` directory (which the data-manager
symlinks to the host gtfs dir). No HTTP, no postprocessing.

The real script does much more. We replicate only the bits the rest of the
pipeline observes: produce one `<region>_<sourceName>.gtfs.zip` per source
under `out/` next to where Transitous would normally write it.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write("usage: fetch.py <feeds/region.json>\n")
        return 2
    feed_path = Path(argv[1])
    if not feed_path.is_file():
        sys.stderr.write(f"feed file not found: {feed_path}\n")
        return 2
    region = feed_path.stem  # "de" from "feeds/de.json"
    out_dir = Path("out")
    out_dir.mkdir(parents=True, exist_ok=True)
    data = json.loads(feed_path.read_text(encoding="utf-8"))
    for source in data.get("sources", []):
        if source.get("skip"):
            continue
        if source.get("type") != "url":
            continue
        url = source.get("url", "")
        name = source.get("name", "src")
        parsed = urlparse(url)
        if parsed.scheme != "file":
            sys.stderr.write(f"stub fetch.py: unsupported url scheme for {region}-{name}: {url}\n")
            return 1
        src = Path(parsed.path)
        if not src.is_file():
            sys.stderr.write(f"Error: Could not fetch {region}-{name}: {src} does not exist\n")
            return 1
        dst = out_dir / f"{region}_{name}.gtfs.zip"
        shutil.copyfile(src, dst)
        sys.stderr.write(f"stub fetch.py: copied {src} -> {dst}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
