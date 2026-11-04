package org.openmapx.androidauto

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import androidx.car.app.AppManager
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.Session
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.validation.HostValidator
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner

/** Android Auto service with signed production host validation. */
class OpenMapXCarService : CarAppService() {
  override fun createHostValidator(): HostValidator =
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    else
      HostValidator.Builder(this)
        .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
        .build()

  override fun onCreateSession(): Session =
    object : Session() {
      private var screen: NavigationScreen? = null

      init {
        lifecycle.addObserver(
          object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
              CarState.visible = true
            }

            override fun onStop(owner: LifecycleOwner) {
              CarState.visible = false
            }

            override fun onDestroy(owner: LifecycleOwner) {
              CarState.connected = false
              CarState.autoDrive = false
              CarState.command("detach")
              GuidanceNotification.update(carContext, null)
              carContext.stopService(Intent(carContext, CarRuntimeService::class.java))
            }
          }
        )
      }

      override fun onCreateScreen(intent: Intent): Screen {
        // HeadlessJsTaskService uses the application's one ReactHost, including when no Activity
        // exists.
        val info =
          carContext.packageManager.getApplicationInfo(
            carContext.packageName,
            android.content.pm.PackageManager.GET_META_DATA,
          )
        CarState.origin = info.metaData.getString("org.openmapx.androidauto.WEB_ORIGIN")
        CarState.connected = true
        carContext.startService(Intent(carContext, CarRuntimeService::class.java))
        return NavigationScreen(carContext).also {
          screen = it
          carContext.mainExecutor.execute { handleIntent(intent) }
        }
      }

      private fun handleIntent(intent: Intent) {
        val destination = CarNavigationIntent.destination(intent)
        val query = intent.data?.schemeSpecificPart?.substringAfter("q=", "")?.substringBefore('&')
        if (destination == null && query.isNullOrBlank()) return
        val destinations = DestinationsScreen(carContext, destination == null)
        carContext.getCarService(ScreenManager::class.java).push(destinations)
        if (destination != null) destinations.plan(destination)
        else
          CarState.command(
            "car:" +
              org.json
                .JSONObject()
                .put("action", "search")
                .put("query", android.net.Uri.decode(query).take(160))
          )
      }

      override fun onNewIntent(intent: Intent) {
        handleIntent(intent)
      }

      override fun onCarConfigurationChanged(configuration: Configuration) {
        screen?.themeChanged()
      }
    }
}

/** Host template and metadata adapter; navigation state remains owned by JS. */
class NavigationScreen(context: CarContext) : Screen(context), DefaultLifecycleObserver {
  private var following = true
  private var navigating = false
  private val surface =
    CarSurfaceHost(context) {
      following = it
      invalidate()
    }
  private val manager = context.getCarService(NavigationManager::class.java)
  private val positions = CarPositionFeed(context) { surface.position(it) }
  private val observer: () -> Unit = {
    updateNavigation()
    updatePositions()
    invalidate()
  }

  private fun updatePositions() {
    val wanted = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && CarState.projection == null
    if (!wanted && CarState.projection != null) surface.position(null)
    positions.update(wanted)
  }

  override fun onStart(owner: LifecycleOwner) {
    updatePositions()
  }

  override fun onStop(owner: LifecycleOwner) {
    positions.update(false)
  }

  init {
    lifecycle.addObserver(this)
    context.getCarService(AppManager::class.java).setSurfaceCallback(surface)
    CarState.camera = { action, fields -> surface.camera(action, *fields) }
    manager.setNavigationManagerCallback(
      context.mainExecutor,
      object : NavigationManagerCallback {
        override fun onStopNavigation() {
          CarState.command("stop")
        }

        // NF-7: Play review asks for a simulated drive. The next trip started from the car
        // replays its route from a fixed point in Germany, where the instance has coverage.
        override fun onAutoDriveEnabled() {
          CarState.autoDrive = true
          CarState.command("auto-drive")
          CarState.changed()
        }
      },
    )
    CarState.observers.add(observer)
    CarState.command("attach")
  }

