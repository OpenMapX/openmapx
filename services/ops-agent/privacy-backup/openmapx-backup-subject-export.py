#!/usr/bin/env python3
"""Fail-closed, streaming subject projection from a verified OpenMapX backup."""

import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

MAX_INPUT = 64 * 1024
MAX_ENTRY = 256 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 96
DAWARICH_IMAGE = "freikin/dawarich:1.10.3"
DAWARICH_IMAGE_DIGEST = "sha256:d7457e7b27a9992f2fdd367fe22a515b1b44fc6e0cfb7a68f3c69c439c465a6b"
DAWARICH_COMMIT = "da551a0e32f67b4d8ac6d50132c26634d6ad29a4"
DAWARICH_SCHEMA_FINGERPRINT = "cddd7f3971bf07ffdcc51909714d90c0d476644e414c68aa9613a601cf4bc8f1"
DAWARICH_RELATION_FINGERPRINT_VERSION = "dawarich-relations-v2"
SAFE_EXTENSIONS = {"bin", "csv", "fit", "gpx", "json", "jsonl", "jpg", "jpeg", "kml", "pdf", "png", "tcx", "txt"}

# Keep the order and names identical to the audited Rails collector.  The
# restored database still supplies every observed column and FK at runtime;
# these entries only define the reviewed model/table and ownership mapping.
DAWARICH_SCHEMA_MODELS = [
    ("User", "users", ["id", "provider", "uid", "email", "created_at", "updated_at"], []),
    ("Area", "areas", ["id", "user_id", "name", "latitude", "longitude", "radius", "created_at", "updated_at"], ["user_id"]),
    ("Place", "places", ["id", "user_id", "name", "latitude", "longitude", "created_at", "updated_at"], ["user_id"]),
    ("Tag", "tags", ["id", "user_id", "name", "created_at", "updated_at"], ["user_id"]),
    ("Tagging", "taggings", ["id", "tag_id", "taggable_id", "taggable_type", "created_at", "updated_at"], []),
    ("Import", "imports", ["id", "user_id", "name", "created_at", "updated_at"], ["user_id"]),
    ("Export", "exports", ["id", "user_id", "name", "status", "created_at", "updated_at"], ["user_id"]),
    ("Trip", "trips", ["id", "user_id", "name", "started_at", "ended_at", "created_at", "updated_at"], ["user_id"]),
    ("Notification", "notifications", ["id", "user_id", "title", "content", "created_at", "updated_at"], ["user_id"]),
    ("Point", "points", ["id", "user_id", "timestamp", "lonlat", "created_at", "updated_at"], ["user_id"]),
    ("Visit", "visits", ["id", "user_id", "name", "started_at", "ended_at", "created_at", "updated_at"], ["user_id"]),
    ("Stat", "stats", ["id", "user_id", "year", "month", "distance", "created_at", "updated_at"], ["user_id"]),
    ("Track", "tracks", ["id", "user_id", "start_at", "end_at", "original_path", "created_at", "updated_at"], ["user_id"]),
    ("TrackSegment", "track_segments", ["id", "track_id", "start_index", "end_index", "created_at", "updated_at"], ["track_id"]),
    ("Digest", "digests", ["id", "user_id", "year", "period_type", "created_at", "updated_at"], ["user_id"]),
    ("RawDataArchive", "points_raw_data_archives", ["id", "user_id", "year", "month", "chunk_number", "created_at", "updated_at"], ["user_id"]),
    ("Flight", "flights", ["id", "user_id", "external_id", "flight_date", "created_at", "updated_at"], ["user_id"]),
    ("Note", "notes", ["id", "user_id", "body", "noted_at", "created_at", "updated_at"], ["user_id"]),
    ("Poster", "posters", ["id", "user_id", "name", "created_at", "updated_at"], ["user_id"]),
    ("SharedLink", "shared_links", ["id", "user_id", "name", "resource_type", "created_at", "updated_at"], ["user_id"]),
    ("Family", "families", ["id", "creator_id", "name", "created_at", "updated_at"], ["creator_id"]),
    ("FamilyMembership", "family_memberships", ["id", "family_id", "user_id", "role", "created_at", "updated_at"], ["family_id", "user_id"]),
    ("FamilyInvitation", "family_invitations", ["id", "family_id", "invited_by_id", "email", "token", "status", "expires_at", "created_at", "updated_at"], ["family_id", "invited_by_id"]),
    ("FamilyLocationRequest", "family_location_requests", ["id", "family_id", "requester_id", "target_user_id", "status", "expires_at", "created_at", "updated_at"], ["family_id", "requester_id", "target_user_id"]),
    ("PendingImport", "pending_imports", ["id", "claimed_by_user_id", "original_filename", "origin", "expires_at", "created_at", "updated_at"], []),
]

DAWARICH_EXPECTED_FOREIGN_KEYS = sorted([
    "active_storage_attachments.blob_id->active_storage_blobs.id",
    "active_storage_variant_records.blob_id->active_storage_blobs.id",
    "areas.user_id->users.id", "digests.user_id->users.id", "families.creator_id->users.id",
    "family_invitations.family_id->families.id", "family_invitations.invited_by_id->users.id",
    "family_location_requests.family_id->families.id", "family_location_requests.requester_id->users.id",
    "family_location_requests.target_user_id->users.id", "family_memberships.family_id->families.id",
    "family_memberships.user_id->users.id", "flights.user_id->users.id", "notes.user_id->users.id",
    "notifications.user_id->users.id", "pending_imports.claimed_by_user_id->users.id",
    "place_visits.place_id->places.id", "place_visits.visit_id->visits.id",
    "points.raw_data_archive_id->points_raw_data_archives.id", "points.user_id->users.id",
    "points.visit_id->visits.id", "points_raw_data_archives.user_id->users.id",
    "posters.user_id->users.id", "shared_links.user_id->users.id", "stats.user_id->users.id",
    "taggings.tag_id->tags.id", "tags.user_id->users.id", "track_segments.track_id->tracks.id",
    "tracks.user_id->users.id", "trips.user_id->users.id", "visits.area_id->areas.id",
    "visits.place_id->places.id", "visits.user_id->users.id",
])


