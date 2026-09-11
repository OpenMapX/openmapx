import importlib.util
import http.client
import http.server
import json
import pathlib
import socket
import struct
import tempfile
import threading
import time
import unittest
import uuid

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "traffic-watchdog.py"
spec = importlib.util.spec_from_file_location("watchdog", SCRIPT)
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        pass


class BackendHandler(http.server.BaseHTTPRequestHandler):
    def _reply(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        self.server.requests.append((self.command, self.path, dict(self.headers), body))
        if self.server.on_request:
            self.server.on_request()
        if self.server.delay:
            time.sleep(self.server.delay)
        payload = self.server.response_body
        self.send_response(self.server.response_status)
        self.send_header("content-type", self.server.response_type)
        self.send_header("x-backend", "yes")
        for key, value in self.server.response_headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _reply
    do_POST = _reply

    def log_message(self, _format, *_args):
        pass


class HttpFixture:
    def __init__(self, root, *, max_concurrency=4, timeout=1, client_timeout=None):
        self.root = pathlib.Path(root)
        self.journal = self.root / "live-state.json.journal.json"
        self.engine = self.root / "traffic-engine.json"
        self.generations = self.root / "traffic-generations.json"
        self.maintenance = self.root / ".traffic-maintenance.json"
        self.child_alive = True
        self.backend = QuietThreadingHTTPServer(("127.0.0.1", 0), BackendHandler)
        self.backend.requests = []
        self.backend.response_status = 200
        self.backend.response_type = "application/json"
        self.backend.response_body = json.dumps(
            {"trip": {"status": 0}, "openmapx_traffic_proof": {"forged": True}}
        ).encode()
        self.backend.response_headers = []
        self.backend.on_request = None
        self.backend.delay = 0
        proxy_options = {
            "backend_timeout": timeout,
            "max_concurrency": max_concurrency,
        }
        if client_timeout is not None:
            proxy_options["client_timeout"] = client_timeout
        self.proxy = watchdog.create_proxy_server(
            ("127.0.0.1", 0),
            self.backend.server_address,
            self.journal,
            self.engine,
            lambda: self.child_alive,
            **proxy_options,
        )
        self.threads = [
            threading.Thread(target=self.backend.serve_forever, daemon=True),
            threading.Thread(target=self.proxy.serve_forever, daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def close(self):
        self.proxy.shutdown()
        self.backend.shutdown()
        self.proxy.server_close()
        self.backend.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def write_evidence(
        self,
        *,
        now=None,
        write_id=None,
        graph=None,
        boot=None,
        base_graph=None,
        **changes,
    ):
        now = int(time.time() * 1000) if now is None else now
        write_id = str(uuid.uuid4()) if write_id is None else write_id
        boot = str(uuid.uuid4()) if boot is None else boot
        graph = "b" * 64 if graph is None else graph
        base_graph = "a" * 64 if base_graph is None else base_graph
        value = {
            "schemaVersion": 1,
            "writeId": write_id,
            "routingGraphGeneration": graph,
            "engineBootId": boot,
            "phase": "committed",
            "uncertain": False,
            "validUntil": now + 60_000,
        }
        value.update(changes)
        self.journal.write_text(json.dumps(value))
        self.engine.write_text(
            json.dumps({"schemaVersion": 1, "bootId": boot, "startedAt": now})
        )
        self.generations.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "graphGeneration": base_graph,
                    "extractGeneration": base_graph,
                    "waysToEdgesGeneration": base_graph,
                    "completedAt": watchdog.iso_timestamp(now),
                }
            )
        )
        return value

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.proxy.server_address, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()), payload)
        connection.close()
        return result


def fixture():
    data = bytearray(3072)
    data[:9] = b"index.bin"
    data[124:136] = b"00000000020\0"
    struct.pack_into("<QII", data, 512, 1536, 10, 40)
    struct.pack_into("<QQIIII", data, 1536, 10, 0, 1, 3, 0, 0)
    struct.pack_into("<Q", data, 1568, (255 << 28) | (255 << 36))
    return data


