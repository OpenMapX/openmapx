# Licensing

OpenMapX uses a deliberate two-license split: the **product** is strong
copyleft, and the **reusable libraries** are permissive so that other projects
can adopt them freely.

| What | License | Why |
|---|---|---|
| The product — the deployable app, its integrations, and its services | **AGPL-3.0-or-later** | Keeps OpenMapX and any hosted derivative open. Anyone who runs a modified version as a network service must offer its source. |
| Reusable libraries and the plugin SDK (selected `packages/*`) | **Apache-2.0** | These have value outside OpenMapX. A permissive license (with an explicit patent grant) lets any project depend on them. |
| Vendored third-party code | Its upstream license | Not ours to relicense. |

The root [`LICENSE`](LICENSE) file is the AGPL-3.0 and governs the repository by
default. Packages that carry a different license have their own `LICENSE` file
and a matching `license` field in their `package.json`; that per-package license
takes precedence for that package.

The third-party Docker images OpenMapX orchestrates (Valhalla, OSRM, MOTIS,
Nominatim, Pelias, Photon, Elasticsearch, PostGIS, …) run as **separate
containers communicating over the network**. They are not linked into
OpenMapX's code and keep their own upstream licenses; they impose no obligation
on the license of OpenMapX's own source.

Apache-2.0 is one-directionally compatible with the AGPL: the AGPL application
may include the Apache-2.0 libraries, but not the other way around. That is why
the SDK and shared libraries — the parts we want others to reuse — are the
permissive ones, and the product that ties them together is copyleft.

## Contributing and relicensing

Contributions are accepted under a Contributor License Agreement
([`CLA.md`](CLA.md)). The CLA lets You keep ownership of Your contributions
while granting the maintainer the right to license the combined work under other
terms — for example, a commercial license alongside the AGPL. This preserves the
Project's ability to sustain itself without changing the open-source promise to
the community. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how signing works.
