---
"@openmapx/extension-cli": patch
---

Refresh the extension CLI's bundled core inputs after updating the ambient-places ranking
policy to version 3 (ordering unmatched Overture gaps by confidence within the 0-49
sub-band, strictly below OSM). Existing Overture pull contract v2 snapshots must be
re-pulled under contract v3, and interrupted policy-2 ambient-places candidates must be
rebuilt.
