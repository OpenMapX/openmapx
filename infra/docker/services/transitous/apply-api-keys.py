#!/usr/bin/env python3
"""
Applies API keys from a local overlay file to the Transitous feed catalog.

The overlay file (api-keys.json) maps feed sources to API keys:
{
  "us-ny/MTA": "your-transitland-key",
  "us-il/Metra": "your-transitland-key",
  "gb/National-Rail": "your-key"
}

Keys are in the format "region/source-name" where region is the feed filename
(without .json) and source-name matches the "name" field in the feed JSON.

This script modifies the feed JSON files in-place so the Transitous fetch
pipeline can use the keys during download.
"""

import json
import sys
from pathlib import Path

OVERLAY_FILE = Path("/transitous/api-keys.json")
FEEDS_DIR = Path("/transitous/feeds")


def main():
    if not OVERLAY_FILE.exists():
        return

    try:
        overlay = json.loads(OVERLAY_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: Could not read api-keys.json: {e}", file=sys.stderr)
        return

    if not overlay:
        return

    applied = 0
    for key_path, api_key in overlay.items():
        parts = key_path.split("/", 1)
        if len(parts) != 2:
            print(f"Warning: Invalid key format '{key_path}', expected 'region/source-name'", file=sys.stderr)
            continue

        region, source_name = parts
        feed_file = FEEDS_DIR / f"{region}.json"

        if not feed_file.exists():
            continue

        try:
            feed_data = json.loads(feed_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        modified = False
        for source in feed_data.get("sources", []):
            if source.get("name") == source_name and "transitland-atlas-id" in source:
                source["api-key"] = api_key
                # Unskip the source now that we have a key
                if source.get("skip"):
                    del source["skip"]
                modified = True

        if modified:
            feed_file.write_text(json.dumps(feed_data, indent=4, ensure_ascii=False))
            applied += 1

    if applied > 0:
        print(f"[transitous] Applied API keys to {applied} feed file(s)")


if __name__ == "__main__":
    main()
