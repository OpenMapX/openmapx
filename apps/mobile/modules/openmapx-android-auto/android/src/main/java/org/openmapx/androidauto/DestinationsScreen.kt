package org.openmapx.androidauto

import android.content.Intent
import android.net.Uri
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import android.text.SpannableString
import android.text.Spanned
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarText
import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.DurationSpan
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.MapController
import androidx.car.app.navigation.model.MapWithContentTemplate
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.LifecycleOwner
import org.json.JSONArray
import org.json.JSONObject

/** Destination browsing respects the host's item limit and keeps the map renderer passive. */
class DestinationsScreen(context: CarContext, private val search: Boolean = false) :
  Screen(context), DefaultLifecycleObserver {
  private var planning = false
  // Screen changes happen outside onGetTemplate, which the host only renders.
  private val observer: () -> Unit = {
    val routes = CarState.result.optJSONArray("routes")
    if (planning && routes != null && routes.length() > 0) {
      planning = false
      screenManager.push(PreviewScreen(carContext, routes))
    } else invalidate()
  }

  init {
    lifecycle.addObserver(this)
    CarState.observers.add(observer)
  }

  fun plan(place: JSONObject) {
    planning = true
    CarState.result = JSONObject()
    CarState.command("car:" + JSONObject().put("action", "plan").put("destination", place))
    invalidate()
  }

  override fun onGetTemplate(): Template {
    val result = CarState.result
    if (planning) {
      return MessageTemplate.Builder(
          carContext.carString(
            if (result.has("error")) CarErrors.message(result.optString("error"))
            else R.string.car_planning
          )
        )
        .setTitle(carContext.carString(R.string.car_destinations))
        .setHeaderAction(Action.BACK)
        .build()
    }
    val list = ItemList.Builder()
    val limit =
      carContext
        .getCarService(ConstraintManager::class.java)
        .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        .coerceAtLeast(1)
    if (search) {
      val places = result.optJSONArray("results")
      for (i in 0 until minOf(places?.length() ?: 0, limit)) {
        val place = places!!.getJSONObject(i)
        list.addItem(
          Row.Builder()
            .setTitle(place.optString("label"))
            .setOnClickListener { plan(place) }
            .build()
        )
      }
      list.setNoItemsMessage(
        carContext.carString(
          when {
            result.has("error") -> R.string.car_search_unavailable
            result.has("results") -> R.string.car_search_none
            else -> R.string.car_search_hint
          }
        )
      )
      return SearchTemplate.Builder(
          object : SearchTemplate.SearchCallback {
            override fun onSearchTextChanged(text: String) {
              CarState.command(
                "car:" + JSONObject().put("action", "search").put("query", text.take(160))
              )
            }

            override fun onSearchSubmitted(text: String) {
              onSearchTextChanged(text)
            }
          }
        )
        .setHeaderAction(Action.BACK)
        .setItemList(list.build())
        .build()
    }
    list.addItem(
      Row.Builder()
        .setTitle(carContext.carString(R.string.car_search))
        .setOnClickListener {
          CarState.result = JSONObject()
          screenManager.push(DestinationsScreen(carContext, true))
        }
        .build()
    )
    var count = 1
    if (CarState.autoDrive) {
      // Reachable from the simulated start in Berlin, whatever the reviewer's location.
      val place = AutoDrive.destination(carContext.carString(R.string.car_auto_drive_destination))
      list.addItem(
        Row.Builder().setTitle(place.optString("label")).setOnClickListener { plan(place) }.build()
      )
      count++
    }
    for (key in listOf("recent", "saved")) {
      val places = CarState.destinations.optJSONArray(key) ?: continue
      for (i in 0 until places.length()) {
        if (count >= limit) break
        val place = places.getJSONObject(i)
        list.addItem(
          Row.Builder()
            .setTitle(place.optString("label"))
            .setOnClickListener { plan(place) }
            .build()
        )
        count++
      }
    }
    return ListTemplate.Builder()
      .setTitle(carContext.carString(R.string.car_destinations))
      .setHeaderAction(Action.BACK)
      .setSingleList(list.build())
      .build()
  }

  override fun onDestroy(owner: LifecycleOwner) {
    CarState.observers.remove(observer)
    CarState.command("car:" + JSONObject().put("action", "cancel"))
  }
}

