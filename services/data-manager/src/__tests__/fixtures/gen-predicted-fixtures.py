# Generates the known-good Valhalla predicted-speed fixtures using pyvalhalla
# (Valhalla's exact C++ DCT-II encoder). Reproduce:
#   python3 -m venv venv && ./venv/bin/pip install pyvalhalla numpy
#   ./venv/bin/python3 gen-predicted-fixtures.py
# pyvalhalla API (baldr.utils): compress_speed_buckets(float32[2016]) -> int16[200];
#   encode_compressed_speeds(int16[200]) -> base64 str. BUCKETS_PER_WEEK=2016, COEFFICIENT_COUNT=200.
import numpy as np, json
from valhalla.baldr import utils as u

def expand(hourly, ff):
    b = [0.0] * 2016
    for d in range(7):
        for h in range(24):
            v = hourly[24 * d + h]
            v = ff if v is None else v
            v = max(5.0, min(140.0, float(v)))  # clamp 5..140 per Valhalla
            for k in range(12):
                b[288 * d + 12 * h + k] = v      # Sunday-first, 12 five-min buckets/hour
    return b

def enc(buckets):
    coefs = u.compress_speed_buckets(np.asarray(buckets, dtype=np.float32))
    return [int(c) for c in coefs], u.encode_compressed_speeds(coefs)

all50 = [50] * 168
day = [100,100,100,100,100,100,100, 45,45,45, 80,80,80,80,80,80,80, 40,40,40, 100,100,100,100]
rush = day * 7
b1 = expand(all50, 50); c1, e1 = enc(b1)
b2 = expand(rush, 100); c2, e2 = enc(b2)
json.dump({"all50": {"buckets2016": b1, "coefs": c1, "base64": e1, "freeFlow": 50, "hourly": all50},
           "rush":  {"hourly_day": day, "freeFlow": 100, "buckets2016": b2, "coefs": c2, "base64": e2}},
          open("predicted-fixtures.json", "w"))
print("all50 base64:", e1)
print("rush  base64:", e2)
