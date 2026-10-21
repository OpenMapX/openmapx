#!/usr/bin/env python3
"""Owned Biome native-role supervisor: retain one killed writer until release."""
import json
import os
import signal
import time

config = json.loads(os.environ["CODEGEN_ZOMBIE"])
marker = config["marker"]
group = os.getpgrp()
wrapper = os.getppid()
assert group == wrapper
os.setpgid(0, 0)  # Stay in the wrapper's session, outside the target group.


def record(suffix, value):
    with open(marker + suffix + ".pending", "w") as output:
        json.dump(value, output)
    os.rename(marker + suffix + ".pending", marker + suffix)


writer = os.fork()
if writer == 0:
    os.setpgid(0, group)
    heartbeat = os.path.join(config["source"], "writer")
    until = time.monotonic() + 3
    while True:
        with open(heartbeat, "a") as output:
            output.write("writer alive\n")
        if os.path.exists(marker + ".go"):
            break
        if time.monotonic() > until:
            os._exit(3)
        time.sleep(0.005)
    remaining = memoryview(b"x" * (16 * 1024 * 1024 + 1))
    while remaining:
        remaining = remaining[os.write(1, remaining):]
    while time.monotonic() < until:
        with open(heartbeat, "a") as output:
            output.write("writer alive\n")
        time.sleep(0.005)
    os._exit(4)

record("", {"supervisor": os.getpid(), "writer": writer, "wrapper": wrapper, "group": group})
# Only the wrapper and writer retain the formatter's pipes.
for fd in (0, 1, 2):
    os.close(fd)
try:
    until = time.monotonic() + 6
    while not os.path.exists(marker + ".release") and time.monotonic() < until:
        time.sleep(0.005)
finally:
    try:
        os.kill(writer, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    reaped, status = os.waitpid(writer, 0)
    record(".reaped", {"reaped": reaped, "status": status})
