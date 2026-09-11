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
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def clear_offline(path):
    """Only called before this process launches an engine; never replace its tar."""
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
            return False
        if not (0 <= deadline <= now_ms + 120_000):
            return False
        if uncertain:
            return False
        if phase == "pending":
            return deadline > now_ms
        return not identities or deadline > now_ms
    except (OSError, ValueError, TypeError, KeyError):
        return False


def read_json(path, maximum=MAX_EVIDENCE_BYTES):
    with open(path, "rb") as source:
        raw = source.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("JSON evidence exceeds limit")
    return json.loads(raw)


def graph_metadata_snapshot(graph_dir):
    graph_dir = Path(graph_dir)
    maintenance = graph_dir / ".traffic-maintenance.json"
    try:
        maintenance.stat()
        return None
    except FileNotFoundError:
        pass
    except OSError:
        return None
    try:
        generations_path = graph_dir / "traffic-generations.json"
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
        if not isinstance(generations, dict) or not isinstance(engine, dict):
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
            or not now_ms < deadline <= now_ms + 120_000
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
    if not now_ms < deadline <= now_ms + 120_000:
        return None
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
    if (Path(graph_dir) / ".traffic-maintenance.json").exists():
        # Offline authority just attested these tiles. Startup may not rebuild them.
        child_env["use_tiles_ignore_pbf"] = "True"
    else:
        # An uncoordinated scripted-image restart may rebuild base OSM tiles.
        # Its old extract/map proof cannot authorize another live write.
        (Path(graph_dir) / "traffic-generations.json").unlink(missing_ok=True)
    child = subprocess.Popen(command, start_new_session=True, env=child_env)
    proxy = None
    proxy_thread = None
    stopping = False

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
                print(
                    "Traffic lease expired or journal invalid; stopping engine before restart",
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
