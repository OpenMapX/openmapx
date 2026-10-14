---
"@openmapx/mobility-core": minor
"@openmapx/integration-openconditions": minor
"@openmapx/integration-fuel": patch
---

Crowd reports are credited as the OpenConditions instance's `/sources` states
them (name, licence and link) instead of a fixed openconditions.org credit;
while an instance states no crowd credit, readings the crowd contributed to are
left out. Fuel stations carry their brand's Wikidata item when OpenConditions
names one, and the station logo is resolved from it before the brand name.
