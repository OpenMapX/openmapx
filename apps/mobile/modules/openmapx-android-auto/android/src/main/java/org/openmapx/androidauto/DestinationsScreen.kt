package org.openmapx.androidauto

import android.content.Intent
import android.net.Uri
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.MapWithContentTemplate
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import org.json.JSONObject

/** Destination browsing respects the host's item limit and keeps the map renderer passive. */
class DestinationsScreen(context: CarContext, private val search: Boolean = false) :
  Screen(context), DefaultLifecycleObserver {
  private var planning = false
  private val observer: () -> Unit = { invalidate() }

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
      if (result.has("routes")) {
        planning = false
        screenManager.push(PreviewScreen(carContext, result.optInt("routes", 1)))
      } else {
        return MessageTemplate.Builder(
            carContext.carString(
              if (result.has("error")) R.string.car_phone_setup else R.string.car_planning
            )
          )
          .setTitle(carContext.carString(R.string.car_destinations))
          .setHeaderAction(Action.BACK)
          .build()
      }
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
          if (result.has("error")) R.string.car_search_unavailable else R.string.car_search
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
class PreviewScreen(context: CarContext, private val count: Int) :
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

  override fun onGetTemplate(): Template {
    if (CarState.result.has("error"))
      return MessageTemplate.Builder(carContext.carString(R.string.car_phone_setup))
        .setHeaderAction(Action.BACK)
        .build()
    if (confirm)
      return MessageTemplate.Builder(carContext.carString(R.string.car_replace))
        .setHeaderAction(Action.BACK)
        .addAction(
          Action.Builder()
            .setTitle(carContext.carString(R.string.car_start))
            .setOnClickListener { start() }
            .build()
        )
        .build()
    val list = ItemList.Builder()
    for (i in 0 until count.coerceIn(1, 8)) {
      list.addItem(
        Row.Builder()
          .setTitle(carContext.carString(R.string.car_route, i + 1))
          .addAction(
            Action.Builder()
              .setTitle(carContext.carString(R.string.car_start))
              .setOnClickListener {
                selected = i
                start()
              }
              .build()
          )
          .build()
      )
    }
    return MapWithContentTemplate.Builder()
      .setContentTemplate(
        ListTemplate.Builder()
          .setTitle(carContext.carString(R.string.car_destinations))
          .setHeaderAction(Action.BACK)
          .setSingleList(list.build())
          .build()
      )
      .build()
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
