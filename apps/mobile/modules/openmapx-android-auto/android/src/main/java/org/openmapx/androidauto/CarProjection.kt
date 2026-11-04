package org.openmapx.androidauto

import org.json.JSONObject

/** Rejects malformed native projections before host builders or notification APIs consume them. */
object CarProjection {
  fun parse(value: JSONObject?): JSONObject? {
    if (value == null) return null
    if (value.optString("sessionId").length !in 1..128) return null
    if (value.optString("instruction").length !in 1..1024) return null
    if (value.optString("locale") !in listOf("en", "de")) return null
    if (value.optString("units") !in listOf("metric", "imperial")) return null
    for (key in
      listOf(
        "revision",
        "distanceToManeuver",
        "secondsToManeuver",
        "maneuverEtaMs",
        "remainingDistance",
        "remainingSeconds",
        "etaMs",
      )) {
      val number = value.opt(key) as? Number ?: return null
      if (!number.toDouble().isFinite() || number.toDouble() < 0) return null
    }
    val lanes = value.optJSONArray("lanes")
    if (lanes != null) {
      if (lanes.length() > 12) return null
      for (i in 0 until lanes.length()) {
        val lane = lanes.optJSONObject(i) ?: return null
        val indications = lane.optJSONArray("indications") ?: return null
        if (indications.length() > 8 || lane.opt("valid") !is Boolean) return null
        for (j in 0 until indications.length()) {
          val indication = indications.opt(j) as? String ?: return null
          if (indication.length > 32) return null
        }
      }
    }
    return value
  }
}
