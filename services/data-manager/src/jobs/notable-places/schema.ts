export type NotablePlacesSchema = "notable_places" | "notable_places__staging";

export function assertValidNotablePlacesSchema(
  schema: string,
): asserts schema is NotablePlacesSchema {
  if (schema !== "notable_places" && schema !== "notable_places__staging") {
    throw new Error(`Invalid notable-places schema: ${schema}`);
  }
}

export function buildNotablePlacesSchemaDDL(schema: NotablePlacesSchema): string {
  assertValidNotablePlacesSchema(schema);
  return `
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
CREATE SCHEMA "${schema}";

CREATE TABLE "${schema}".places (
  qid TEXT CONSTRAINT places_qid_check CHECK (qid ~ '^Q[0-9]+$'),
  geom GEOMETRY(Point, 4326) NOT NULL CONSTRAINT places_geom_check
    CHECK (ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90),
  kind TEXT NOT NULL CONSTRAINT places_kind_check CHECK (kind IN ('place','settlement')),
  sitelinks INTEGER NOT NULL CONSTRAINT places_sitelinks_check CHECK (sitelinks >= 0),
  fame DOUBLE PRECISION NOT NULL CONSTRAINT places_fame_check CHECK (fame BETWEEN 0 AND 1),
  iata TEXT,
  icao TEXT,
  CONSTRAINT places_pkey PRIMARY KEY (qid)
);

-- Every label and alias as fetched, one row per language. Folded into names
-- and labels once complete, then dropped: the same name in several languages
-- is one name to search.
CREATE UNLOGGED TABLE "${schema}".fetched_names (
  qid TEXT NOT NULL,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL
);

CREATE TABLE "${schema}".descriptions (
  qid TEXT NOT NULL,
  lang TEXT NOT NULL,
  description TEXT NOT NULL,
  CONSTRAINT descriptions_pkey PRIMARY KEY (qid, lang),
  CONSTRAINT descriptions_qid_fkey FOREIGN KEY (qid)
    REFERENCES "${schema}".places ON DELETE CASCADE
);

CREATE TABLE "${schema}".index_state (
  singleton SMALLINT DEFAULT 1 CONSTRAINT index_state_singleton_check CHECK (singleton = 1),
  source TEXT NOT NULL,
  min_sitelinks INTEGER NOT NULL,
  epoch TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT index_state_status_check
    CHECK (status IN ('building','ready','failed')),
  place_count BIGINT NOT NULL DEFAULT 0,
  name_count BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  CONSTRAINT index_state_pkey PRIMARY KEY (singleton)
);
`;
}

/**
 * Folds the fetched names into what searches read — each place's distinct
 * names, and its label in each display language — and indexes them.
 */
export function buildNotablePlacesFinishDDL(
  schema: NotablePlacesSchema,
  displayLanguages: readonly string[],
): string {
  assertValidNotablePlacesSchema(schema);
  const languages = displayLanguages.map((lang) => {
    if (!/^[a-z]{2,3}$/.test(lang)) throw new Error(`invalid language code: ${lang}`);
    return `'${lang}'`;
  });
  return `
CREATE TABLE "${schema}".names AS
  SELECT DISTINCT ON (qid, normalized) qid, normalized, name
    FROM "${schema}".fetched_names
   ORDER BY qid, normalized, (kind = 'label') DESC, lang;
ALTER TABLE "${schema}".names ADD CONSTRAINT names_pkey PRIMARY KEY (qid, normalized);
ALTER TABLE "${schema}".names ADD CONSTRAINT names_qid_fkey
  FOREIGN KEY (qid) REFERENCES "${schema}".places ON DELETE CASCADE;

CREATE TABLE "${schema}".labels AS
  SELECT DISTINCT ON (qid, lang) qid, lang, name
    FROM "${schema}".fetched_names
   WHERE kind = 'label' AND lang IN (${languages.join(", ")})
   ORDER BY qid, lang, name;
ALTER TABLE "${schema}".labels ADD CONSTRAINT labels_pkey PRIMARY KEY (qid, lang);
ALTER TABLE "${schema}".labels ADD CONSTRAINT labels_qid_fkey
  FOREIGN KEY (qid) REFERENCES "${schema}".places ON DELETE CASCADE;

DROP TABLE "${schema}".fetched_names;

CREATE INDEX names_normalized_idx ON "${schema}".names (normalized text_pattern_ops);
-- Names spelled close to the text: trigrams find candidates, edit distance
-- keeps the near ones. PostGIS installs pg_trgm and fuzzystrmatch.
CREATE INDEX names_normalized_trgm_idx ON "${schema}".names USING GIN (normalized gin_trgm_ops);
CREATE INDEX places_geom_idx ON "${schema}".places USING GIST (geom);
`;
}
