# Photo registration method comparison

Development characterization, 11 October 2026. These are synthetic public
controls across Germany, not a user's itinerary. Source photographs, raw
responses, predictions and experimental scripts are retained in the external
QA package. The source reviews below are development evidence, not held-out
truth.

## Current bounded marking and pose method

The browser replay uses actual React components, reset CSS, browser canvas
decoding and the production module worker. It contains 117 approaches and 39
photographs: 22 prepared, 17 withheld, zero accepted overlays.

| Registration result     | Photographs |
| ----------------------- | ----------- |
| Insufficient boundaries | 21          |
| Off approach            | 9           |
| Unclear scene           | 7           |
| Wrong level             | 1           |
| Missing field of view   | 1           |

“Insufficient boundaries” does not establish that every line is occluded. The
method requires a supported camera fit followed by all travel-lane boundaries
and an unambiguous lane correspondence. The other results withhold the photo
or leave a relevant image bare according to the current contracts.

Three separate throwaway experiments retained the existing acceptance gates:

- Decode all 32 regular photos from SD assets instead of thumbnails: zero
  registrations in the offline pixel probe. Resolution alone is insufficient.
- Balance the fit objective across boundary supports with a geometric mean:
  zero registrations. A supported pose at one site still had a competing layout.
- Expand the heading search from ±6° to ±18° with SD inputs: one offline panorama
  candidate, which was not accepted by the real browser canvas/worker replay.
  This did not establish improved guidance and was not adopted.

The separate two-lane panorama calibration remains a transformation control,
not general usefulness evidence. No frozen correctness or usefulness threshold
was relaxed to create a positive result.

## UFLDv2 learned-detector experiment

Ran the authors' [Ultra Fast Lane Detection v2](https://github.com/cfzd/Ultra-Fast-Lane-Detection-v2)
ResNet18/CULane checkpoint on all 32 SD regular images. Source revision:
`c903880678454dfd9b55a63022368db05c00bc6d`. Checkpoint SHA-256:
`956616371ee758551c455d28c1c8a9732b39d7fbd85bc70b9869424a5121f967`.
Loading used `weights_only=True` and strict state-dictionary matching. Processing
used the authors' RGB normalization, bottom crop and row/column decoding. This
was local CPU inference, not a browser, mobile or panorama benchmark.

| Observation                    | Result              |
| ------------------------------ | ------------------- |
| Frames                         | 32                  |
| At least one predicted curve   | 27                  |
| Predicted curves per image     | 0–4                 |
| Complete junction-count match  | 2                   |
| Median inference, four threads | 89 ms               |
| p95 inference, nearest rank    | 120 ms              |
| Float32 parameter storage      | 825,202,560 bytes   |
| Peak Python process RSS        | 2,231,681,024 bytes |

The two count matches were already withheld by route-context checks. Visual
inspection also showed why a count match cannot establish global lane identity:
some predictions cover only the camera's nearby lanes, miss an outer edge,
track a vehicle, or track construction paint. Four output curve slots cannot
represent every boundary of a four-, five- or six-lane carriageway. Predicted
curves are neither calibrated confidence nor proof of route-lane correspondence.

This checkpoint was not adopted. It has not demonstrated useful complete-lane
coverage here, its measured float32 footprint is unsuitable for this mobile
feature, and code licensing alone does not certify training-data or weight
redistribution rights. The authors' code is MIT licensed; no model, dependency
or third-party processing was added to the application. This result does not
rule out a smaller, differently trained model with variable boundary counts.

## Image-first continuation

Thirteen original-resolution source photos were reviewed separately from any
detector output. Reviewers used raw incoming/outgoing road topology and ordered
route geometry to assign global lane identities, and traced conservative visible
interior fragments. These exclude cropped edges, cars, vehicle roofs, shoulders
and gore. A second blind review retains its own masks and records contamination
on two cases, which cannot count as independently certified truth. Adjudication
preserves disagreements and capture-time qualifications; these are software
source reviews, not driver-study participants. The portable records retain all
91 authored masks and review decisions. The resulting 13-frame development
package has six partial route-positive references, two relevance negatives and
five unscorable cases. Twenty-four second-authored travel fragments passed the
first reviewer's explicit cross-check. The Ruhr divider fragment was rejected;
the interior lane arrow remains valid travel surface with its separate
asphalt-only exclusion preserved. No unlabelled area is treated as wrong-lane
truth, and no fragment is counted as a successful complete-layout overlay.