def fail(code):
    print(code, file=sys.stderr)
    raise SystemExit(65)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def hash_file(path):
    size = 0
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def read_request():
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT or sys.stdin.buffer.read(1):
        fail("invalid_request")
    try:
        value = json.loads(raw)
    except Exception:
        fail("invalid_request")
    required = {"version", "requestId", "backupId", "manifestDigest", "cutoff", "subjectLocator", "collectorContract", "sources"}
    locator = value.get("subjectLocator") if isinstance(value, dict) else None
    if set(value) != required or value["version"] != 1 or value["collectorContract"] != "openmapx-subject-export-v1" or not isinstance(locator, dict) or set(locator) != {"kind", "value"} or locator.get("kind") != "user_id":
        fail("invalid_request")
    subject = locator.get("value")
    if not isinstance(subject, str) or not 1 <= len(subject) <= 256 or any(ord(char) <= 31 or ord(char) == 127 for char in subject):
        fail("invalid_request")
    if not isinstance(value["sources"], list) or not 1 <= len(value["sources"]) <= 3:
        fail("unsupported_schema")
    return value


def verified_sources(request):
    root = Path("/input")
    raw = (root / "manifest.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != request["manifestDigest"]:
        fail("backup_digest_changed")
    try:
        manifest = json.loads(raw)
    except Exception:
        fail("unsupported_schema")
    if manifest.get("formatVersion") != 2:
        fail("unsupported_schema")
    declared = {(service.get("id"), volume.get("file")): volume for service in manifest.get("services", []) for volume in service.get("volumes", [])}
    contracts = {
        "openmapx-v1": ("openmapx", "postgis", "pg_dump"),
        "dawarich-1.10.3": ("dawarich", "dawarich-postgis", "pg_dump"),
        "dawarich-storage-1.10.3": ("dawarich-storage", "dawarich-app", "tar"),
    }
    result = []
    seen = set()
    for source in request["sources"]:
        if not isinstance(source, dict) or set(source) != {"family", "serviceId", "file", "schemaContract"} or source.get("schemaContract") not in contracts:
            fail("unsupported_schema")
        contract = source["schemaContract"]
        family, service_id, mode = contracts[contract]
        volume = declared.get((source.get("serviceId"), source.get("file")))
        if contract in seen or source.get("family") != family or source.get("serviceId") != service_id or not volume or volume.get("mode") != mode:
            fail("unsupported_schema")
        if contract == "dawarich-storage-1.10.3" and volume.get("name") != "openmapx-dawarich-storage":
            fail("unsupported_schema")
        path = root / source["file"]
        if path.parent != root or path.is_symlink() or not path.is_file():
            fail("backup_unavailable")
        size, digest = hash_file(path)
        if size != volume.get("sizeBytes") or digest != volume.get("sha256"):
            fail("backup_digest_changed")
        seen.add(contract)
        result.append({**source, "path": path})
    if "dawarich-1.10.3" in seen:
        managed = manifest.get("privacySourceProvenance", {}).get("managedDawarich")
        if managed != {"version": "1.10.3", "image": "freikin/dawarich", "imageDigest": DAWARICH_IMAGE_DIGEST, "upstreamCommit": DAWARICH_COMMIT, "schemaContract": "dawarich-1.10.3"}:
            fail("unsupported_schema")
    if "dawarich-storage-1.10.3" in seen and "dawarich-1.10.3" not in seen:
        fail("unsupported_schema")
    return result, manifest


def command(args, stdin=None):
    return subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)


def psql(socket, statement):
    result = command(["psql", "-h", str(socket), "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"], statement.encode())
    if result.returncode:
        fail("unsupported_schema")
    return result.stdout


def columns(socket, table):
    result = psql(socket, f"SELECT COALESCE(json_agg(column_name ORDER BY ordinal_position),'[]'::json) FROM information_schema.columns WHERE table_schema='public' AND table_name={literal(table)};")
    try:
        return json.loads(result or b"[]")
    except Exception:
        fail("unsupported_schema")


def require(socket, table, required):
    actual = columns(socket, table)
    if not actual or not set(required).issubset(actual):
        fail("unsupported_schema")
    return actual


def validate_dawarich_schema(socket):
    relations = []
    for model, table, required, foreign_keys in DAWARICH_SCHEMA_MODELS:
        actual = sorted(require(socket, table, required + foreign_keys))
        relations.append({
            "entry": model,
            "model": model,
            "columns": actual,
            "foreignKey": ",".join(foreign_keys) or None,
        })
    observed = json.loads(psql(socket, """
SELECT COALESCE(json_agg(edge ORDER BY edge),'[]'::json)
FROM (
  SELECT source.relname || '.' || string_agg(source_column.attname, ',' ORDER BY columns.ordinality)
    || '->' || target.relname || '.' || string_agg(target_column.attname, ',' ORDER BY columns.ordinality) AS edge
  FROM pg_constraint constraint_row
  JOIN pg_class source ON source.oid = constraint_row.conrelid
  JOIN pg_namespace namespace ON namespace.oid = source.relnamespace
  JOIN pg_class target ON target.oid = constraint_row.confrelid
  CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
    WITH ORDINALITY AS columns(source_number, target_number, ordinality)
  JOIN pg_attribute source_column ON source_column.attrelid = source.oid AND source_column.attnum = columns.source_number
  JOIN pg_attribute target_column ON target_column.attrelid = target.oid AND target_column.attnum = columns.target_number
  WHERE constraint_row.contype = 'f' AND namespace.nspname = 'public'
  GROUP BY constraint_row.oid, source.relname, target.relname
) reviewed_edges;
""") or b"[]")
    if observed != DAWARICH_EXPECTED_FOREIGN_KEYS:
        fail("unsupported_schema")
    document = {
        "version": DAWARICH_RELATION_FINGERPRINT_VERSION,
        "user": sorted(columns(socket, "users")),
        "relations": relations,
    }
    fingerprint = hashlib.sha256(json.dumps(document, separators=(",", ":")).encode()).hexdigest()
    if fingerprint != DAWARICH_SCHEMA_FINGERPRINT:
        fail("unsupported_schema")
    return fingerprint, relations


def projection(alias, fields, extras=()):
    pairs = []
    for field in fields:
        pairs.extend([literal(field), f"to_jsonb({alias})->{literal(field)}"])
    for key, expression in extras:
        pairs.extend([literal(key), expression])
    return "jsonb_build_object(" + ",".join(pairs) + ")"


