package org.openmapx.androidauto

import org.json.JSONObject

/** Main-thread mailbox; a late JS listener drains commands rather than losing host stop. */
object CarState {
  var destinations = JSONObject()
  var result = JSONObject()
  var connected = false
  var locale = "en"
  var units = "metric"
  var projection: JSONObject? = null
  var snapshot: JSONObject? = null
  var preview: JSONObject =
    JSONObject().put("v", 1).put("type", "car-preview").put("routes", org.json.JSONArray())
  var origin: String? = null
  var listener: ((String) -> Unit)? = null
  private val pending = linkedSetOf<String>()
  val observers = mutableSetOf<() -> Unit>()

  fun command(command: String) {
    if (pending.add(command)) listener?.invoke(command)
  }

  fun drain() {
    pending.toList().forEach { listener?.invoke(it) }
  }

  fun acknowledge(command: String) {
    pending.remove(command)
  }

  fun changed() {
    observers.toList().forEach { it() }
  }
}