The references show why route identity and image-space boundaries need separate
checks. At one split, both the leftmost through lane and the next combined
through/right lane reach the selected through branch; subjective keep-left
advice cannot disqualify the shared lane. At another, the same motorway reference
appears on different outgoing branches. Reference-number matching alone cannot
select their lanes. Partial visible masks cannot satisfy the complete-layout
usefulness gate.

A throwaway lightweight detector first extracted locally contrasting neutral
paint, then voted for line seeds and fitted quadratic curves without a camera
pose or expected lane width. It passed independent synthetic unequal-width and
curved-road controls, but did not establish complete global layouts on ten real
SD sources. Tight residual gates missed markings; a separate seed-diversity and
residual experiment produced 0–146 candidates per photo, including barriers and
vehicle/bodywork responses. Neither is a useful registered corridor. This
prototype was not added to the application or retained as unused product code.

The smaller [CLRNet](https://github.com/Turoad/CLRNet) ResNet18/TuSimple checkpoint
was also evaluated locally, at source revision
`7269e9d1c1c650343b6c7febb8e764be538b1aed`. Checkpoint SHA-256:
`f175ab318d6711e4a219d8d8239684f0b960b14bc3b224e16b696ff31a4c0f31`.
All learned parameters loaded; four non-learned configuration buffers absent
from the checkpoint were regenerated and asserted. Input preprocessing and
decoding followed the authors' configuration. The local compatibility harness
ported their lane NMS to CPU and used float32 inference; this is not the authors'
native CUDA benchmark. Panorama predictions were inverse-mapped from a
road-facing rectilinear view into original source pixels.

| Observation                        | Full source | Road crop control |
| ---------------------------------- | ----------- | ----------------- |
| Frames                             | 13          | 13                |
| At least one predicted curve       | 7           | 11                |
| Predicted curves per image         | 0–4         | 0–3               |
| Median inference, four CPU threads | 475 ms      | 369 ms            |
| p95 inference, nearest rank        | 4,426 ms    | 552 ms            |

The road-crop control removes the top 40% of flat photos before the configured
resize/crop, and maps coordinates back to the unmodified JPEG. It is a
development experiment, not a production transform. Measured parameter storage
is 47,099,092 bytes (11,774,773 float32 parameters); the checkpoint is 47,298,944
bytes and peak Python process RSS is 634,093,568 bytes. These are host-process
measurements, not browser/mobile bundle, latency or peak-memory measurements.

Personally inspected source-pixel curves at two clear forks, another four-lane
split and the construction negative. Cropping found more curves but missed
outer/internal boundaries; some continued into sky or other lanes. Construction
markings also produced curves. No complete route-lane correspondence was
accepted, and no gate was relaxed. The code is Apache-2.0 licensed, but weight
and training-data redistribution rights were not independently cleared. No
model, dependency or third-party processing was added to the application.

The source reviews also identify an unresolved relevance failure: `saar-10`
shows a two-lane temporary construction layout while the current map has three
lanes, and the production replay still prepares the photo bare. Rejecting known
mapped lane-count mismatches now withholds those photos, but does not detect this
unmapped capture-time contradiction. A generic ban on yellow paint would also
reject legitimate road markings and was not adopted.

## Runtime characterization

The final frozen replay uses the same 117 approaches and 39 photos on desktop
Chrome and an already-booted iOS Simulator running Safari. Both prepared 22
photos and produced zero overlays. Desktop p95 accepted-photo preparation was
310 ms; total replay 14.3 seconds, two long tasks and a 416 ms longest task.
Simulator Safari p95 was 370 ms and replay 17.1 seconds; its long-task observer
was unavailable. These are local host measurements, not physical-device or
WebView validation. The available physical Android device was locked, so no
Android browser measurement was obtained. Representative physical iOS, Android
and native WebView performance, memory and deadline gates remain unperformed.

Synthetic browser controls verify reference-only route signs with and without
a photo, and a known OSM layout mismatch without reliable preferred lanes.
The signs remain visible; the mismatched photo is withheld. German dark-mode
rendering at 320 px has no horizontal overflow or schematic. These controls
verify production components and worker behavior; they do not simulate a real
road changing its lane count.

## Release decision

General photo guidance remains unvalidated. The current method's zero accepted
overlays fail the usefulness gate; development fragment reviews and detector
curves do not replace complete independent held-out lane/scene truth. A future
method must establish
complete photographed-layout identity, contain every filled corridor inside its
intended travel lane, reject shoulders/gore/other carriageways, and pass the
held-out and representative-device gates before adoption.
