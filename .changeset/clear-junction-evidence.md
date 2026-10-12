---
"@openmapx/core": patch
---

Share ordered geometry boundaries across navigation progress and junction timing while preserving provider travel distances and ETA. Preserve initially usable versus preferred lane evidence, reject conflicting branch/layout assignments, and prepare relevant junction photos before display. Trace supported image-space lane boundaries and keep panorama overlays aligned across seams; withhold corridors when lane correspondence is unresolved.

Withhold junction photos when the mapped road interval at the camera has a different lane count from the confirmed split layout, including when preferred lanes are unknown. Keep recovered geometry anchors around missing step shapes and retain route titles when physical sign boards are absent.
