/**
 * Planetiler custom-map schema for the `street_detail` tileset: raw OSM tags
 * on typed points, lines and polygons at z16, from which the web client
 * derives street paint and street objects. Written to
 * `<workDir>/street-detail.yml` before the build runs `generate-custom`.
 *
 * The build passes `--osm-path`; Planetiler applies that override only to a
 * source whose id is literally `osm`, so the source id below must stay `osm`.
 * `local_path` is a placeholder and there is no `url`, so nothing downloads.
 *
 * Quote `"yes"` and `"no"`: Planetiler reads YAML 1.1, where they are booleans.
 */

export const STREET_DETAIL_LAYERS = [
  "roads",
  "rails",
  "crossings",
  "trees",
  "furniture",
  "pitches",
] as const;

export const STREET_DETAIL_SCHEMA = `schema_name: OpenMapX street detail
schema_description: Street paint and street object source data for the OpenMapX 3D view
attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
args:
  minzoom: 16
  maxzoom: 16
  simplify_tolerance_at_max_zoom: 0
  min_feature_size_at_max_zoom: 0
sources:
  osm:
    type: osm
    local_path: /osm/input.osm.pbf

definitions:
  road_exclusions: &road_exclusions
    __any__:
      - area: "yes"
      - covered: "yes"
      - layer: "-%"
      - __all__:
          - tunnel: __any__
          - __not__:
              tunnel: "no"
      - __all__:
          - highway: service
          - service: [driveway, parking_aisle, drive-through]
  rail_exclusions: &rail_exclusions
    __any__:
      - layer: "-%"
      - __all__:
          - tunnel: __any__
          - __not__:
              tunnel: "no"
  bridge: &bridge
    key: bridge
    tag_value: bridge
    type: boolean
  layer: &layer
    key: layer
    tag_value: layer
    type: integer

layers:
  - id: roads
    buffer: 32
    features:
      - source: osm
        geometry: line
        include_when:
          highway:
            - motorway
            - motorway_link
            - trunk
            - trunk_link
            - primary
            - primary_link
            - secondary
            - secondary_link
            - tertiary
            - tertiary_link
            - unclassified
            - residential
            - living_street
            - service
            - busway
        exclude_when: *road_exclusions
        attributes:
          - { key: class, tag_value: highway, type: string }
          - key: oneway
            type: integer
            value:
              - if: { oneway: ["yes", "1", "true"] }
                value: 1
              - if: { oneway: "-1" }
                value: -1
              - if: { oneway: "no" }
                value: 0
              - if: { junction: [roundabout, circular] }
                value: 1
              - if: { highway: [motorway, motorway_link] }
                value: 1
              - else: 0
          - { key: junction, tag_value: junction, type: string }
          - { key: lanes, tag_value: lanes, type: integer }
          - { key: lanes_fw, tag_value: "lanes:forward", type: integer }
          - { key: lanes_bw, tag_value: "lanes:backward", type: integer }
          - { key: width, tag_value: width, type: double }
          - { key: lane_markings, tag_value: lane_markings, type: string }
          - { key: turn, tag_value: "turn:lanes", type: string }
          - { key: turn_fw, tag_value: "turn:lanes:forward", type: string }
          - { key: turn_bw, tag_value: "turn:lanes:backward", type: string }
          - { key: cycle, tag_value: cycleway, type: string }
          - { key: cycle_l, tag_value: "cycleway:left", type: string }
          - { key: cycle_r, tag_value: "cycleway:right", type: string }
          - { key: cycle_both, tag_value: "cycleway:both", type: string }
          - { key: cycle_lane_l, tag_value: "cycleway:left:lane", type: string }
          - { key: cycle_lane_r, tag_value: "cycleway:right:lane", type: string }
          - { key: cycle_lane_both, tag_value: "cycleway:both:lane", type: string }
          - { key: busway, tag_value: busway, type: string }
          - { key: busway_l, tag_value: "busway:left", type: string }
          - { key: busway_r, tag_value: "busway:right", type: string }
          - { key: busway_both, tag_value: "busway:both", type: string }
          - key: bus_lanes
            type: string
            coalesce:
              - tag_value: "bus:lanes"
              - tag_value: "psv:lanes"
          - key: bus_lanes_fw
            type: string
            coalesce:
              - tag_value: "bus:lanes:forward"
              - tag_value: "psv:lanes:forward"
          - key: bus_lanes_bw
            type: string
            coalesce:
              - tag_value: "bus:lanes:backward"
              - tag_value: "psv:lanes:backward"
          - { key: lanes_bus, tag_value: "lanes:bus", type: integer }
          - *bridge
          - *layer
      - source: osm
        geometry: line
        include_when:
          __all__:
            - highway: [footway, path, cycleway, pedestrian, steps]
            - bridge: __any__
            - __not__:
                bridge: "no"
        exclude_when: *road_exclusions
        attributes:
          - { key: class, tag_value: highway, type: string }
          - { key: width, tag_value: width, type: double }
          - *bridge
          - *layer

  - id: rails
    buffer: 32
    features:
      - source: osm
        geometry: line
        include_when:
          railway: [tram, light_rail, rail, narrow_gauge, subway]
        exclude_when: *rail_exclusions
        attributes:
          - { key: kind, tag_value: railway, type: string }
          - *bridge
          - *layer
          - { key: embedded, tag_value: embedded, type: string }

  - id: crossings
    buffer: 8
    features:
      - source: osm
        geometry: point
        include_when:
          highway: crossing
        attributes: &crossing_attributes
          - { key: markings, tag_value: "crossing:markings", type: string }
          - { key: crossing, tag_value: crossing, type: string }
          - { key: crossing_ref, tag_value: crossing_ref, type: string }
      - source: osm
        geometry: line
        include_when:
          footway: crossing
          cycleway: crossing
        attributes: *crossing_attributes

  - id: trees
    buffer: 8
    features:
      - source: osm
        geometry: point
        include_when:
          natural: tree
        attributes: &tree_attributes
          - { key: height, tag_value: height, type: double }
          - { key: crown, tag_value: diameter_crown, type: double }
          - { key: circ, tag_value: circumference, type: double }
          - { key: leaf, tag_value: leaf_type, type: string }
          - { key: genus, tag_value: genus, type: string }
      - source: osm
        geometry: line
        include_when:
          natural: tree_row
        attributes: *tree_attributes

  - id: furniture
    buffer: 8
    features:
      - source: osm
        geometry: point
        include_when:
          highway: [street_lamp, traffic_signals]
          amenity: bench
        attributes:
          - key: kind
            type: string
            value:
              lamp:
                highway: street_lamp
              signals:
                highway: traffic_signals
              bench:
                amenity: bench
          - { key: dir, tag_value: direction, type: string }
          - { key: sig_dir, tag_value: "traffic_signals:direction", type: string }
          - { key: mount, tag_value: lamp_mount, type: string }
          - { key: backrest, tag_value: backrest, type: boolean }

  - id: pitches
    buffer: 96
    features:
      - source: osm
        geometry: polygon
        include_when:
          leisure: pitch
        attributes:
          - { key: sport, tag_value: sport, type: string }
          - { key: surface, tag_value: surface, type: string }

examples:
  - name: primary road with lanes, turn lanes and a cycle lane
    input:
      source: osm
      geometry: line
      tags:
        highway: primary
        lanes: "4"
        "turn:lanes:forward": "left|through"
        "cycleway:right": lane
        width: "14.5"
    output:
      - layer: roads
        geometry: line
        tags:
          class: primary
          oneway: 0
          lanes: 4
          turn_fw: "left|through"
          cycle_r: lane
          width: 14.5
  - name: oneway=-1 residential street
    input:
      source: osm
      geometry: line
      tags:
        highway: residential
        oneway: "-1"
    output:
      - layer: roads
        geometry: line
        tags:
          class: residential
          oneway: -1
  - name: untagged motorway is one-way
    input:
      source: osm
      geometry: line
      tags:
        highway: motorway
        lanes: "3"
    output:
      - layer: roads
        geometry: line
        tags:
          class: motorway
          oneway: 1
          lanes: 3
  - name: roundabout is one-way
    input:
      source: osm
      geometry: line
      tags:
        highway: secondary
        junction: roundabout
    output:
      - layer: roads
        geometry: line
        tags:
          class: secondary
          oneway: 1
          junction: roundabout
  - name: bus lanes fall back to psv lanes
    input:
      source: osm
      geometry: line
      tags:
        highway: primary
        oneway: "yes"
        lanes: "2"
        "psv:lanes": "designated|yes"
    output:
      - layer: roads
        geometry: line
        tags:
          oneway: 1
          bus_lanes: "designated|yes"
  - name: road in a tunnel is excluded
    input:
      source: osm
      geometry: line
      tags:
        highway: primary
        tunnel: "yes"
    output: []
  - name: road with tunnel=no is kept
    input:
      source: osm
      geometry: line
      tags:
        highway: primary
        tunnel: "no"
    output:
      - layer: roads
        geometry: line
  - name: road on a negative layer is excluded
    input:
      source: osm
      geometry: line
      tags:
        highway: residential
        layer: "-1"
    output: []
  - name: driveway is excluded
    input:
      source: osm
      geometry: line
      tags:
        highway: service
        service: driveway
    output: []
  - name: footway bridge is kept
    input:
      source: osm
      geometry: line
      tags:
        highway: footway
        bridge: "yes"
        layer: "1"
    output:
      - layer: roads
        geometry: line
        tags:
          class: footway
          bridge: true
          layer: 1
  - name: footway on the ground is excluded
    input:
      source: osm
      geometry: line
      tags:
        highway: footway
    output: []
  - name: embedded tram
    input:
      source: osm
      geometry: line
      tags:
        railway: tram
        embedded: "yes"
    output:
      - layer: rails
        geometry: line
        tags:
          kind: tram
          embedded: "yes"
  - name: rail in a tunnel is excluded
    input:
      source: osm
      geometry: line
      tags:
        railway: subway
        tunnel: "yes"
    output: []
  - name: zebra crossing node
    input:
      source: osm
      geometry: point
      tags:
        highway: crossing
        "crossing:markings": zebra
    output:
      - layer: crossings
        geometry: point
        tags:
          markings: zebra
  - name: crossing way
    input:
      source: osm
      geometry: line
      tags:
        highway: footway
        footway: crossing
        crossing: traffic_signals
    output:
      - layer: crossings
        geometry: line
        tags:
          crossing: traffic_signals
  - name: street tree
    input:
      source: osm
      geometry: point
      tags:
        natural: tree
        height: "12.5"
        leaf_type: broadleaved
    output:
      - layer: trees
        geometry: point
        tags:
          height: 12.5
          leaf: broadleaved
  - name: tree row
    input:
      source: osm
      geometry: line
      tags:
        natural: tree_row
    output:
      - layer: trees
        geometry: line
  - name: street lamp
    input:
      source: osm
      geometry: point
      tags:
        highway: street_lamp
        lamp_mount: bent_mast
    output:
      - layer: furniture
        geometry: point
        tags:
          kind: lamp
          mount: bent_mast
  - name: traffic signals
    input:
      source: osm
      geometry: point
      tags:
        highway: traffic_signals
        "traffic_signals:direction": forward
    output:
      - layer: furniture
        geometry: point
        tags:
          kind: signals
          sig_dir: forward
  - name: bench
    input:
      source: osm
      geometry: point
      tags:
        amenity: bench
        direction: S
        backrest: "yes"
    output:
      - layer: furniture
        geometry: point
        tags:
          kind: bench
          dir: S
          backrest: true
  - name: football pitch
    input:
      source: osm
      geometry: polygon
      tags:
        leisure: pitch
        sport: soccer
    output:
      - layer: pitches
        geometry: polygon
        tags:
          sport: soccer
`;