  fun themeChanged() {
    surface.viewport()
    invalidate()
  }

  private fun updateNavigation() {
    val p = CarState.projection
    val active = p != null
    if (active && !navigating) {
      manager.navigationStarted()
      navigating = true
    }
    if (!active && navigating) {
      manager.navigationEnded()
      navigating = false
    }
    if (p != null)
      manager.updateTrip(
        CarTripMapper.trip(carContext, p, carContext.carString(R.string.car_destination))
      )
    GuidanceNotification.update(carContext, p)
  }

  override fun onGetTemplate(): Template {
    val p = CarState.projection
    val mapActions = CarMapActions.zoom(carContext)
    fun mapAction(icon: Int, onClick: () -> Unit) = CarMapActions.action(carContext, icon, onClick)
    if (!following)
      mapActions.addAction(mapAction(R.drawable.car_recenter) { surface.camera("recenter") })
    else if (p != null)
      mapActions.addAction(mapAction(R.drawable.car_overview) { surface.camera("overview") })
    // Android Auto draws its own end-trip X on the arrival card and reports it through
    // onStopNavigation, so the strip carries no Stop of its own.
    val actions =
      ActionStrip.Builder()
        .addAction(
          Action.Builder()
            .setTitle(carContext.carString(R.string.car_destinations))
            // Persistent like the map controls: search stays one tap away, as in other car maps.
            .setFlags(Action.FLAG_IS_PERSISTENT)
            .setOnClickListener { screenManager.push(DestinationsScreen(carContext)) }
            .build()
        )
    if (p != null && carContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      actions.addAction(
        Action.Builder()
          .setTitle(carContext.carString(R.string.car_test_drive))
          .setOnClickListener { CarState.command("simulate") }
          .build()
      )
    }
    val builder =
      NavigationTemplate.Builder()
        .setActionStrip(actions.build())
        .setMapActionStrip(mapActions.build())
    if (p != null) {
      builder.setNavigationInfo(
        if (p.optBoolean("rerouting")) RoutingInfo.Builder().setLoading(true).build()
        else
          RoutingInfo.Builder()
            .setCurrentStep(
              CarTripMapper.step(carContext, p),
              CarTripMapper.distance(p.optDouble("distanceToManeuver")),
            )
            .build()
      )
      builder.setDestinationTravelEstimate(CarTripMapper.estimate(p))
    }
    return builder.build()
  }

  override fun onDestroy(owner: LifecycleOwner) {
    CarState.connected = false
    GuidanceNotification.update(carContext, null)
    CarState.command("detach")
    carContext.stopService(Intent(carContext, CarRuntimeService::class.java))
    CarState.observers.remove(observer)
    positions.update(false)
    CarState.camera = null
    surface.dispose()
    carContext.getCarService(AppManager::class.java).setSurfaceCallback(null)
    if (navigating) manager.navigationEnded()
  }
}

/** Map controls shared by the map screen and the route preview. */
object CarMapActions {
  // Persistent, so zoom stays on screen instead of hiding after 10 seconds.
  fun action(context: CarContext, icon: Int, onClick: () -> Unit): Action =
    Action.Builder()
      .setIcon(context.carIcon(icon))
      .setFlags(Action.FLAG_IS_PERSISTENT)
      .setOnClickListener(onClick)
      .build()

  fun zoom(context: CarContext): ActionStrip.Builder =
    ActionStrip.Builder()
      .addAction(Action.PAN)
      .addAction(action(context, R.drawable.car_zoom_in) { CarState.camera?.invoke("zoom", arrayOf("factor" to 2)) })
      .addAction(action(context, R.drawable.car_zoom_out) { CarState.camera?.invoke("zoom", arrayOf("factor" to 0.5)) })
}
