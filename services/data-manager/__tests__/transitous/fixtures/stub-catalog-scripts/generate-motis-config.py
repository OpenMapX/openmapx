#!/usr/bin/env python3
"""Stub generate-motis-config.py for the Phase E9 live-MOTIS pipeline test.

Writes a minimal MOTIS config.yml under `out/config.yml` referencing the
just-fetched `out/*.gtfs.zip`. The real upstream script renders a much larger
Jinja-templated config; the live test only needs MOTIS to import the seeded
feeds and answer probes on port 8080.

The data-manager's `assemble-staging` stage is what copies config + feeds from
`out/` into the staging container's mount — this stub only mirrors the real
script's job of producing `out/config.yml` (it does NOT touch the staging dir).

Recognises:
  --import-only   (no-op flag, accepted for parity)
  --feed-proxy    emits out/feed-proxy-vars.json so gen-full-config is happy.
"""
from __future__ import annotations

import re
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
    # `--import-only` is accepted for parity with the real script but needs no
    # special handling here.
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

    sys.stderr.write(
        f"stub generate-motis-config.py: wrote out/config.yml referencing {len(feeds)} feed(s)\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