class TrafficWatchdogTest(unittest.TestCase):
    def test_offline_clear_preserves_inode_and_validates_bounds_first(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "traffic.tar"
            path.write_bytes(fixture())
            inode = path.stat().st_ino
            watchdog.clear_offline(path)
            self.assertEqual(path.stat().st_ino, inode)
            self.assertEqual(
                struct.unpack_from("<Q", path.read_bytes(), 1568)[0], 127 | (127 << 7)
            )
            bad = fixture()
            struct.pack_into("<Q", bad, 512, 9000)
            path.write_bytes(bad)
            with self.assertRaises(ValueError):
                watchdog.clear_offline(path)
            self.assertEqual(path.read_bytes(), bad)

    def test_lease_distinguishes_empty_stock_from_stale_effects(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "journal.json"
            value = {
                "schemaVersion": 1,
                "graphGeneration": "g",
                "phase": "committed",
                "validUntil": 2000,
                "identities": [{"level": 2, "tile": 1, "index": 0}],
            }
            path.write_text(json.dumps(value))
            self.assertTrue(watchdog.lease_allows_serving(path, 1000))
            self.assertFalse(watchdog.lease_allows_serving(path, 2000))
            value["identities"] = []
            path.write_text(json.dumps(value))
            self.assertTrue(watchdog.lease_allows_serving(path, 3000))
            path.write_text("{broken")
            self.assertFalse(watchdog.lease_allows_serving(path, 1000))
            path.unlink()
            self.assertFalse(watchdog.lease_allows_serving(path, 1000))

    def test_pending_empty_and_uncertain_journals_are_never_unbounded(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "journal.json"
            value = {
                "schemaVersion": 1,
                "graphGeneration": "g",
                "phase": "pending",
                "validUntil": 2000,
                "identities": [],
            }
            path.write_text(json.dumps(value))
            self.assertTrue(watchdog.lease_allows_serving(path, 1000))
            self.assertFalse(watchdog.lease_allows_serving(path, 2000))
            value["validUntil"] = 3000
            value["uncertain"] = True
            path.write_text(json.dumps(value))
            self.assertFalse(watchdog.lease_allows_serving(path, 1000))
            value["phase"] = "committed"
            path.write_text(json.dumps(value))
            self.assertFalse(watchdog.lease_allows_serving(path, 1000))

    def test_proxy_strips_nonce_and_replaces_backend_proof_for_eligible_route(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                evidence = fixture.write_evidence()
                request_id = str(uuid.uuid4())
                request = {
                    "openmapx_request_id": request_id,
                    "locations": [{"lat": 1, "lon": 2}, {"lat": 3, "lon": 4}],
                    "costing": "auto",
                    "date_time": {"type": 0},
                    "costing_options": {
                        "auto": {"speed_types": ["freeflow", "current"]}
                    },
                }
                status, headers, body = fixture.request(
                    "POST",
                    "/route",
                    json.dumps(request),
                    {
                        "content-type": "application/json",
                        "connection": "x-proxy-private",
                        "x-proxy-private": "secret",
                    },
                )
                self.assertEqual(status, 200)
                self.assertEqual(headers["x-backend"], "yes")
                forwarded = json.loads(fixture.backend.requests[0][3])
                self.assertNotIn("openmapx_request_id", forwarded)
                self.assertEqual(forwarded["locations"], request["locations"])
                forwarded_headers = {
                    key.lower(): value
                    for key, value in fixture.backend.requests[0][2].items()
                }
                self.assertNotIn("x-proxy-private", forwarded_headers)
                response = json.loads(body)
                self.assertEqual(response["trip"], {"status": 0})
                proof = response["openmapx_traffic_proof"]
                self.assertEqual(
                    proof,
                    {
                        "schemaVersion": 1,
                        "requestId": request_id,
                        "writeId": evidence["writeId"],
                        "graphGeneration": evidence["routingGraphGeneration"],
                        "engineBootId": evidence["engineBootId"],
                        "validUntil": watchdog.iso_timestamp(evidence["validUntil"]),
                        "evaluatedAt": proof["evaluatedAt"],
                        "endpoint": "route",
                        "costing": "auto",
                    },
                )
                self.assertTrue(proof["evaluatedAt"].endswith("Z"))
            finally:
                fixture.close()

    def test_proxy_never_proves_ineligible_requests_and_always_strips_backend_proof(
        self,
    ):
        cases = [
            (
                "/route",
                {
                    "costing": "bicycle",
                    "date_time": {"type": 0},
                    "costing_options": {"bicycle": {"speed_types": ["current"]}},
                },
            ),
            (
                "/route",
                {
                    "costing": "auto",
                    "date_time": {"type": 1},
                    "costing_options": {"auto": {"speed_types": ["current"]}},
                },
            ),
            (
                "/route",
                {
                    "costing": "auto",
                    "date_time": {"type": 0},
                    "costing_options": {"auto": {"speed_types": ["freeflow"]}},
                },
            ),
            (
                "/route",
                {
                    "costing": "auto",
                    "date_time": {"type": 0},
                    "costing_options": {
                        "auto": {"speed_types": ["current"], "ignore_closures": True}
                    },
                },
            ),
            (
                "/isochrone",
                {
                    "costing": "auto",
                    "date_time": {"type": 0},
                    "costing_options": {"auto": {"speed_types": ["current"]}},
                },
            ),
        ]
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                fixture.write_evidence()
                for path, request in cases:
                    request["openmapx_request_id"] = str(uuid.uuid4())
                    status, _, body = fixture.request(
                        "POST",
                        path,
                        json.dumps(request),
                        {"content-type": "application/json"},
                    )
                    self.assertEqual(status, 200)
                    self.assertNotIn("openmapx_traffic_proof", json.loads(body), path)
            finally:
                fixture.close()

    def test_proxy_fails_closed_for_nonce_journal_boot_liveness_and_time_errors(self):
        now = int(time.time() * 1000)
        invalid_evidence = [
            {"openmapx_request_id": None},
            {"openmapx_request_id": "not-a-uuid"},
            {"phase": "pending"},
            {"uncertain": True},
            {"validUntil": now - 1},
            {"validUntil": now + 121_000},
            {"writeId": None},
            {"routingGraphGeneration": None},
            {"engineBootId": None},
        ]
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                base = {
                    "openmapx_request_id": str(uuid.uuid4()),
                    "costing": "motorcycle",
                    "date_time": {"type": 0},
                    "costing_options": {"motorcycle": {"speed_types": ["current"]}},
                }
                for changes in invalid_evidence:
                    request = dict(base)
                    if "openmapx_request_id" in changes:
                        request.update(changes)
                        fixture.write_evidence(now=now)
                    else:
                        fixture.write_evidence(now=now, **changes)
                    _, _, body = fixture.request(
                        "POST",
                        "/optimized_route",
                        json.dumps(request),
                        {"content-type": "application/json"},
                    )
                    self.assertNotIn(
                        "openmapx_traffic_proof", json.loads(body), changes
                    )

                evidence = fixture.write_evidence(now=now)
                fixture.engine.write_text(
                    json.dumps({"schemaVersion": 1, "bootId": str(uuid.uuid4())})
                )
                _, _, body = fixture.request(
                    "POST",
                    "/route",
                    json.dumps(base),
                    {"content-type": "application/json"},
                )
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))
                fixture.engine.write_text(
                    json.dumps({"schemaVersion": 1, "bootId": evidence["engineBootId"]})
                )
                fixture.child_alive = False
                _, _, body = fixture.request(
                    "POST",
                    "/route",
                    json.dumps(base),
                    {"content-type": "application/json"},
                )
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))
            finally:
                fixture.close()

    def test_proxy_withholds_proof_when_a_write_races_the_backend_request(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                first = fixture.write_evidence()

                def replace_journal():
                    fixture.write_evidence(
                        boot=first["engineBootId"],
                        graph=first["routingGraphGeneration"],
                    )

                fixture.backend.on_request = replace_journal
                request = {
                    "openmapx_request_id": str(uuid.uuid4()),
                    "costing": "auto",
                    "date_time": {"type": 0},
                    "costing_options": {"auto": {"speed_types": ["current"]}},
                }
                _, _, body = fixture.request(
                    "POST",
                    "/route",
                    json.dumps(request),
                    {"content-type": "application/json"},
                )
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))
            finally:
                fixture.close()

    def test_proxy_brackets_consistent_graph_metadata_and_maintenance_fence(self):
        request = {
            "openmapx_request_id": str(uuid.uuid4()),
            "costing": "auto",
            "date_time": {"type": 0},
            "costing_options": {"auto": {"speed_types": ["current"]}},
        }
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                evidence = fixture.write_evidence()
                fixture.generations.unlink()
                _, _, body = fixture.request("POST", "/route", json.dumps(request))
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))

                fixture.write_evidence(
                    write_id=evidence["writeId"],
                    graph=evidence["routingGraphGeneration"],
                    boot=evidence["engineBootId"],
                )
                generation = json.loads(fixture.generations.read_text())
                generation["extractGeneration"] = "c" * 64
                fixture.generations.write_text(json.dumps(generation))
                _, _, body = fixture.request("POST", "/route", json.dumps(request))
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))

                fixture.write_evidence(
                    write_id=evidence["writeId"],
                    graph=evidence["routingGraphGeneration"],
                    boot=evidence["engineBootId"],
                )
                fixture.maintenance.write_text("{}")
                _, _, body = fixture.request("POST", "/route", json.dumps(request))
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))
            finally:
                fixture.close()

    def test_proxy_withholds_proof_when_graph_metadata_changes_during_request(self):
        request = {
            "openmapx_request_id": str(uuid.uuid4()),
            "costing": "auto",
            "date_time": {"type": 0},
            "costing_options": {"auto": {"speed_types": ["current"]}},
        }
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                fixture.write_evidence()

                def replace_metadata():
                    generation = json.loads(fixture.generations.read_text())
                    generation["completedAt"] = watchdog.iso_timestamp(
                        int(time.time() * 1000) + 1
                    )
                    fixture.generations.write_text(json.dumps(generation))

                fixture.backend.on_request = replace_metadata
                _, _, body = fixture.request("POST", "/route", json.dumps(request))
                self.assertNotIn("openmapx_traffic_proof", json.loads(body))
            finally:
                fixture.close()

    def test_proxy_fails_closed_without_dropping_requests_for_malformed_evidence_roots(
        self,
    ):
        request = {
            "openmapx_request_id": str(uuid.uuid4()),
            "costing": "auto",
            "date_time": {"type": 0},
            "costing_options": {"auto": {"speed_types": ["current"]}},
        }
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                fixture.write_evidence()
                for path in (fixture.journal, fixture.generations, fixture.engine):
                    fixture.write_evidence()
                    path.write_text("[]")
                    status, _, body = fixture.request(
                        "POST", "/route", json.dumps(request)
                    )
                    self.assertEqual(status, 200, path.name)
                    self.assertNotIn(
                        "openmapx_traffic_proof", json.loads(body), path.name
                    )
            finally:
                fixture.close()

    def test_proxy_accepts_a_valid_journal_larger_than_graph_metadata_limit(self):
        request = {
            "openmapx_request_id": str(uuid.uuid4()),
            "costing": "auto",
            "date_time": {"type": 0},
            "costing_options": {"auto": {"speed_types": ["current"]}},
        }
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                fixture.write_evidence(
                    identities=[
                        {"level": 2, "tile": index, "index": 0} for index in range(3000)
                    ]
                )
                self.assertGreater(
                    fixture.journal.stat().st_size, watchdog.MAX_EVIDENCE_BYTES
                )
                status, _, body = fixture.request("POST", "/route", json.dumps(request))
                self.assertEqual(status, 200)
                self.assertIn("openmapx_traffic_proof", json.loads(body))
            finally:
                fixture.close()

    def test_proxy_forwards_get_status_and_backend_http_errors(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                fixture.backend.response_status = 429
                fixture.backend.response_body = (
                    b'{"error":"busy","openmapx_traffic_proof":{"forged":true}}'
                )
                fixture.backend.response_headers = [
                    ("connection", "x-backend-private"),
                    ("x-backend-private", "secret"),
                ]
                status, headers, body = fixture.request("GET", "/status?verbose=true")
                self.assertEqual(status, 429)
                self.assertEqual(headers["x-backend"], "yes")
                self.assertNotIn("x-backend-private", headers)
                self.assertEqual(json.loads(body), {"error": "busy"})
                self.assertEqual(
                    fixture.backend.requests[0][:2], ("GET", "/status?verbose=true")
                )
            finally:
                fixture.close()

    def test_proxy_rejects_oversized_requests(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            try:
                status, _, _ = fixture.request(
                    "POST",
                    "/route",
                    b"x",
                    {"content-length": str(watchdog.MAX_REQUEST_BYTES + 1)},
                )
                self.assertEqual(status, 413)
            finally:
                fixture.close()

    def test_proxy_rejects_requests_while_capacity_is_occupied(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root, max_concurrency=1, timeout=3)
            entered = threading.Event()
            release = threading.Event()
            responses = []
            fixture.backend.on_request = lambda: (entered.set(), release.wait(3))
            first = threading.Thread(
                target=lambda: responses.append(fixture.request("GET", "/status")),
                daemon=True,
            )
            try:
                first.start()
                self.assertTrue(entered.wait(1))
                status, _, _ = fixture.request("GET", "/status")
                self.assertEqual(status, 503)
                release.set()
                first.join(timeout=2)
                self.assertFalse(first.is_alive())
                self.assertEqual(responses[0][0], 200)
            finally:
                release.set()
                first.join(timeout=2)
                fixture.close()

    def test_proxy_bounds_backend_response_time(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root, timeout=0.05)
            try:
                fixture.backend.delay = 0.2
                status, _, _ = fixture.request("GET", "/status")
                self.assertEqual(status, 504)
            finally:
                fixture.close()

    def test_proxy_reports_backend_failure(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root)
            fixture.backend.shutdown()
            fixture.backend.server_close()
            fixture.threads[0].join(timeout=2)
            try:
                status, _, body = fixture.request("GET", "/status")
                self.assertEqual(status, 502)
                self.assertEqual(
                    json.loads(body)["error"], "routing_backend_unavailable"
                )
            finally:
                fixture.proxy.shutdown()
                fixture.proxy.server_close()
                fixture.threads[1].join(timeout=2)

    def test_slow_clients_are_bounded_and_capacity_recovers_after_timeout(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root, max_concurrency=1, client_timeout=0.1)
            slow = socket.create_connection(fixture.proxy.server_address, timeout=2)
            try:
                slow.sendall(
                    b"POST /route HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{"
                )
                status, _, _ = fixture.request("GET", "/status")
                self.assertEqual(status, 503)
                response = slow.recv(4096)
                self.assertIn(b" 408 ", response)
                slow.close()
                deadline = time.monotonic() + 2
                while True:
                    status, _, _ = fixture.request("GET", "/status")
                    if status != 503 or time.monotonic() >= deadline:
                        break
                    time.sleep(0.01)
                self.assertEqual(status, 200)
            finally:
                slow.close()
                fixture.close()

    def test_truncated_client_receives_bad_request(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = HttpFixture(root, max_concurrency=1, client_timeout=0.1)
            try:
                with socket.create_connection(
                    fixture.proxy.server_address, timeout=2
                ) as truncated:
                    truncated.sendall(
                        b"POST /route HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{}"
                    )
                    truncated.shutdown(socket.SHUT_WR)
                    response = truncated.recv(4096)
                    self.assertIn(b" 400 ", response)
            finally:
                fixture.close()

    def test_only_exact_route_paths_can_receive_proof(self):
        body = json.dumps(
            {
                "openmapx_request_id": str(uuid.uuid4()),
                "costing": "auto",
                "date_time": {"type": 0},
                "costing_options": {"auto": {"speed_types": ["current"]}},
            }
        ).encode()
        for path in ("//route", "///route", "/route/"):
            _, eligibility = watchdog.eligible_request(path, body)
            self.assertIsNone(eligibility, path)


if __name__ == "__main__":
    unittest.main()