/** Starting a preview asks before replacing the currently active trip. */
class PreviewScreen(context: CarContext, private val routes: JSONArray) :
  Screen(context), DefaultLifecycleObserver {
  private val observer: () -> Unit = {
    if (CarState.result.optBoolean("started")) screenManager.popToRoot() else invalidate()
  }

  init {
    lifecycle.addObserver(this)
    CarState.observers.add(observer)
  }

  override fun onDestroy(owner: LifecycleOwner) {
    CarState.observers.remove(observer)
  }

  private var selected = 0
  private var confirm = false
  private var confirmedSession: String? = null

  private fun select(index: Int) {
    if (index == selected) return
    selected = index
    CarState.command("car:" + JSONObject().put("action", "select").put("index", index))
    invalidate()
  }

  private fun start() {
    val current = CarState.projection
    if (current != null && !confirm) {
      confirmedSession = current.optString("sessionId")
      confirm = true
      invalidate()
      return
    }
    CarState.command(
      "car:" +
        JSONObject()
          .put("action", "start")
          .put("index", selected)
          .put("replaceSessionId", confirmedSession)
    )
  }

  private fun startAction(primary: Boolean, onClick: () -> Unit) =
    Action.Builder()
      .setTitle(carContext.carString(R.string.car_start))
      .setIcon(carContext.carIcon(R.drawable.car_navigate))
      .apply { if (primary) setFlags(Action.FLAG_PRIMARY) }
      .setOnClickListener(onClick)
      .build()

  override fun onGetTemplate(): Template {
    if (CarState.result.has("error"))
      return MessageTemplate.Builder(
          carContext.carString(CarErrors.message(CarState.result.optString("error")))
        )
        .setHeaderAction(Action.BACK)
        .build()
    if (confirm)
      return MessageTemplate.Builder(carContext.carString(R.string.car_replace))
        .setHeaderAction(Action.BACK)
        .addAction(startAction(primary = true) { start() })
        .build()
    val list = ItemList.Builder()
    for (i in 0 until routes.length().coerceIn(1, 8)) {
      val route = routes.optJSONObject(i) ?: JSONObject()
      val duration = SpannableString(" ")
      duration.setSpan(
        DurationSpan.create(route.optLong("durationSeconds").coerceAtLeast(0)),
        0,
        1,
        Spanned.SPAN_INCLUSIVE_INCLUSIVE,
      )
      val distance = SpannableString(" ")
      distance.setSpan(
        DistanceSpan.create(CarTripMapper.distance(route.optJSONObject("distance"))),
        0,
        1,
        Spanned.SPAN_INCLUSIVE_INCLUSIVE,
      )
      val row =
        Row.Builder()
          .setTitle(CarText.create(duration))
          .addText(CarText.create(distance))
          .setOnClickListener { select(i) }
      // The same letter as the route's badge on the map; the selected one in blue.
      row.setImage(
        CarIcon.Builder(IconCompat.createWithBitmap(RouteBadge.bitmap(i, i == selected))).build()
      )
      list.addItem(row.build())
    }
    return MapWithContentTemplate.Builder()
      .setMapController(
        MapController.Builder().setMapActionStrip(CarMapActions.zoom(carContext).build()).build()
      )
      .setContentTemplate(
        ListTemplate.Builder()
          .setTitle(carContext.carString(R.string.car_destinations))
          .setHeaderAction(Action.BACK)
          .setSingleList(list.build())
          .build()
      )
      // The host draws no action below a list in a map template; Start sits in the action strip.
      .setActionStrip(
        ActionStrip.Builder().addAction(startAction(primary = false) { start() }).build()
      )
      .build()
  }
}

/** One message per planning failure, so the driver knows what can fix it. */
object CarErrors {
  fun message(code: String): Int =
    when (code) {
      "phone-setup" -> R.string.car_phone_setup
      "location-unavailable" -> R.string.car_location_unavailable
      "no-route" -> R.string.car_no_route
      "network" -> R.string.car_network
      else -> R.string.car_unavailable
    }
}

/** Coordinates from external apps are validated before they reach the planner. */
object CarNavigationIntent {
  fun destination(intent: Intent): JSONObject? {
    val uri = intent.data ?: return null
    if (uri.scheme !in listOf("geo", "google.navigation")) return null
    val text = uri.schemeSpecificPart
    val query =
      Uri.parse("https://localhost/?" + text.substringAfter('?', text)).getQueryParameter("q")
    val coordinates = (query ?: text.substringBefore('?')).substringBefore('(').split(',')
    val lat = coordinates.getOrNull(0)?.toDoubleOrNull() ?: return null
    val lng = coordinates.getOrNull(1)?.toDoubleOrNull() ?: return null
    if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0)
      return null
    return JSONObject()
      .put("id", "intent")
      .put(
        "label",
        query?.substringAfter('(', "")?.substringBefore(')')?.takeIf { it.isNotBlank() }?.take(160)
          ?: "$lat, $lng",
      )
      .put("coordinates", org.json.JSONArray().put(lng).put(lat))
  }
}

/** Round route letter badges matching the map: A, B, C …; blue when selected. */
object RouteBadge {
  fun letter(index: Int): String = ('A' + index).toString()

  fun bitmap(index: Int, selected: Boolean): android.graphics.Bitmap {
    val size = 96
    val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    val fill =
      android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = if (selected) 0xFF1A73E8.toInt() else 0xFF5F6F86.toInt()
      }
    val ring =
      android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        style = android.graphics.Paint.Style.STROKE
        strokeWidth = 6f
      }
    canvas.drawCircle(size / 2f, size / 2f, size / 2f - 4f, fill)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f - 4f, ring)
    val text =
      android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        textSize = 52f
        textAlign = android.graphics.Paint.Align.CENTER
        typeface = android.graphics.Typeface.DEFAULT_BOLD
      }
    val baseline = size / 2f - (text.descent() + text.ascent()) / 2f
    canvas.drawText(letter(index), size / 2f, baseline, text)
    return bitmap
  }
}

/** The destination offered in Android Auto's test-drive mode: Brandenburg Gate, Berlin. */
object AutoDrive {
  fun destination(label: String): JSONObject =
    JSONObject()
      .put("id", "auto-drive")
      .put("label", label)
      .put("coordinates", JSONArray().put(13.3777).put(52.5163))
}
