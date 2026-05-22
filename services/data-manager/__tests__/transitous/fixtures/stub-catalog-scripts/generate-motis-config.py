#!/usr/bin/env python3
"""Stub generate-motis-config.py for the Phase E9 live-MOTIS pipeline test.

Writes a minimal MOTIS config.yml under `out/config.yml`, and additionally
mirrors the just-fetched `out/*.gtfs.zip` into the staging data dir
(`OPENMAPX_E9_STAGING_DIR`) along with the config file. The real upstream
script renders a much larger Jinja-templated config; the live test only
needs MOTIS to import the seeded feeds and answer probes on port 8080.

Recognises:
  --import-only   (no-op flag, accepted for parity)
  --feed-proxy    emits out/feed-proxy-vars.json so gen-full-config is happy
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    flag_feed_proxy = "--feed-proxy" in argv[1:]
    out_dir = Path("out")
    out_dir.mkdir(parents=True, exist_ok=True)

    feeds = sorted(p.name for p in out_dir.glob("*.gtfs.zip"))
    config = {
        "server": {"port": 8080},
        "timetable": {
            "datasets": {
                # MOTIS infers the dataset name from the key; each entry points
                # at a GTFS zip relative to the data dir we mount in the
                # container (/motis-data).
                Path(name).stem: {"path": name}
                for name in feeds
            },
        },
    }
    # Serialise as YAML by hand to avoid pulling in PyYAML — keeps the stub
    # self-contained on a stock python3 install.
    yaml_lines: list[str] = ["server:", "  port: 8080", "timetable:", "  datasets:"]
    for name in feeds:
        stem = Path(name).stem
        yaml_lines.append(f"    {stem}:")
        yaml_lines.append(f"      path: {name}")
    yaml_text = "\n".join(yaml_lines) + "\n"

    cfg_path = out_dir / "config.yml"
    cfg_path.write_text(yaml_text, encoding="utf-8")

    if flag_feed_proxy:
        (out_dir / "feed-proxy-vars.json").write_text("{}\n", encoding="utf-8")

    # Mirror everything the staging container needs into the data-manager's
    # configured staging dir. The path is supplied via env so the test can
    # point it at its tmp dir. We always overwrite — every pipeline run
    # rebuilds from scratch.
    staging = os.environ.get("OPENMAPX_E9_STAGING_DIR")
    if staging:
        staging_dir = Path(staging)
        staging_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cfg_path, staging_dir / "config.yml")
        for zip_name in feeds:
            shutil.copyfile(out_dir / zip_name, staging_dir / zip_name)
        sys.stderr.write(
            f"stub generate-motis-config.py: mirrored {len(feeds)} feed(s) + config -> {staging_dir}\n"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
