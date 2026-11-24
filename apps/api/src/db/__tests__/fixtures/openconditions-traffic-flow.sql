-- OpenConditions' traffic-flow tile function, everything it calls and the
-- function that grants its consumers' roles, copied from OpenConditions'
-- migrations (packages/core/drizzle at 707bb689). The four tables it reads
-- and their indexes come from 0000_baseline.sql; flow_osm_credit,
-- flow_public_licenses, segment_flow and grant_consumer_roles come from
-- 0001_database_objects.sql, with the REVOKE that follows it there, without
-- their comments. The ingest service calls grant_consumer_roles() after
-- every migrate.
CREATE TABLE "conditions"."public_license_policy" (
	"license" text PRIMARY KEY NOT NULL
);
CREATE TABLE "conditions"."road_segment" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"way_id" bigint NOT NULL,
	"dir" text NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	"highway" text NOT NULL,
	"ref" text,
	"length_m" double precision NOT NULL,
	"min_zoom" smallint NOT NULL,
	"free_flow_kph" double precision,
	"openlr" text,
	"computed_at" timestamp with time zone NOT NULL
);
CREATE TABLE "conditions"."segment_speed" (
	"segment_id" text PRIMARY KEY NOT NULL,
	"current_kph" double precision,
	"free_flow_kph" double precision,
	"speed_ratio" double precision,
	"los" text NOT NULL,
	"confidence" text NOT NULL,
	"source_tier" text,
	"contributing" text[],
	"is_estimated" boolean DEFAULT false NOT NULL,
	"native_field_sources" jsonb,
	"field_sources" jsonb,
	"field_contributors" jsonb,
	"field_lineage_complete" jsonb,
	"permission_licenses" text[],
	"observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "segment_speed_los_check" CHECK ("los" IN ('free_flow', 'heavy', 'queuing', 'stationary', 'blocked', 'unknown')),
	CONSTRAINT "segment_speed_confidence_check" CHECK ("confidence" IN ('measured', 'estimated'))
);
CREATE TABLE "conditions"."source" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"format" text NOT NULL,
	"product" text NOT NULL,
	"access_mode" text NOT NULL,
	"tier" text NOT NULL,
	"country" text,
	"subdivision" text,
	"operator" text NOT NULL,
	"license" text NOT NULL,
	"license_url" text,
	"attribution" text NOT NULL,
	"credit_name" text,
	"credit_url" text,
	"credit_notice" text,
	"rights" jsonb,
	"restricted" boolean DEFAULT false NOT NULL,
	"restricted_since" timestamp with time zone,
	"fusion_restricted" boolean,
	"fusion_tier" text,
	"fusion_licenses" text,
	"federation_restricted" boolean,
	"federation_pending" boolean DEFAULT false NOT NULL,
	"cadence_sec" integer NOT NULL,
	"freshness_window_sec" integer NOT NULL,
	"raw_retention" text,
	"extras_allow" text[] DEFAULT '{}'::text[] NOT NULL,
	"extras_federate" boolean DEFAULT false NOT NULL,
	"lane_numbering" text,
	"parent_source_id" text,
	"policy_ids" text[],
	"selection_state" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_access_mode_check" CHECK ("access_mode" IN ('bulk', 'on_demand')),
	CONSTRAINT "source_tier_check" CHECK ("tier" IN ('authoritative', 'operator', 'aggregator', 'community'))
);
CREATE INDEX "road_segment_geom_idx" ON "conditions"."road_segment" USING gist ("geom");
CREATE INDEX "road_segment_way_id_idx" ON "conditions"."road_segment" USING btree ("way_id");
CREATE INDEX "road_segment_min_zoom_idx" ON "conditions"."road_segment" USING btree ("min_zoom");
CREATE FUNCTION conditions.flow_osm_credit()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '[{"sourceId":"openstreetmap","name":"OpenStreetMap","url":"https://www.openstreetmap.org/copyright","licensing":{"version":1,"bindings":[{"scope":"data","subject":"OpenStreetMap","license":{"kind":"spdx","expression":"ODbL-1.0"}}]},"attributionText":"© OpenStreetMap contributors"}]'::jsonb;
$$;
CREATE FUNCTION conditions.flow_public_licenses(licenses text[])
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT licenses IS NOT NULL AND cardinality(licenses) > 0
    AND NOT EXISTS (SELECT 1 FROM unnest(licenses) l(license)
      WHERE l.license IS NULL OR NOT EXISTS (
        SELECT 1 FROM conditions.public_license_policy p WHERE p.license = l.license));
