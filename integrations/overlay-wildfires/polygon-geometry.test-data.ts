export const VALID_WILDFIRE_POLYGON_GEOMETRIES = [
  {
    name: "polygon",
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 35],
        ],
      ],
    },
  },
  {
    name: "polygon with a hole",
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 35],
        ],
        [
          [-119.8, 35.2],
          [-119.4, 35.2],
          [-119.4, 35.6],
          [-119.8, 35.2],
        ],
      ],
    },
  },
  {
    name: "multipolygon",
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [-120, 35],
            [-119, 35],
            [-119, 36],
            [-120, 35],
          ],
        ],
        [
          [
            [-118, 34],
            [-117, 34],
            [-117, 35],
            [-118, 34],
          ],
        ],
      ],
    },
  },
  {
    name: "WGS84 boundary coordinates",
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-180, -90],
          [180, -90],
          [180, 90],
          [-180, -90],
        ],
      ],
    },
  },
  {
    name: "finite altitude",
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-120, 35, 10],
          [-119, 35, 20],
          [-119, 36, 30],
          [-120, 35, 10],
        ],
      ],
    },
  },
] as const;

export const INVALID_WILDFIRE_POLYGON_GEOMETRIES = [
  { name: "null", geometry: null },
  { name: "array", geometry: [] },
  { name: "point", geometry: { type: "Point", coordinates: [-120, 35] } },
  { name: "missing coordinates", geometry: { type: "Polygon" } },
  { name: "empty polygon", geometry: { type: "Polygon", coordinates: [] } },
  { name: "empty multipolygon", geometry: { type: "MultiPolygon", coordinates: [] } },
  {
    name: "short ring",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-120, 35],
        ],
      ],
    },
  },
  {
    name: "unclosed ring",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 36],
        ],
      ],
    },
  },
  {
    name: "polygon nesting one level too deep",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [
            [-120, 35],
            [-119, 35],
            [-119, 36],
            [-120, 35],
          ],
        ],
      ],
    },
  },
  {
    name: "multipolygon nesting one level too shallow",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 35],
        ],
      ],
    },
  },
  {
    name: "non-finite longitude",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [Number.NaN, 35],
          [-119, 35],
          [-119, 36],
          [Number.NaN, 35],
        ],
      ],
    },
  },
  {
    name: "non-finite latitude",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, Number.POSITIVE_INFINITY],
          [-119, 35],
          [-119, 36],
          [-120, Number.POSITIVE_INFINITY],
        ],
      ],
    },
  },
  {
    name: "out-of-range longitude",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-181, 35],
          [-119, 35],
          [-119, 36],
          [-181, 35],
        ],
      ],
    },
  },
  {
    name: "out-of-range latitude",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 91],
          [-119, 35],
          [-119, 36],
          [-120, 91],
        ],
      ],
    },
  },
  {
    name: "non-numeric coordinate",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          ["-120", 35],
          [-119, 35],
          [-119, 36],
          ["-120", 35],
        ],
      ],
    },
  },
  {
    name: "non-finite altitude",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 35, Number.POSITIVE_INFINITY],
          [-119, 35, 20],
          [-119, 36, 30],
          [-120, 35, Number.POSITIVE_INFINITY],
        ],
      ],
    },
  },
  {
    name: "closure with different dimensions",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-120, 35],
          [-119, 35],
          [-119, 36],
          [-120, 35, 0],
        ],
      ],
    },
  },
] as const;
