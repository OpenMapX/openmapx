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
CREATE EXTENSION IF NOT EXISTS postgis;
-- Names spelled close to the text: trigrams find candidates, edit distance
-- keeps the near ones.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
DROP SCHEMA IF EXISTS "${schema}" CASCADE;
CREATE SCHEMA "${schema}";

CREATE TABLE "${schema}".places (
  qid TEXT PRIMARY KEY CHECK (qid ~ '^Q[0-9]+$'),
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  geom GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
  ) STORED,
  kind TEXT NOT NULL CHECK (kind IN ('place','settlement')),
  sitelinks INTEGER NOT NULL CHECK (sitelinks >= 0),
  fame DOUBLE PRECISION NOT NULL CHECK (fame BETWEEN 0 AND 1),
  iata TEXT,
  icao TEXT
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
  qid TEXT NOT NULL REFERENCES "${schema}".places ON DELETE CASCADE,
  lang TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (qid, lang)
);

CREATE TABLE "${schema}".index_state (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  source TEXT NOT NULL,
  min_sitelinks INTEGER NOT NULL,
  epoch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','ready','failed')),
  place_count BIGINT NOT NULL DEFAULT 0,
  name_count BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  last_error TEXT
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
ALTER TABLE "${schema}".names ADD PRIMARY KEY (qid, normalized);
ALTER TABLE "${schema}".names
  ADD FOREIGN KEY (qid) REFERENCES "${schema}".places ON DELETE CASCADE;

CREATE TABLE "${schema}".labels AS
  SELECT DISTINCT ON (qid, lang) qid, lang, name
    FROM "${schema}".fetched_names
   WHERE kind = 'label' AND lang IN (${languages.join(", ")})
   ORDER BY qid, lang, name;
ALTER TABLE "${schema}".labels ADD PRIMARY KEY (qid, lang);
ALTER TABLE "${schema}".labels
  ADD FOREIGN KEY (qid) REFERENCES "${schema}".places ON DELETE CASCADE;

DROP TABLE "${schema}".fetched_names;

CREATE INDEX idx_notable_names_prefix ON "${schema}".names (normalized text_pattern_ops);
CREATE INDEX idx_notable_names_trigram ON "${schema}".names USING GIN (normalized gin_trgm_ops);
CREATE INDEX idx_notable_places_geom ON "${schema}".places USING GIST (geom);
`;
}
