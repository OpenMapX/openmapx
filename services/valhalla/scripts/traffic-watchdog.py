#!/usr/bin/env python3
"""Engine-owned lease fence. No ingestion, network or source normalization."""
import contextlib
import datetime
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit


MAX_JOURNAL_BYTES = 64 * 1024 * 1024
MAX_EVIDENCE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
# The data-manager writer's TRAFFIC_LEASE_MAX_MS: a lease must outlast its
# two-minute write cadence, and none may claim more.
MAX_LEASE_MS = 300_000
MAX_PROOF_MS = 120_000
DEFAULT_BACKEND_TIMEOUT = 45
DEFAULT_CLIENT_TIMEOUT = 10
DEFAULT_MAX_CONCURRENCY = 32
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAINTENANCE_FENCE = ".traffic-maintenance.json"
GENERATIONS_MANIFEST = "traffic-generations.json"
# A manifest withdrawn at an uncoordinated start, until the served tiles are hashed.
UNVERIFIED_GENERATIONS = "traffic-generations.unverified.json"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = path.parent.stat()
    fd, temporary = tempfile.mkstemp(prefix=".traffic-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, separators=(",", ":"))
            output.flush()
            if os.geteuid() == 0:
                os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def fsync_directory(path):
    directory = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def clear_offline(path):
    """Clears every live record in place, bounds-checked first; never replaces the tar.

    Called before this process launches an engine, and while it serves to clear
    a lapsed lease (see ``clear_expired``): Valhalla maps the tar, so records
    written in place reach it at once, as every data-manager write does.
    """
    path = Path(path)
    if not path.exists():
        return
    with path.open("r+b", buffering=0) as traffic:
        size = os.fstat(traffic.fileno()).st_size
        header = traffic.read(512)
        if len(header) != 512 or header[:100].split(b"\0", 1)[0] != b"index.bin":
            raise ValueError("Invalid traffic tar index")
        index_size = int(header[124:136].rstrip(b"\0 ") or b"0", 8)
        if (
            index_size <= 0
            or index_size % 16
            or index_size > MAX_JOURNAL_BYTES
            or 512 + index_size > size
        ):
            raise ValueError("Invalid traffic index bounds")
        index = traffic.read(index_size)
        minimum = 1024 + ((index_size + 511) // 512) * 512
        spans = []
        identities = set()
        for offset, tile_id, member_size in struct.iter_unpack("<QII", index):
            if (
                offset < minimum
                or offset % 512
                or member_size < 32
                or (member_size - 32) % 8
                or offset + member_size > size
                or tile_id in identities
            ):
                raise ValueError("Invalid traffic tile bounds")
            traffic.seek(offset)
            tile = traffic.read(32)
            actual_id, _, count, version, _, _ = struct.unpack("<QQIIII", tile)
            if actual_id != tile_id or count != (member_size - 32) // 8 or version != 3:
                raise ValueError("Invalid traffic tile header")
            identities.add(tile_id)
            spans.append((offset, offset + member_size))
        spans.sort()
        if any(spans[i][0] < spans[i - 1][1] for i in range(1, len(spans))):
            raise ValueError("Overlapping traffic tiles")
        # Validate ALL bounds before the first mutation. Preserve untouched no-data records.
        cleared = struct.pack("<Q", 127 | (127 << 7))
        for start, end in spans:
            for offset in range(start + 32, end, 1024 * 1024):
                traffic.seek(offset)
                block = bytearray(traffic.read(min(1024 * 1024, end - offset)))
                changed = False
                for index, (current,) in enumerate(struct.iter_unpack("<Q", block)):
                    if (current >> 28) & 255:
                        block[index * 8 : index * 8 + 8] = cleared
                        changed = True
                if changed:
                    traffic.seek(offset)
                    traffic.write(block)
        os.fsync(traffic.fileno())


def lease_allows_serving(path, now_ms=None):
    return lease_state(path, now_ms) == "serve"


def lease_state(path, now_ms=None):
    """``serve`` while the journal's lease holds; ``expired`` when a well-formed
    journal's lease has lapsed (a clear of every record resolves it); ``invalid``
    for a missing, unreadable, malformed or impossible journal."""
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    try:
        with open(path, "rb") as source:
            raw = source.read(MAX_JOURNAL_BYTES + 1)
        if len(raw) > MAX_JOURNAL_BYTES:
            return False
        journal = json.loads(raw)
        deadline = journal["validUntil"]
        identities = journal["identities"]
        phase = journal.get("phase")
        uncertain = journal.get("uncertain", False)
        if (
            journal.get("schemaVersion") != 1
            or phase not in ("pending", "committed")
            or not isinstance(deadline, (int, float))
            or isinstance(deadline, bool)
            or not isinstance(identities, list)
            or not journal.get("graphGeneration")
            or not isinstance(uncertain, bool)
        ):
            return "invalid"
        if not (0 <= deadline <= now_ms + MAX_LEASE_MS):
            return "invalid"
        if phase == "pending":
            # An uncertain pending journal is the writer clearing every record
            # it cannot account for, after each engine start or graph change.
            # Its deadline bounds that write like any other; only an abandoned
            # one fences serving.
            return "serve" if deadline > now_ms else "expired"
        if uncertain:
            return "expired"
        return "serve" if not identities or deadline > now_ms else "expired"
    except (OSError, ValueError, TypeError, KeyError):
        return "invalid"


def clear_expired(graph_dir, state_path, journal_path, now_ms=None):
    """Clears a lapsed lease's records in place while the engine serves.

    A lease lapses whenever its writer is away longer than it lasts: a restart,
    a crash, a stalled cycle. Its records must stop applying; the engine need
    not stop. Under the writer lock, a lease renewed meanwhile is left alone;
    otherwise every record is cleared, bounds-checked first, and the state and
    journal say nothing is written. Returns ``renewed``, ``cleared``, or
    ``invalid`` for a journal a clear does not resolve (missing, malformed,
    impossible), which fences serving.
    """
    graph_dir = Path(graph_dir)
    with writer_lock(state_path):
        state = lease_state(journal_path, now_ms)
        if state == "serve":
            return "renewed"
        if state == "invalid":
            return "invalid"
        clear_offline(graph_dir / "traffic.tar")
        atomic_json(state_path, [])
        atomic_json(
            journal_path,
            {
                "schemaVersion": 1,
                "graphGeneration": "lease-expiry-clear",
                "phase": "committed",
                "validUntil": int(time.time() * 1000) + 120_000,
                "identities": [],
            },
        )
    return "cleared"


def read_json(path, maximum=MAX_EVIDENCE_BYTES):
    with open(path, "rb") as source:
        raw = source.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("JSON evidence exceeds limit")
    return json.loads(raw)


def graph_metadata_snapshot(graph_dir):
    graph_dir = Path(graph_dir)
    maintenance = graph_dir / MAINTENANCE_FENCE
    try:
        maintenance.stat()
        return None
    except FileNotFoundError:
        pass
    except OSError:
        return None
    try:
        generations_path = graph_dir / GENERATIONS_MANIFEST
        engine_path = graph_dir / "traffic-engine.json"
        with generations_path.open("rb") as source:
            generations_raw = source.read(MAX_EVIDENCE_BYTES + 1)
        with engine_path.open("rb") as source:
            engine_raw = source.read(MAX_EVIDENCE_BYTES + 1)
        if (
            len(generations_raw) > MAX_EVIDENCE_BYTES
            or len(engine_raw) > MAX_EVIDENCE_BYTES
        ):
            return None
        generations = json.loads(generations_raw)
        engine = json.loads(engine_raw)
        if not isinstance(engine, dict):
            return None
        generation = valid_generations(generations)
        if (
            generation is None
            or engine.get("schemaVersion") != 1
            or not valid_uuid(engine.get("bootId"))
        ):
            return None
        try:
            maintenance.stat()
            return None
        except FileNotFoundError:
            pass
        except OSError:
            return None
        return {
            "generation": generation,
            "engineBootId": engine["bootId"],
            "generationsDigest": hashlib.sha256(generations_raw).hexdigest(),
            "engineDigest": hashlib.sha256(engine_raw).hexdigest(),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def valid_generations(generations):
    """The graph generation a coherent maintenance manifest names, else None."""
    if not isinstance(generations, dict):
        return None
    generation = generations.get("graphGeneration")
    completed_at = generations.get("completedAt")
    if (
        generations.get("schemaVersion") != 1
        or not isinstance(generation, str)
        or SHA256_PATTERN.fullmatch(generation) is None
        or generations.get("extractGeneration") != generation
        or generations.get("waysToEdgesGeneration") != generation
        or not isinstance(completed_at, str)
        or not completed_at.endswith(("Z", "z"))
        or datetime.datetime.fromisoformat(completed_at[:-1] + "+00:00").tzinfo
        is None
    ):
        return None
    return generation


def tile_generation(tile_dir):
    """The graph generation the maintenance authority computes, recomputed here.

    That authority runs ``find <tile_dir> -type f ! -name way_edges.txt -print0
    | sort -z | xargs -0 sha256sum | sha256sum``: one ``sha256sum`` line per
    regular file, in byte order of its path, hashed again. A path ``sha256sum``
    would escape, or an empty directory, has no comparable generation.
    """
    root = os.fspath(tile_dir)
    paths = []
    for directory, _directories, files in os.walk(root):
        for name in files:
            path = os.path.join(directory, name)
            if name != "way_edges.txt" and stat.S_ISREG(os.lstat(path).st_mode):
                paths.append(os.fsencode(path))
    if not paths:
        raise ValueError("No graph tiles to hash")
    listing = hashlib.sha256()
    for path in sorted(paths):
        if any(character in path for character in (b"\\", b"\n", b"\r")):
            raise ValueError("Tile path cannot be compared")
        digest = hashlib.sha256()
        with open(path, "rb") as tile:
            while block := tile.read(1024 * 1024):
                digest.update(block)
        listing.update(digest.hexdigest().encode() + b"  " + path + b"\n")
    return listing.hexdigest()


def set_aside_generations(graph_dir):
    """Withdraws the graph manifest before an uncoordinated engine start.

    The scripted image may rebuild base tiles on such a start, so the manifest
    attests nothing until ``reattest_generations`` has hashed what the engine
    then serves. Returns whether a manifest awaits that check, including one an
    interrupted earlier start left behind.
    """
    graph_dir = Path(graph_dir)
    manifest = graph_dir / GENERATIONS_MANIFEST
    unverified = graph_dir / UNVERIFIED_GENERATIONS
    if manifest.exists():
        os.replace(manifest, unverified)
        fsync_directory(graph_dir)
    return unverified.exists()


def reattest_generations(graph_dir, serving, alive, poll_seconds=2):
    """Restores the withdrawn manifest once the started engine serves its tiles.

    The base build, when the image runs one, finishes before the engine serves.
    If the tiles still hash to the withdrawn generation, the graph, extract and
    way map it names are the ones being served and the manifest is restored;
    otherwise it is dropped, and the data-manager's extract guard rebuilds and
    attests them through coordinated maintenance.
    """
    graph_dir = Path(graph_dir)
    unverified = graph_dir / UNVERIFIED_GENERATIONS
    while not serving():
        if not alive():
            return "stopped"
        time.sleep(poll_seconds)
    try:
        expected = valid_generations(read_json(unverified))
        if expected is None:
            outcome = "invalid"
        elif tile_generation(graph_dir / "valhalla_tiles") != expected:
            outcome = "changed"
        else:
            outcome = "restored"
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        outcome = "unverifiable"
    if not alive() or (graph_dir / MAINTENANCE_FENCE).exists():
        # Maintenance stops the engine before replacing the graph and writes
        # its own manifest; the next start settles the withdrawn one.
        return "stopped"
    if outcome == "restored" and not (graph_dir / GENERATIONS_MANIFEST).exists():
        os.replace(unverified, graph_dir / GENERATIONS_MANIFEST)
    else:
        unverified.unlink(missing_ok=True)
        if outcome == "restored":
            outcome = "superseded"
    fsync_directory(graph_dir)
    return outcome


def backend_serving(address):
    try:
        connection = http.client.HTTPConnection(*address, timeout=2)
        try:
            connection.request("GET", "/status")
            return connection.getresponse().status == 200
        finally:
            connection.close()
    except (OSError, http.client.HTTPException):
        return False


def valid_uuid(value):
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def iso_timestamp(milliseconds):
    return (
        datetime.datetime.fromtimestamp(milliseconds / 1000, datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def proof_journal(path, now_ms):
    try:
        value = read_json(path, MAX_JOURNAL_BYTES)
        if not isinstance(value, dict):
            return None
        deadline = value.get("validUntil")
        if (
            value.get("schemaVersion") != 1
            or value.get("phase") != "committed"
            or value.get("uncertain") is not False
            or not valid_uuid(value.get("writeId"))
            or not valid_uuid(value.get("engineBootId"))
            or not isinstance(value.get("routingGraphGeneration"), str)
            or SHA256_PATTERN.fullmatch(value["routingGraphGeneration"]) is None
            or not isinstance(deadline, (int, float))
            or isinstance(deadline, bool)
            or not now_ms < deadline <= now_ms + MAX_LEASE_MS
        ):
            return None
        return value
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def eligible_request(path, body):
    parsed = urlsplit(path)
    if (
        not path.startswith("/")
        or path.startswith("//")
        or parsed.scheme
        or parsed.netloc
        or parsed.path not in ("/route", "/optimized_route")
    ):
        return body, None
    endpoint = parsed.path[1:]
    try:
        request = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body, None
    if not isinstance(request, dict):
        return body, None
    request_id = request.pop("openmapx_request_id", None)
    forwarded = json.dumps(request, separators=(",", ":")).encode()
    costing = request.get("costing")
    date_time = request.get("date_time")
    costing_options = request.get("costing_options")
    options = (
        costing_options.get(costing)
        if isinstance(costing_options, dict) and isinstance(costing, str)
        else None
    )
    speed_types = options.get("speed_types") if isinstance(options, dict) else None
    if (
        not valid_uuid(request_id)
        or costing not in ("auto", "motorcycle")
        or not isinstance(date_time, dict)
        or date_time.get("type") != 0
        or isinstance(date_time.get("type"), bool)
        or not isinstance(speed_types, list)
        or "current" not in speed_types
        or options.get("ignore_closures") is True
    ):
        return forwarded, None
    return forwarded, {
        "requestId": request_id,
        "endpoint": endpoint,
        "costing": costing,
    }


def sanitized_response(body, proof=None):
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body
    if not isinstance(value, dict):
        return body
    value.pop("openmapx_traffic_proof", None)
    if proof is not None:
        value["openmapx_traffic_proof"] = proof
    return json.dumps(value, separators=(",", ":")).encode()


def proof_for_request(
    eligibility, before, after, graph_before, graph_after, child_alive, now_ms
):
    if (
        eligibility is None
        or before is None
        or after is None
        or graph_before is None
        or graph_after is None
        or graph_before != graph_after
        or not child_alive()
    ):
        return None
    identity = ("writeId", "routingGraphGeneration", "engineBootId")
    if any(before.get(key) != after.get(key) for key in identity):
        return None
    if graph_after["engineBootId"] != after["engineBootId"]:
        return None
    deadline = min(before["validUntil"], after["validUntil"])
    if not now_ms < deadline <= now_ms + MAX_LEASE_MS:
        return None
    # The engine serves a write until its lease ends; one route answer claims
    # at most two minutes of it.
    deadline = min(deadline, now_ms + MAX_PROOF_MS)
    return {
        "schemaVersion": 1,
        "requestId": eligibility["requestId"],
        "writeId": after["writeId"],
        "graphGeneration": after["routingGraphGeneration"],
        "engineBootId": after["engineBootId"],
        "validUntil": iso_timestamp(deadline),
        "evaluatedAt": iso_timestamp(now_ms),
        "endpoint": eligibility["endpoint"],
        "costing": eligibility["costing"],
    }


class ProofProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def send_json_error(self, status, code):
        body = json.dumps({"error": code}, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def forward(self):
        self._forward_bounded()

    def _forward_bounded(self):
        parsed = urlsplit(self.path)
        if (
            not self.path.startswith("/")
            or parsed.scheme
            or parsed.netloc
            or self.headers.get("transfer-encoding")
        ):
            self.send_json_error(400, "invalid_proxy_request")
            return
        content_lengths = self.headers.get_all("content-length", [])
        if len(content_lengths) > 1:
            self.send_json_error(400, "invalid_content_length")
            return
        raw_length = content_lengths[0] if content_lengths else None
        try:
            length = int(raw_length or "0")
        except ValueError:
            self.send_json_error(400, "invalid_content_length")
            return
        if length < 0:
            self.send_json_error(400, "invalid_content_length")
            return
        if length > MAX_REQUEST_BYTES:
            self.send_json_error(413, "routing_request_too_large")
            return
        try:
            body = self.rfile.read(length)
        except socket.timeout:
            self.send_json_error(408, "routing_client_timeout")
            return
        if len(body) != length:
            self.send_json_error(400, "truncated_proxy_request")
            return
        forwarded_body, eligibility = (
            eligible_request(self.path, body)
            if self.command == "POST"
            else (body, None)
        )
        if eligibility:
            graph_before = graph_metadata_snapshot(self.server.graph_dir)
            before = proof_journal(self.server.journal_path, int(time.time() * 1000))
        else:
            graph_before = None
            before = None
        request_connection_headers = {
            token.strip().lower()
            for value in self.headers.get_all("connection", [])
            for token in value.split(",")
            if token.strip()
        }
        request_headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower()
            not in HOP_BY_HOP_HEADERS
            | request_connection_headers
            | {"host", "content-length", "accept-encoding"}
        }
        request_headers["accept-encoding"] = "identity"
        request_headers["content-length"] = str(len(forwarded_body))
        connection = http.client.HTTPConnection(
            *self.server.backend_address, timeout=self.server.backend_timeout
        )
        try:
            connection.request(
                self.command, self.path, body=forwarded_body, headers=request_headers
            )
            response = connection.getresponse()
            response_body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_RESPONSE_BYTES:
                self.send_json_error(502, "routing_backend_response_too_large")
                return
            if response.getheader("content-encoding") not in (None, "identity"):
                self.send_json_error(502, "routing_backend_encoding_unsupported")
                return
            now_ms = int(time.time() * 1000)
            if eligibility:
                after = proof_journal(self.server.journal_path, now_ms)
                graph_after = graph_metadata_snapshot(self.server.graph_dir)
            else:
                after = None
                graph_after = None
            proof = None
            if 200 <= response.status < 300:
                proof = proof_for_request(
                    eligibility,
                    before,
                    after,
                    graph_before,
                    graph_after,
                    self.server.child_alive,
                    now_ms,
                )
            response_body = sanitized_response(response_body, proof)
            self.send_response(response.status, response.reason)
            response_connection_headers = {
                token.strip().lower()
                for value in response.getheaders()
                if value[0].lower() == "connection"
                for token in value[1].split(",")
                if token.strip()
            }
            for key, value in response.getheaders():
                excluded_response_headers = (
                    HOP_BY_HOP_HEADERS
                    | response_connection_headers
                    | {"content-length", "content-encoding"}
                )
                if key.lower() not in excluded_response_headers:
                    self.send_header(key, value)
            self.send_header("content-length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
        except socket.timeout:
            self.send_json_error(504, "routing_backend_timeout")
        except (OSError, http.client.HTTPException):
            self.send_json_error(502, "routing_backend_unavailable")
        finally:
            connection.close()

    def log_message(self, _format, *_args):
        pass


class ProofProxyServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def process_request(self, request, client_address):
        if not self.concurrency.acquire(blocking=False):
            body = b'{"error":"routing_proxy_busy"}'
            response = (
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"content-type: application/json\r\n"
                + f"content-length: {len(body)}\r\n".encode()
                + b"connection: close\r\n\r\n"
                + body
            )
            try:
                request.sendall(response)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            request.settimeout(self.client_timeout)
            super().process_request(request, client_address)
        except Exception:
            self.concurrency.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.concurrency.release()


def create_proxy_server(
    address,
    backend_address,
    journal_path,
    engine_path,
    child_alive,
    *,
    backend_timeout=DEFAULT_BACKEND_TIMEOUT,
    client_timeout=DEFAULT_CLIENT_TIMEOUT,
    max_concurrency=DEFAULT_MAX_CONCURRENCY,
):
    server = ProofProxyServer(address, ProofProxyHandler)
    server.backend_address = backend_address
    server.journal_path = Path(journal_path)
    server.engine_path = Path(engine_path)
    server.graph_dir = server.engine_path.parent
    server.child_alive = child_alive
    server.backend_timeout = backend_timeout
    server.client_timeout = client_timeout
    server.concurrency = threading.BoundedSemaphore(max_concurrency)
    return server


@contextlib.contextmanager
def writer_lock(state_path):
    lock = Path(str(state_path) + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    until = time.monotonic() + 25
    while True:
        try:
            lock.mkdir(mode=0o700)
            if os.geteuid() == 0:
                # The data-manager runs as the shared directory's owner. It has
                # to read and clear a lock this root process leaves behind when
                # its container is killed; atomic_json below follows suit.
                owner = lock.parent.stat()
                os.chown(lock, owner.st_uid, owner.st_gid)
            break
        except FileExistsError:
            if time.monotonic() >= until:
                raise RuntimeError("Writer lock did not clear; serving remains stopped")
            time.sleep(0.2)
    try:
        atomic_json(
            lock / "owner.json",
            {
                "pid": os.getpid(),
                "acquiredAt": int(time.time() * 1000),
                "owner": "valhalla-watchdog",
            },
        )
        yield
    finally:
        shutil.rmtree(lock)


def stop_group(child):
    if child.poll() is not None:
        return
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


def supervise(
    command,
    graph_dir=Path("/custom_files"),
    state_dir=Path("/traffic-state"),
    proxy_address=None,
    backend_address=("127.0.0.1", 8004),
):
    state_path = Path(state_dir) / "live-state.json"
    journal_path = Path(str(state_path) + ".journal.json")
    coordinated = (Path(graph_dir) / MAINTENANCE_FENCE).exists()
    if coordinated:
        # The authority's fresh manifest supersedes any withdrawn one.
        (Path(graph_dir) / UNVERIFIED_GENERATIONS).unlink(missing_ok=True)
        withdrawn = False
    else:
        # Withdrawn before the new boot is announced, so no writer pairs the
        # old graph proof with an engine that may still rebuild its tiles.
        withdrawn = set_aside_generations(graph_dir)
    # A restart can never serve unverified bytes retained from a prior container.
    with writer_lock(state_path):
        clear_offline(Path(graph_dir) / "traffic.tar")
        atomic_json(state_path, [])
        atomic_json(
            journal_path,
            {
                "schemaVersion": 1,
                "graphGeneration": "engine-start-clear",
                "phase": "committed",
                "validUntil": int(time.time() * 1000) + 120_000,
                "identities": [],
            },
        )
        atomic_json(
            Path(graph_dir) / "traffic-engine.json",
            {
                "schemaVersion": 1,
                "bootId": str(uuid.uuid4()),
                "startedAt": int(time.time() * 1000),
            },
        )
    child_env = dict(os.environ)
    if coordinated:
        # Offline authority just attested these tiles. Startup may not rebuild them.
        child_env["use_tiles_ignore_pbf"] = "True"
    child = subprocess.Popen(command, start_new_session=True, env=child_env)
    proxy = None
    proxy_thread = None
    stopping = False

    def settle_withdrawn_manifest():
        try:
            outcome = reattest_generations(
                graph_dir,
                lambda: backend_serving(backend_address),
                lambda: child.poll() is None and not stopping,
            )
        except Exception as error:
            outcome = "failed: " + type(error).__name__
        print(
            "Traffic graph manifest after uncoordinated start: " + outcome,
            file=sys.stderr,
            flush=True,
        )

    if withdrawn:
        threading.Thread(
            target=settle_withdrawn_manifest, name="traffic-graph-reattest", daemon=True
        ).start()

    def request_stop(_number, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        if proxy_address is not None:
            proxy = create_proxy_server(
                proxy_address,
                backend_address,
                journal_path,
                Path(graph_dir) / "traffic-engine.json",
                lambda: child.poll() is None,
            )
            proxy_thread = threading.Thread(
                target=proxy.serve_forever, name="traffic-proof-proxy", daemon=True
            )
            proxy_thread.start()
        while child.poll() is None and not stopping:
            if proxy_thread is not None and not proxy_thread.is_alive():
                print(
                    "Traffic proof proxy stopped; stopping engine",
                    file=sys.stderr,
                    flush=True,
                )
                stop_group(child)
                return 78
            if not lease_allows_serving(journal_path):
                try:
                    outcome = clear_expired(graph_dir, state_path, journal_path)
                except Exception as error:
                    print(
                        "Traffic lease clear failed: " + type(error).__name__,
                        file=sys.stderr,
                        flush=True,
                    )
                    outcome = "invalid"
                if outcome == "cleared":
                    print(
                        "Traffic lease expired; cleared its records in place, engine keeps serving",
                        file=sys.stderr,
                        flush=True,
                    )
                elif outcome == "invalid":
                    print(
                        "Traffic journal invalid; stopping engine before restart",
                        file=sys.stderr,
                        flush=True,
                    )
                    stop_group(child)
                    return 78
            time.sleep(2)
        return child.returncode if child.poll() is not None else 0
    finally:
        if proxy is not None:
            proxy.shutdown()
            proxy.server_close()
        if proxy_thread is not None:
            proxy_thread.join(timeout=3)
        stop_group(child)


if __name__ == "__main__":
    try:
        sys.exit(
            supervise(
                ["/valhalla/scripts/docker-entrypoint.sh", *sys.argv[1:]],
                proxy_address=("0.0.0.0", 8002),
            )
        )
    except Exception as error:
        print(
            "Traffic startup guard failed; engine was not admitted: "
            + type(error).__name__,
            file=sys.stderr,
        )
        sys.exit(78)
