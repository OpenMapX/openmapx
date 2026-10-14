---
"@openmapx/integration-framework": patch
"@openmapx/integration-openconditions": patch
"@openmapx/integration-overlay-wildfires": patch
"@openmapx/i18n": patch
---

The wildfire overlay leaves out satellite fire detections their instrument rates
low confidence (VIIRS `low`, MODIS below 30%) unless the new "Low confidence"
switch in the hotspot legend is on; it is off by default. Fire queries carry
`excludeLowConfidence`, which the OpenConditions provider passes upstream as
`minConfidence=nominal` so density cells count only the kept detections. An
OpenConditions instance that refuses the parameter is read without it and asked
again an hour later; the hotspot route still drops low-confidence points itself,
while its density cells then include them.
