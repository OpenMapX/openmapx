#!/usr/bin/env python3
"""Stub generate-motis-config.py for the Phase E9 live-MOTIS pipeline test.

Writes a minimal MOTIS config.yml under `out/config.yml`, and additionally
mirrors the just-fetched `out/*.gtfs.zip` into the staging data dir
(`OPENMAPX_E9_STAGING_DIR`) along with the config file. The real upstream
script renders a much larger Jinja-templated config; the live test only
needs MOTIS to import the seeded feeds and answer probes on port 8080.

Recognises:
  --import-only   (no-op flag, accepted for parity)
  --feed-proxy    emits out/feed-proxy-vars.json so gen-full-config is happy.
                  This pass runs after the staging container is already live,
                  so it does NOT re-mirror feeds over the running volume.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path


def dataset_identifier(zip_name: str) -> str:
    """MOTIS dataset identifier for a GTFS zip filename.

    MOTIS rejects identifiers containing '_' (and validates the rest as a
    plain token), so we strip the archive suffix and collapse any
    non-alphanumeric run to '-'. e.g. ``de_demo.gtfs.zip`` -> ``de-demo``.
    """
    base = Path(zip_name).name
    for suffix in (".gtfs.zip", ".zip"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    return cleaned or "feed"


def assign_dataset_ids(feeds: list[str]) -> list[tuple[str, str]]:
    """Pair each feed zip with a UNIQUE dataset identifier.

    Two distinct filenames can clean to the same identifier (e.g.
    ``de_demo.gtfs.zip`` and ``DE-Demo.gtfs.zip`` both -> ``de-demo``). Without
    de-duplication the YAML would emit a duplicate mapping key and silently
    drop a feed, so collisions get a numeric suffix.
    """
    used: set[str] = set()
    pairs: list[tuple[str, str]] = []
    for name in feeds:
        base = dataset_identifier(name)
        ident = base
        n = 2
        while ident in used:
            ident = f"{base}-{n}"
            n += 1
        used.add(ident)
        pairs.append((ident, name))
    return pairs


def main(argv: list[str]) -> int:
    flag_feed_proxy = "--feed-proxy" in argv[1:]
    flag_import_only = "--import-only" in argv[1:]
    out_dir = Path("out")
    out_dir.mkdir(parents=True, exist_ok=True)

    feeds = sorted(p.name for p in out_dir.glob("*.gtfs.zip"))
    datasets = assign_dataset_ids(feeds)

    # Serialise as YAML by hand to avoid pulling in PyYAML — keeps the stub
    # self-contained on a stock python3 install. MOTIS infers the dataset name
    # from the key; each entry points at a GTFS zip relative to the data dir we
    # mount in the container (/motis-data).
    yaml_lines: list[str] = ["server:", "  port: 8080", "timetable:", "  datasets:"]
    for ident, name in datasets:
        yaml_lines.append(f"    {ident}:")
        yaml_lines.append(f"      path: {name}")
    yaml_text = "\n".join(yaml_lines) + "\n"

    cfg_path = out_dir / "config.yml"
    cfg_path.write_text(yaml_text, encoding="utf-8")

    if flag_feed_proxy:
        (out_dir / "feed-proxy-vars.json").write_text("{}\n", encoding="utf-8")

    # Mirror everything the staging container needs into the data-manager's
    # configured staging dir. The path is supplied via env so the test can
    # point it at its tmp dir. We always overwrite — every pipeline run
    # rebuilds from scratch. Only the `--import-only` pass (gen-motis-config,
    # which runs *before* motis-import) mirrors; the later gen-full-config
    # invocations (`--feed-proxy` and the plain full-config render) run after
    # the staging container is already importing/serving this volume, so
    # re-copying the feeds then would churn files under a live MOTIS.
    staging = os.environ.get("OPENMAPX_E9_STAGING_DIR")
    if staging and flag_import_only:
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