SECRET_KEY = re.compile(r"password|token|secret|api[_-]?key|credential|private|otp|bearer|cookie|authorization|encrypted|assertion|signature", re.I)
SAFE_SECRET_LIKE_KEYS = {
    "credential_id",
    "access_token_expires_at",
    "refresh_token_expires_at",
    "hasAccessToken",
    "hasRefreshToken",
    "hasIdToken",
    "hasPassword",
    "hasSecret",
    "secretKind",
}


def normalize_value(value, depth=0, key=None):
    if depth > 16:
        fail("limit_exceeded")
    if key is not None and str(key) not in SAFE_SECRET_LIKE_KEYS and SECRET_KEY.search(str(key)):
        return "[redacted]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value.encode("utf-8")) > 64 * 1024:
            fail("limit_exceeded")
        return value
    if isinstance(value, list):
        if len(value) > 10_000:
            fail("limit_exceeded")
        return [normalize_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 256:
            fail("limit_exceeded")
        result = {}
        for child_key, child_value in value.items():
            normalized_key = str(child_key)
            if len(normalized_key.encode("utf-8")) > 128:
                fail("limit_exceeded")
            result[normalized_key] = normalize_value(child_value, depth + 1, normalized_key)
        return result
    fail("unsupported_schema")


class QueryReader(io.RawIOBase):
    def __init__(self, socket, select_sql):
        args = ["psql", "-h", str(socket), "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", select_sql]
        self.child = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.pending = bytearray()
        self.eof = False

    def readable(self):
        return True

    def read(self, size=-1):
        target = 64 * 1024 if size is None or size < 0 else size
        while len(self.pending) < target and not self.eof:
            line = self.child.stdout.readline(MAX_ENTRY + 2)
            if not line:
                self.eof = True
                if self.child.wait() != 0:
                    fail("collector_failed")
                break
            if len(line) > MAX_ENTRY or not line.endswith(b"\n"):
                fail("limit_exceeded")
            try:
                record = normalize_value(json.loads(line))
                encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
            except (UnicodeError, ValueError, TypeError):
                fail("collector_failed")
            if len(encoded) > MAX_ENTRY:
                fail("limit_exceeded")
            self.pending.extend(encoded)
        value = bytes(self.pending[:target])
        del self.pending[:target]
        return value

    def close(self):
        if not self.closed:
            self.child.stdout.close()
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
        super().close()


def query_descriptor(socket, path, select_sql, portability=False, redactions=None):
    stream = QueryReader(socket, select_sql)
    size = records = 0
    digest = hashlib.sha256()
    try:
        while chunk := stream.read(64 * 1024):
            size += len(chunk)
            records += chunk.count(b"\n")
            digest.update(chunk)
            if size > MAX_ENTRY or records > 10_000_000:
                fail("limit_exceeded")
    finally:
        stream.close()
    return {"path": path, "bytes": size, "sha256": digest.hexdigest(), "records": records, "article15": True, "portability": portability, "redactionCodes": redactions or [], "open": lambda: QueryReader(socket, select_sql)}


def static_descriptor(path, content, records=None, portability=False, redactions=None):
    if len(content) > MAX_ENTRY:
        fail("limit_exceeded")
    return {"path": path, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "records": records, "article15": True, "portability": portability, "redactionCodes": redactions or [], "open": lambda: io.BytesIO(content)}


def simple(socket, path, table, owner, fields, subject, portability=False, redactions=None):
    actual = require(socket, table, ["id", owner])
    cutoff = f" AND t.created_at<={literal(REQUEST['cutoff'])}::timestamptz" if "created_at" in actual else ""
    select = f"SELECT {projection('t', fields)} FROM {table} t WHERE t.{owner}={subject}{cutoff} ORDER BY t.id"
    return query_descriptor(socket, path, select, portability, redactions)


def optional(entries, warnings, socket, registration, table, owner, fields, subject, **options):
    if columns(socket, table):
        entries.append(simple(socket, f"openmapx/{registration}.jsonl", table, owner, fields, subject, **options))
    else:
        warnings.append(f"openmapx-{registration}-missing")


def project_openmapx(socket):
    subject = literal(REQUEST["subjectLocator"]["value"])
    require(socket, "user", ["id", "email", "created_at", "updated_at"])
    entries, warnings = [], []
    profile = ["id", "name", "email", "email_verified", "image", "created_at", "updated_at", "role", "banned", "ban_reason", "ban_expires", "normalized_email", "two_factor_enabled"]
    entries.append(query_descriptor(socket, "openmapx/account-profile.jsonl", f"SELECT {projection('u', profile)} FROM \"user\" u WHERE u.id={subject}", True, ["credentials-excluded"]))
    if columns(socket, "account"):
        require(socket, "account", ["id", "user_id", "access_token", "refresh_token", "id_token", "password"])
        fields = ["id", "issuer", "account_id", "provider_id", "scope", "access_token_expires_at", "refresh_token_expires_at", "created_at", "updated_at"]
        extras = [("hasAccessToken", "a.access_token IS NOT NULL"), ("hasRefreshToken", "a.refresh_token IS NOT NULL"), ("hasIdToken", "a.id_token IS NOT NULL"), ("hasPassword", "a.password IS NOT NULL")]
        entries.append(query_descriptor(socket, "openmapx/auth-accounts.jsonl", f"SELECT {projection('a', fields, extras)} FROM account a WHERE a.user_id={subject} AND a.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY a.id", False, ["credential-redacted", "secret-presence-only"]))
    else:
        warnings.append("openmapx-auth-accounts-missing")
    optional(entries, warnings, socket, "auth-sessions", "session", "user_id", ["id", "expires_at", "created_at", "updated_at", "ip_address", "user_agent"], subject, redactions=["session-token-redacted", "rights-of-others-redacted"])
    optional(entries, warnings, socket, "auth-passkeys", "passkey", "user_id", ["id", "name", "public_key", "credential_id", "counter", "device_type", "backed_up", "transports", "created_at", "aaguid"], subject, redactions=["authentication-key-metadata"])
    optional(entries, warnings, socket, "auth-two-factor", "two_factor", "user_id", ["id", "verified", "failed_verification_count", "locked_until"], subject, redactions=["authentication-secret"])
    if columns(socket, "verification"):
        fields = ["id", "identifier", "expires_at", "created_at", "updated_at"]
        entries.append(query_descriptor(socket, "openmapx/auth-verifications.jsonl", f"SELECT {projection('v', fields)} FROM verification v JOIN \"user\" u ON u.email=v.identifier WHERE u.id={subject} AND v.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY v.id", False, ["challenge-redacted"]))
    else:
        warnings.append("openmapx-auth-verifications-missing")
    oauth = []
    specs = [("oauth_client", "client", ["id", "client_id", "client_discovery_id", "disabled", "created_at", "updated_at", "name", "uri", "scopes", "redirect_uris"]), ("oauth_refresh_token", "refresh-token", ["id", "client_id", "session_id", "reference_id", "resources", "expires_at", "created_at", "revoked", "scopes"]), ("oauth_access_token", "access-token", ["id", "client_id", "session_id", "reference_id", "resources", "expires_at", "created_at", "revoked", "scopes"]), ("oauth_consent", "consent", ["id", "client_id", "reference_id", "resources", "scopes", "created_at", "updated_at"])]
    for table, kind, fields in specs:
        if columns(socket, table):
            require(socket, table, ["id", "user_id"])
            oauth.append(f"SELECT {projection('o', fields, [('recordType', literal(kind))])} row,o.id::text sort_id FROM {table} o WHERE o.user_id={subject}")
    if oauth:
        entries.append(query_descriptor(socket, "openmapx/auth-oauth-resources.jsonl", "SELECT row FROM (" + " UNION ALL ".join(oauth) + ") q ORDER BY row->>'recordType',sort_id", False, ["oauth-secret-redacted"]))
    else:
        warnings.append("openmapx-auth-oauth-resources-missing")
    for registration, table, owner, fields, portable, redactions in [
        ("saved-lists", "saved_list", "user_id", ["id", "name", "icon", "is_private", "sort_order", "created_at", "updated_at"], True, ["shared-content-review"]),
        ("labeled-places", "labeled_place", "user_id", ["id", "label", "icon", "name", "address", "lat", "lng", "place_id"], True, []),
        ("personal-vehicles", "personal_vehicle", "user_id", ["id", "name", "kind", "powertrain", "is_default", "preset_id", "ev", "fuel_consumption_l_per_100km", "created_at", "updated_at"], True, []),
        ("parked-locations", "parked_location", "user_id", ["id", "vehicle_id", "lat", "lng", "address", "note", "expires_at", "source", "accuracy_meters", "saved_at", "updated_at"], True, ["shared-location-review"]),
        ("share-links", "share_link", "user_id", ["id", "target_type", "mode", "label", "created_at", "updated_at", "expires_at"], True, ["share-token-redacted", "shared-content-review"]),
        ("timeline-connections", "personal_timeline_connection", "user_id", ["id", "mode", "public_origin", "display_name", "upstream_user_id", "upstream_email", "upstream_time_zone", "distance_unit", "status", "consecutive_failures", "validated_at", "last_read_at", "created_at", "updated_at"], True, ["timeline-credential-redacted"]),
        ("mobile-auth-handoffs", "mobile_auth_handoff", "user_id", ["id", "purpose", "created_at", "expires_at", "consumed_at"], False, ["handoff-secret-redacted"]),
        ("disclosure-events", "data_disclosure_event", "user_id", ["id", "occurred_at", "recipient_id", "recipient_name", "recipient_role", "recipient_country", "recipient_privacy_url", "integration_id", "operation_code", "category_code", "purpose_code", "legal_basis_code", "transfer_safeguard_code", "external_reference_digest", "created_at"], False, []),
    ]:
        optional(entries, warnings, socket, registration, table, owner, fields, subject, portability=portable, redactions=redactions)
    if columns(socket, "saved_place") and columns(socket, "saved_list"):
        fields = ["id", "list_id", "place_id", "name", "address", "lat", "lng", "note", "sort_order", "created_at"]
        entries.append(query_descriptor(socket, "openmapx/saved-places.jsonl", f"SELECT {projection('p', fields)} FROM saved_place p JOIN saved_list l ON l.id=p.list_id WHERE l.user_id={subject} AND p.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY p.id", True, ["shared-content-review"]))
    else:
        warnings.append("openmapx-saved-places-missing")
    if columns(socket, "mangrove_keypair"):
        fields = ["user_id", "encryption_mode", "public_jwk", "created_at"]
        entries.append(query_descriptor(socket, "openmapx/mangrove-keypairs.jsonl", f"SELECT {projection('k', fields)} FROM mangrove_keypair k WHERE k.user_id={subject}", False, ["private-key-material-redacted"]))
    else:
        warnings.append("openmapx-mangrove-keypairs-missing")
    for registration, table, where, fields, redactions in [
        ("admin-audit-attribution", "admin_audit_log", f"a.actor_id={subject} OR a.target_id={subject}", ["id", "target_type", "action", "created_at"], ["rights-of-others", "audit-details-review"]),
        ("admin-jobs-attribution", "admin_job", f"a.created_by={subject}", ["id", "type", "status", "progress", "created_at", "started_at", "finished_at"], ["job-payload-review"]),
        ("installed-component-attribution", "installed_extension", f"a.installed_by={subject}", ["id", "name", "source_url", "source_trust", "installed_version", "installed_at", "updated_at"], []),
    ]:
        actual = columns(socket, table)
        if actual:
            cutoff = f" AND a.created_at<={literal(REQUEST['cutoff'])}::timestamptz" if "created_at" in actual else ""
            entries.append(query_descriptor(socket, f"openmapx/{registration}.jsonl", f"SELECT {projection('a', fields)} FROM {table} a WHERE ({where}){cutoff} ORDER BY a.id", False, redactions))
        else:
            warnings.append(f"openmapx-{registration}-missing")
    secret_parts = []
    for table, kind in [("service_secret", "service"), ("integration_secret", "integration")]:
        if columns(socket, table):
            fields = ["id", f"{kind}_id", "key", "created_at", "updated_at"]
            secret_parts.append(f"SELECT {projection('s', fields, [('secretKind', literal(kind)), ('hasSecret', 'true')])} row,s.id::text sort_id FROM {table} s WHERE s.updated_by={subject}")
    if secret_parts:
        entries.append(query_descriptor(socket, "openmapx/secret-update-attribution.jsonl", "SELECT row FROM (" + " UNION ALL ".join(secret_parts) + ") q ORDER BY row->>'secretKind',sort_id", False, ["secret-value-redacted"]))
    else:
        warnings.append("openmapx-secret-update-attribution-missing")
    if columns(socket, "system_settings"):
        require(socket, "system_settings", ["key", "updated_by"])
        fields = ["key", "updated_at", "updated_by"]
        entries.append(query_descriptor(socket, "openmapx/system-setting-attribution.jsonl", f"SELECT {projection('s', fields)} FROM system_settings s WHERE s.updated_by={subject} ORDER BY s.key", False, ["setting-value-redacted"]))
    else:
        warnings.append("openmapx-system-setting-attribution-missing")
    if columns(socket, "data_subject_request"):
        require(socket, "data_subject_request", ["id", "user_id", "received_at"])
        fields = ["id", "kind", "channel", "state", "received_at", "registered_at", "due_at", "identity_state", "delivery_state", "completed_at", "closed_at"]
        entries.append(query_descriptor(socket, "openmapx/privacy-case-records.jsonl", f"SELECT {projection('r', fields)} FROM data_subject_request r WHERE r.user_id={subject} AND r.received_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY r.id", False, ["protected-case-detail", "related-case-records-operator-review-required"]))
        warnings.append("openmapx-privacy-case-related-records-operator-review-required")
    else:
        warnings.append("openmapx-privacy-case-records-missing")
    warnings.extend(["openmapx-offline-package-ownership-operator-review-required", "openmapx-data-manager-trigger-attribution-operator-review-required"])
    return entries, warnings, None


DAWARICH = {
    "areas": ("areas", "user_id", ["id", "name", "latitude", "longitude", "radius", "created_at", "updated_at"]),
    "places": ("places", "user_id", ["id", "name", "city", "country", "latitude", "longitude", "source", "note", "geodata", "created_at", "updated_at"]),
    "tags": ("tags", "user_id", ["id", "name", "color", "icon", "privacy_radius_meters", "created_at", "updated_at"]),
    "imports": ("imports", "user_id", ["id", "name", "source", "status", "demo", "points_count", "raw_points", "processed", "doubles", "created_at", "updated_at", "processing_started_at"]),
    "export-records": ("exports", "user_id", ["id", "name", "file_type", "file_format", "status", "start_at", "end_at", "created_at", "updated_at", "processing_started_at"]),
    "trips": ("trips", "user_id", ["id", "name", "started_at", "ended_at", "distance", "path", "visited_countries", "demo", "created_at", "updated_at", "last_recalculated_at"]),
    "notifications": ("notifications", "user_id", ["id", "title", "content", "kind", "read_at", "created_at", "updated_at"]),
    "visits": ("visits", "user_id", ["id", "name", "started_at", "ended_at", "duration", "confidence", "confidence_breakdown", "status", "area_id", "place_id", "demo", "created_at", "updated_at"]),
    "stats": ("stats", "user_id", ["id", "year", "month", "distance", "daily_distance", "h3_hex_ids", "toponyms", "created_at", "updated_at"]),
    "tracks": ("tracks", "user_id", ["id", "start_at", "end_at", "distance", "duration", "avg_speed", "dominant_mode", "elevation_gain", "elevation_loss", "elevation_max", "elevation_min", "tracker_id", "demo", "original_path", "created_at", "updated_at"]),
    "digests": ("digests", "user_id", ["id", "year", "month", "period_type", "distance", "sent_at", "all_time_stats", "first_time_visits", "monthly_distances", "time_spent_by_location", "toponyms", "travel_patterns", "year_over_year", "created_at", "updated_at"]),
    "raw-archives": ("points_raw_data_archives", "user_id", ["id", "year", "month", "chunk_number", "point_count", "point_ids_checksum", "archived_at", "verified_at", "metadata", "created_at", "updated_at"]),
    "flights": ("flights", "user_id", ["id", "external_id", "flight_date", "date_precision", "flight_number", "departure_time", "arrival_time", "from_code", "from_name", "from_lat", "from_lon", "to_code", "to_name", "to_lat", "to_lon", "airline_iata", "airline_name", "aircraft_name", "aircraft_reg", "distance_km", "seat", "seat_class", "note", "created_at", "updated_at"]),
    "notes": ("notes", "user_id", ["id", "title", "body", "noted_at", "latitude", "longitude", "attachable_id", "attachable_type", "created_at", "updated_at"]),
    "posters": ("posters", "user_id", ["id", "name", "status", "created_at", "updated_at"]),
    "shared-links": ("shared_links", "user_id", ["id", "name", "resource_id", "resource_type", "expires_at", "revoked_at", "last_accessed_at", "view_count", "created_at", "updated_at"]),
}


def project_dawarich(socket):
    subject = REQUEST["subjectLocator"]["value"]
    schema_fingerprint, relations = validate_dawarich_schema(socket)
    require(socket, "users", ["id", "provider", "uid", "email", "settings", "created_at", "updated_at"])
    ids = json.loads(psql(socket, f"SELECT COALESCE(json_agg(id),'[]'::json) FROM users WHERE provider='openid_connect' AND uid={literal(subject)};") or b"[]")
    if len(ids) != 1 or not isinstance(ids[0], int):
        fail("unsupported_schema")
    user_id = str(ids[0])
    entries, warnings = [], []
    account_fields = ["id", "uid", "provider", "email", "first_name", "last_name", "created_at", "updated_at", "active_until", "plan", "status", "theme"]
    account_projection = projection(
        "u",
        account_fields,
        [("redactionCodes", "jsonb_build_array('dawarich-authentication-secrets-redacted')")],
    )
    entries.append(query_descriptor(socket, "dawarich/account.json", f"SELECT {account_projection} FROM users u WHERE u.id={user_id}", False, ["dawarich-authentication-secrets-redacted"]))
    safe_settings = ["fog_of_war_meters", "fog_of_war_threshold", "fog_of_war_mode", "meters_between_routes", "preferred_map_layer", "speed_colored_routes", "points_rendering_mode", "minutes_between_routes", "time_threshold_minutes", "merge_threshold_minutes", "live_map_enabled", "route_opacity", "route_color", "track_color", "maps", "visits_suggestions_enabled", "enabled_map_layers", "maps_maplibre_style", "maps_maplibre_custom_theme", "globe_projection", "transportation_thresholds", "transportation_expert_thresholds", "transportation_expert_mode", "min_minutes_spent_in_city", "max_gap_minutes_in_city", "gps_filtering_enabled", "gps_accuracy_threshold", "timezone", "visit_radius_meters", "visit_min_points", "visit_min_duration_minutes", "visit_density_fill_enabled", "stay_max_gap_minutes", "point_dragging_enabled", "news_emails_enabled", "show_supporter_badge"]
    allow = "ARRAY[" + ",".join(literal(value) for value in safe_settings) + "]::text[]"
    settings = f"SELECT jsonb_build_object('values',COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(u.settings) WHERE key=ANY({allow})),'{{}}'::jsonb),'redactedKeys',COALESCE((SELECT jsonb_agg(key ORDER BY key) FROM jsonb_each(u.settings) WHERE NOT key=ANY({allow})),'[]'::jsonb),'redactionCodes',jsonb_build_array('dawarich-settings-secrets-redacted')) FROM users u WHERE u.id={user_id}"
    entries.append(query_descriptor(socket, "dawarich/settings.json", settings, False, ["dawarich-settings-secrets-redacted"]))
    for entry_id, (table, owner, fields) in DAWARICH.items():
        require(socket, table, ["id", owner, "created_at", "updated_at"])
        extras = []
        if entry_id == "trips":
            extras.append(("path", "CASE WHEN t.path IS NULL THEN NULL ELSE ST_AsGeoJSON(t.path)::jsonb->'coordinates' END"))
        elif entry_id == "tracks":
            extras.append(("original_path", "ST_AsGeoJSON(t.original_path)::jsonb->'coordinates'"))
        elif entry_id == "notes":
            extras.extend([
                ("latitude", "CASE WHEN t.lonlat IS NULL THEN NULL ELSE ST_Y(t.lonlat::geometry) END"),
                ("longitude", "CASE WHEN t.lonlat IS NULL THEN NULL ELSE ST_X(t.lonlat::geometry) END"),
            ])
        select = f"SELECT {projection('t', fields, extras)} FROM {table} t WHERE t.{owner}={user_id} AND t.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY t.id"
        entries.append(query_descriptor(socket, f"dawarich/{entry_id}.jsonl", select, entry_id in {"places", "imports", "raw-archives", "flights", "notes"}, ["dawarich-rights-of-others-review"] if entry_id == "notes" else []))
    require(socket, "taggings", ["id", "tag_id", "taggable_id", "taggable_type", "created_at", "updated_at"])
    tagging_fields = ["id", "tag_id", "taggable_id", "taggable_type", "created_at", "updated_at"]
    taggings = f"SELECT {projection('t', tagging_fields)} FROM taggings t WHERE (t.tag_id IN (SELECT id FROM tags WHERE user_id={user_id}) OR (t.taggable_type='Place' AND t.taggable_id IN (SELECT id FROM places WHERE user_id={user_id}))) AND t.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY t.id"
    entries.append(query_descriptor(socket, "dawarich/taggings.jsonl", taggings))
    segment_fields = ["id", "track_id", "start_index", "end_index", "distance", "duration", "avg_speed", "max_speed", "confidence", "corrected_at", "source", "transportation_mode", "created_at", "updated_at"]
    require(socket, "track_segments", ["id", "track_id", "created_at", "updated_at"])
    entries.append(query_descriptor(socket, "dawarich/track-segments.jsonl", f"SELECT {projection('s', segment_fields)} FROM track_segments s WHERE s.track_id IN (SELECT id FROM tracks WHERE user_id={user_id}) AND s.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY s.id"))
    require(socket, "points", ["id", "user_id", "timestamp", "lonlat", "created_at", "updated_at"])
    months = json.loads(psql(socket, f"SELECT COALESCE(json_agg(point_month ORDER BY point_month),'[]'::json) FROM (SELECT DISTINCT to_char(to_timestamp(timestamp) AT TIME ZONE 'UTC','YYYY-MM') AS point_month FROM points WHERE user_id={user_id} AND timestamp<=EXTRACT(EPOCH FROM {literal(REQUEST['cutoff'])}::timestamptz)) q;") or b"[]")
    point_fields = ["id", "lon", "lat", "altitude", "altitude_decimal", "accuracy", "battery", "battery_status", "city", "connection", "country", "country_name", "course", "course_accuracy", "external_track_id", "geodata", "mode", "motion_data", "recorded_at", "timestamp", "tracker_id", "trigger", "velocity", "vertical_accuracy", "visit_id", "track_id", "import_id", "anomaly", "reverse_geocoded_at", "created_at", "updated_at"]
    for month in months:
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
            fail("unsupported_schema")
        start = f"{month}-01T00:00:00Z"
        point_extras = [
            ("lon", "ST_X(p.lonlat::geometry)"),
            ("lat", "ST_Y(p.lonlat::geometry)"),
            ("altitude", "COALESCE(p.altitude_decimal, p.altitude)"),
            ("recorded_at", "to_timestamp(p.timestamp)"),
        ]
        select = f"SELECT {projection('p', point_fields, point_extras)} FROM points p WHERE p.user_id={user_id} AND to_timestamp(p.timestamp)>={literal(start)}::timestamptz AND to_timestamp(p.timestamp)<({literal(start)}::timestamptz+interval '1 month') AND p.timestamp<=EXTRACT(EPOCH FROM {literal(REQUEST['cutoff'])}::timestamptz) ORDER BY p.id"
        entries.append(query_descriptor(socket, f"dawarich/points/{month[:4]}/{month[5:]}.jsonl", select, True))
    if columns(socket, "action_text_rich_texts"):
        rich = f"SELECT jsonb_build_object('id',r.id,'name',r.name,'record_type',r.record_type,'record_id',r.record_id,'bodyText',regexp_replace(regexp_replace(r.body::text,'<[^>]*>',' ','g'),'\\s+',' ','g'),'created_at',r.created_at,'updated_at',r.updated_at,'redactionCodes',jsonb_build_array('dawarich-rich-text-markup-stripped')) FROM action_text_rich_texts r WHERE r.record_type='Trip' AND r.record_id IN (SELECT id FROM trips WHERE user_id={user_id}) AND r.created_at<={literal(REQUEST['cutoff'])}::timestamptz ORDER BY r.id"
        entries.append(query_descriptor(socket, "dawarich/rich-text.jsonl", rich, False, ["dawarich-rich-text-markup-stripped"]))
    else:
        warnings.append("dawarich-rich-text-missing")
    entries.append(family_descriptor(socket, user_id))
    return entries, warnings, {"schemaFingerprint": schema_fingerprint, "schemaRelations": relations, "userId": user_id}


def family_descriptor(socket, user_id):
    for table, required in [("families", ["id", "creator_id", "name", "created_at", "updated_at"]), ("family_memberships", ["id", "family_id", "user_id", "role", "created_at", "updated_at"]), ("family_invitations", ["id", "family_id", "invited_by_id", "status", "expires_at", "created_at", "updated_at"]), ("family_location_requests", ["id", "family_id", "requester_id", "target_user_id", "status", "expires_at", "created_at", "updated_at"])]:
        require(socket, table, required)
    family_ids = f"SELECT family_id FROM family_memberships WHERE user_id={user_id} UNION SELECT id FROM families WHERE creator_id={user_id}"
    membership_role = "CASE m.role WHEN 0 THEN 'owner' WHEN 1 THEN 'member' ELSE NULL END"
    select = f"SELECT row FROM (SELECT jsonb_build_object('kind','family','name',f.name,'role',CASE WHEN f.creator_id={user_id} THEN 'creator' ELSE {membership_role} END,'createdAt',f.created_at,'updatedAt',f.updated_at) row,f.id::text sort_id FROM families f LEFT JOIN family_memberships m ON m.family_id=f.id AND m.user_id={user_id} WHERE f.id IN ({family_ids}) UNION ALL SELECT jsonb_build_object('kind','membership','role',{membership_role},'createdAt',m.created_at,'updatedAt',m.updated_at) row,m.id::text sort_id FROM family_memberships m WHERE m.user_id={user_id} UNION ALL SELECT jsonb_build_object('kind','invitation','status',i.status,'expiresAt',i.expires_at,'invitedBySubject',i.invited_by_id={user_id},'redactionCodes',jsonb_build_array('dawarich-family-other-member-redacted')) row,i.id::text sort_id FROM family_invitations i WHERE i.family_id IN ({family_ids}) OR i.invited_by_id={user_id} UNION ALL SELECT jsonb_build_object('kind','location-request','role',CASE WHEN r.requester_id={user_id} THEN 'requester' ELSE 'target' END,'status',r.status,'expiresAt',r.expires_at,'redactionCodes',jsonb_build_array('dawarich-family-other-member-redacted')) row,r.id::text sort_id FROM family_location_requests r WHERE r.family_id IN ({family_ids}) OR r.requester_id={user_id} OR r.target_user_id={user_id}) q ORDER BY row->>'kind',sort_id"
    return query_descriptor(socket, "dawarich/family.jsonl", select, False, ["dawarich-family-other-member-redacted"])


def safe_member_name(name):
    value = name.removeprefix("./")
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("unsupported_schema")
    return value


def visit_storage(source, key, consume):
    target = key.strip("/")
    if not target or ".." in PurePosixPath(target).parts:
        fail("unsupported_schema")
    found = False
    count = total = 0
    with tarfile.open(source["path"], "r|gz") as archive:
        for member in archive:
            count += 1
            if count > 100_000 or member.size < 0:
                fail("limit_exceeded")
            if member.isdir() and member.name in {".", "./"}:
                continue
            name = safe_member_name(member.name)
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                fail("unsupported_schema")
            if member.isfile():
                total += member.size
                if total > MAX_TOTAL:
                    fail("limit_exceeded")
            if name == target:
                if found or not member.isfile() or member.size > MAX_ENTRY:
                    fail("unsupported_schema")
                stream = archive.extractfile(member)
                if stream is None:
                    fail("collector_failed")
                consume(stream, member.size)
                found = True
    return found


def attachment_entries(socket, storage, user_id):
    if not columns(socket, "active_storage_attachments") or not columns(socket, "active_storage_blobs"):
        return [], ["dawarich-attachments-schema-missing"]
    if not columns(socket, "pending_imports"):
        pending_clause = "FALSE"
    else:
        pending_clause = f"a.record_type='PendingImport' AND a.record_id IN (SELECT id FROM pending_imports WHERE claimed_by_user_id={user_id})"
    select = f"SELECT COALESCE(json_agg(row ORDER BY id),'[]'::json) FROM (SELECT a.id,a.record_type,a.record_id,a.name,b.id blob_id,b.key,b.filename,b.content_type,b.byte_size FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE ((a.record_type='Import' AND a.record_id IN (SELECT id FROM imports WHERE user_id={user_id})) OR ({pending_clause}) OR (a.record_type='Points::RawDataArchive' AND a.record_id IN (SELECT id FROM points_raw_data_archives WHERE user_id={user_id}))) AND a.created_at<={literal(REQUEST['cutoff'])}::timestamptz LIMIT 65) row;"
    rows = json.loads(psql(socket, select) or b"[]")
    if len(rows) > 64:
        fail("limit_exceeded")
    metadata, binaries, warnings = [], [], []
    for row in rows:
        kind = "raw" if row["record_type"] == "Points::RawDataArchive" else "import"
        filename = str(row.get("filename") or "")
        extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
        if extension not in SAFE_EXTENSIONS:
            extension = "bin"
        opaque = hashlib.sha256(f"openmapx/dawarich/attachment/v1\0{kind}\0{row['id']}\0{row['blob_id']}".encode()).hexdigest()
        output_path = f"dawarich/{'raw-files' if kind == 'raw' else 'import-files'}/{opaque}.{extension}"
        key = str(row["key"])
        storage_path = f"{key[:2]}/{key[2:4]}/{key}"
        measured = {}
        if storage:
            def measure(stream, declared):
                digest = hashlib.sha256()
                size = 0
                while chunk := stream.read(64 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
                if size != declared or size != int(row["byte_size"]):
                    fail("backup_digest_changed")
                measured.update(size=size, digest=digest.hexdigest())
            found = visit_storage(storage, storage_path, measure)
        else:
            found = False
        if found:
            def opener(source=storage, path=storage_path):
                temporary = tempfile.TemporaryFile("w+b", dir="/scratch")
                def copy(stream, _declared):
                    shutil.copyfileobj(stream, temporary, 64 * 1024)
                    temporary.seek(0)
                if not visit_storage(source, path, copy):
                    fail("backup_digest_changed")
                return temporary
            binaries.append({"path": output_path, "bytes": measured["size"], "sha256": measured["digest"], "records": None, "article15": True, "portability": True, "redactionCodes": [], "open": opener})
            file_id = dawarich_id(output_path)
        else:
            warnings.append("dawarich-attachment-bytes-missing")
            file_id = None
        metadata.append({"id": row["id"], "recordType": row["record_type"], "recordIdDigest": hashlib.sha256(f"openmapx/dawarich/record/v1\0{row['record_type']}\0{row['record_id']}".encode()).hexdigest(), "name": row["name"], "filename": filename, "contentType": row.get("content_type"), "bytes": row["byte_size"], "fileEntryId": file_id, "portable": bool(file_id), "redactionCodes": [] if file_id else ["dawarich-attachment-storage-missing"]})
    content = b"".join((json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n").encode() for row in metadata)
    return [static_descriptor("dawarich/attachments.jsonl", content, len(metadata), bool(binaries), ["dawarich-attachment-storage-missing"] if warnings else []), *binaries], sorted(set(warnings))


def restore(source, data, socket, storage):
    socket.mkdir(mode=0o700)
    if command(["initdb", "-D", str(data), "--auth=trust", "--no-locale", "--encoding=UTF8"]).returncode:
        fail("collector_failed")
    if subprocess.run(["pg_ctl", "-D", str(data), "-o", f"-k {socket} -h ''", "-w", "start"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode:
        fail("collector_failed")
    try:
        child = subprocess.Popen(["psql", "-h", str(socket), "-d", "postgres", "-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with gzip.open(source["path"], "rb") as dump:
            while chunk := dump.read(1024 * 1024):
                child.stdin.write(chunk)
        child.stdin.close()
        if child.wait():
            fail("unsupported_schema")
        if source["schemaContract"] == "openmapx-v1":
            return project_openmapx(socket)
        entries, warnings, schema = project_dawarich(socket)
        attachments, attachment_warnings = attachment_entries(socket, storage, schema["userId"])
        entries.extend(attachments)
        warnings.extend(attachment_warnings)
        return entries, warnings, schema
    except BaseException:
        subprocess.run(["pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        raise


def dawarich_id(path):
    fixed = {name: name.removesuffix(".jsonl").removesuffix(".json") for name in ["account.json", "settings.json", "areas.jsonl", "places.jsonl", "tags.jsonl", "taggings.jsonl", "imports.jsonl", "trips.jsonl", "notifications.jsonl", "visits.jsonl", "stats.jsonl", "tracks.jsonl", "digests.jsonl", "flights.jsonl", "notes.jsonl", "posters.jsonl", "attachments.jsonl", "rich-text.jsonl", "family.jsonl"]}
    fixed.update({"export-records.jsonl": "export-records", "track-segments.jsonl": "track-segments", "raw-archives.jsonl": "raw-archives", "shared-links.jsonl": "shared-links"})
    relative = path.removeprefix("dawarich/")
    if relative in fixed:
        return fixed[relative]
    match = re.fullmatch(r"points/(\d{4})/(0[1-9]|1[0-2])\.jsonl", relative)
    if match:
        return f"points-{match.group(1)}-{match.group(2)}"
    match = re.fullmatch(r"(import|raw)-files/([a-f0-9]{64})\.([a-z0-9]{1,16})", relative)
    if match:
        return f"{match.group(1)}-file-{match.group(2)}.{match.group(3)}"
    fail("unsupported_schema")


def emit(entries, warnings, schema, backup_manifest):
    dawarich_entries = [entry for entry in entries if entry["path"].startswith("dawarich/")]
    if dawarich_entries:
        inner_entries = []
        for entry in dawarich_entries:
            inner_entries.append({"id": dawarich_id(entry["path"]), **{key: entry[key] for key in ("bytes", "sha256", "records", "article15", "portability", "redactionCodes")}})
        inner = {"version": 1, "image": DAWARICH_IMAGE, "imageDigest": DAWARICH_IMAGE_DIGEST, "upstreamCommit": DAWARICH_COMMIT, "collectorContract": "openmapx-subject-export-v1", "subjectUserIdDigest": hashlib.sha256(REQUEST["subjectLocator"]["value"].encode()).hexdigest(), "cutoff": REQUEST["cutoff"], "snapshotAt": backup_manifest["createdAt"], "schemaFingerprint": schema["schemaFingerprint"], "schemaRelations": schema["schemaRelations"], "entries": inner_entries, "warnings": sorted(set(code for code in warnings if code.startswith("dawarich-")))}
        entries.append(static_descriptor("dawarich/source-manifest.json", json.dumps(inner, separators=(",", ":")).encode()))
    if len(entries) > MAX_ENTRIES or sum(entry["bytes"] for entry in entries) > MAX_TOTAL:
        fail("limit_exceeded")
    outer_entries = []
    for entry in entries:
        outer_entries.append({"path": entry["path"], "family": entry["path"].split("/", 1)[0], **{key: entry[key] for key in ("bytes", "sha256", "records", "article15", "portability", "redactionCodes")}})
    outer = {"version": 1, "collectorContract": "openmapx-subject-export-v1", "cutoff": REQUEST["cutoff"], "subjectUserIdDigest": hashlib.sha256(REQUEST["subjectLocator"]["value"].encode()).hexdigest(), "entries": outer_entries, "warnings": sorted(set(warnings))}
    entries.append(static_descriptor("backup/source-manifest.json", json.dumps(outer, separators=(",", ":")).encode()))
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for entry in entries:
            info = tarfile.TarInfo(entry["path"])
            info.size = entry["bytes"]
            info.mode = 0o400
            info.mtime = 0
            source = entry["open"]()
            try:
                archive.addfile(info, source)
            finally:
                source.close()


REQUEST = read_request()
SOURCES, BACKUP_MANIFEST = verified_sources(REQUEST)
WORK = Path(tempfile.mkdtemp(prefix="restore-", dir="/scratch"))
try:
    OUTPUT, WARNINGS, DAWARICH_SCHEMA = [], [], None
    ACTIVE_DATABASES = []
    STORAGE = next((source for source in SOURCES if source["schemaContract"] == "dawarich-storage-1.10.3"), None)
    databases = [source for source in SOURCES if source["schemaContract"] != "dawarich-storage-1.10.3"]
    for index, source in enumerate(databases):
        data = WORK / f"pg-{index}"
        socket = WORK / f"socket-{index}"
        projected, source_warnings, schema = restore(source, data, socket, STORAGE)
        ACTIVE_DATABASES.append(data)
        OUTPUT.extend(projected)
        WARNINGS.extend(source_warnings)
        DAWARICH_SCHEMA = schema or DAWARICH_SCHEMA
    emit(OUTPUT, WARNINGS, DAWARICH_SCHEMA, BACKUP_MANIFEST)
finally:
    for data in locals().get("ACTIVE_DATABASES", []):
        subprocess.run(["pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    shutil.rmtree(WORK, ignore_errors=True)