$$;
CREATE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
RETURNS bytea AS $$
DECLARE bounds geometry := ST_TileEnvelope(z, x, y); mvt bytea;
BEGIN
  SELECT ST_AsMVT(t, 'segment_flow', 4096, 'geom') INTO mvt FROM (
    SELECT s.segment_id, s.dir, s.highway,
      sp.speed_ratio, sp.los, sp.confidence, sp.current_kph, sp.free_flow_kph,
      1 AS lineage_version,
      COALESCE(sp.field_sources, jsonb_build_object('geometry', jsonb_build_array('openstreetmap')))::text AS field_sources,
      COALESCE(sp.field_contributors, jsonb_build_object('geometry', conditions.flow_osm_credit()))::text AS field_contributors,
      COALESCE(sp.field_lineage_complete, jsonb_build_object('geometry',true,'speed',sp.current_kph IS NULL,'freeFlow',sp.free_flow_kph IS NULL,'ratio',sp.speed_ratio IS NULL,'los',sp.los IS NULL,'confidence',sp.confidence IS NULL))::text AS field_lineage_complete,
      ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM conditions.road_segment s
    LEFT JOIN conditions.segment_speed sp ON sp.segment_id = s.segment_id
      AND conditions.flow_public_licenses(sp.permission_licenses)
      AND NOT EXISTS (SELECT 1 FROM conditions.source scope_source
        WHERE scope_source.id = ANY(sp.contributing) AND scope_source.restricted)
    WHERE s.min_zoom <= z AND s.geom && ST_Transform(bounds, 4326)
  ) t WHERE t.geom IS NOT NULL;
  RETURN COALESCE(mvt, ''::bytea);
END;
$$ LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE;
CREATE FUNCTION "conditions".grant_consumer_roles() RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openmapx_tiles_owner') THEN
    GRANT USAGE ON SCHEMA "conditions" TO openmapx_tiles_owner;
    GRANT SELECT ON "conditions"."road_segment", "conditions"."segment_speed",
      "conditions"."source", "conditions"."public_license_policy" TO openmapx_tiles_owner;
    GRANT EXECUTE ON FUNCTION "conditions".segment_flow(integer, integer, integer, json),
      "conditions".flow_public_licenses(text[]), "conditions".flow_osm_credit()
      TO openmapx_tiles_owner;
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'openconditions_contributions') THEN
    GRANT USAGE ON SCHEMA "conditions" TO openconditions_contributions;
    GRANT SELECT ON "conditions"."__drizzle_migrations", "conditions"."source",
      "conditions"."feature", "conditions"."feature_component", "conditions"."offer",
      "conditions"."feature_canonical", "conditions"."observation",
      "conditions"."observation_rollup_progress", "conditions"."source_status",
      "conditions"."source_poll_attempt", "conditions"."federation_subscription",
      "conditions"."secrets_key_check" TO openconditions_contributions;
    GRANT INSERT ON "conditions"."situation_revision" TO openconditions_contributions;
    GRANT SELECT, INSERT ON "conditions"."issuer_key", "conditions"."spent_token",
      "conditions"."report_evidence", "conditions"."sub_claim", "conditions"."contributor_receipt",
      "conditions"."federation_outbox" TO openconditions_contributions;
    GRANT SELECT, DELETE ON "conditions"."record_relation" TO openconditions_contributions;
    GRANT SELECT, INSERT, DELETE ON "conditions"."report_refusal", "conditions"."situation_effect"
      TO openconditions_contributions;
    GRANT SELECT, INSERT, UPDATE ON "conditions"."reporter", "conditions"."token_quota",
      "conditions"."situation", "conditions"."binding_queue" TO openconditions_contributions;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "conditions"."block_list",
      "conditions"."observation_latest" TO openconditions_contributions;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION "conditions".grant_consumer_roles() FROM PUBLIC;
