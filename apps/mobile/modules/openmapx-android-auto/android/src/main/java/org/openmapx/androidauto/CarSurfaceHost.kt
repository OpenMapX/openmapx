package org.openmapx.androidauto

import android.app.Presentation
import android.content.Context
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** Views use the virtual display context; no Activity or phone WebView is involved. */
class CarSurfaceHost(private val context: CarContext, private val following: (Boolean) -> Unit) :
  SurfaceCallback {
  private var display: VirtualDisplay? = null
  private var presentation: Presentation? = null
  private var web: WebView? = null
  private var reply: JavaScriptReplyProxy? = null
  private var container: SurfaceContainer? = null
  private var stable = Rect()
  private var visible = Rect()
  private var lastPreview: JSONObject? = null
  private var lastSnapshot: JSONObject? = null
  private val observer: () -> Unit = { sync() }

  init {
    CarState.observers.add(observer)
  }

  private var retries = 0
  private val handler = android.os.Handler(Looper.getMainLooper())

  private fun recover(code: String) {
    val current = container ?: return
    android.util.Log.w("OpenMapXCar", "renderer recovery: $code attempt=$retries")
    if (retries >= 3) {
      release()
      return
    }
    retries += 1
    release()
    handler.postDelayed({ if (CarState.connected) onSurfaceAvailable(current) }, retries * 500L)
  }

  override fun onSurfaceAvailable(value: SurfaceContainer) {
    handler.removeCallbacksAndMessages(null)
    release()
    container = value
    stable = Rect(0, 0, value.width, value.height)
    visible = Rect(stable)
    val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    display =
      manager.createVirtualDisplay(
        "OpenMapXCar",
        value.width,
        value.height,
        value.dpi,
        value.surface,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION,
      )
    presentation =
      Presentation(context, display!!.display).also { p ->
        p.window?.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
        web =
          WebView(p.context).also { view ->
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.settings.setGeolocationEnabled(false)
            view.settings.allowFileAccess = false
            view.settings.allowContentAccess = false
            view.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            view.webChromeClient =
              object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                  request.deny()
                }

                override fun onGeolocationPermissionsShowPrompt(
                  origin: String?,
                  callback: GeolocationPermissions.Callback,
                ) {
                  callback.invoke(origin, false, false)
                }
              }
            view.webViewClient =
              object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                  v: WebView,
                  request: WebResourceRequest,
                ): Boolean = !sameOrigin(request.url.toString())

                override fun onRenderProcessGone(
                  v: WebView,
                  detail: RenderProcessGoneDetail,
                ): Boolean {
                  recover("render-process-gone")
                  return true
                }
              }
            p.setContentView(view)
          }
        p.show()
      }
    sync()
  }

  private fun sameOrigin(url: String): Boolean {
    val a = android.net.Uri.parse(url)
    val b = android.net.Uri.parse(CarState.origin ?: return false)
    return a.scheme == b.scheme && a.host == b.host && a.port == b.port
  }

  private var loadedOrigin: String? = null

  private fun sync() {
    check(Looper.myLooper() == Looper.getMainLooper())
    val view = web ?: return
    val origin = CarState.origin ?: return
    if (loadedOrigin != origin) {
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
      loadedOrigin = origin
      WebViewCompat.addWebMessageListener(view, "OpenMapXCar", setOf(origin)) {
        _,
        message,
        source,
        main,
        proxy ->
        if (!main || !sameOrigin(source.toString()) || (message.data?.length ?: 0) > 4096)
          return@addWebMessageListener
        val data =
          try {
            JSONObject(message.data ?: "")
          } catch (_: Exception) {
            return@addWebMessageListener
          }
        if (data.optInt("v") != 1) return@addWebMessageListener
        when (data.optString("type")) {
          "car-ready" -> {
            reply = proxy
            send(
              JSONObject()
                .put("v", 1)
                .put("type", "car-hello")
                .put("locale", CarState.locale)
                .put("units", CarState.units)
                .put("dark", context.isDarkMode)
            )
            viewport()
            lastPreview = null
            lastSnapshot = null
            sync()
            CarState.command("attach")
          }
          "car-map-state" -> following(data.optBoolean("following", true))
          "car-error" ->
            when (data.optString("code")) {
              "snapshot-gap" -> CarState.command("attach")
              "style-load-failed",
              "webgl-lost" -> recover(data.optString("code"))
              else -> android.util.Log.w("OpenMapXCar", "car renderer error")
            }
        }
      }
      view.loadUrl("$origin/car")
    }
    if (reply != null && lastPreview !== CarState.preview) {
      send(CarState.preview)
      lastPreview = CarState.preview
    }
    val snapshot = CarState.snapshot
    if (snapshot != null && snapshot !== lastSnapshot) {
      send(JSONObject().put("v", 1).put("type", "car-snapshot").put("message", snapshot))
      lastSnapshot = snapshot
    }
  }

  private fun send(message: JSONObject) {
    reply?.postMessage(message.toString())
  }

  fun camera(action: String, vararg fields: Pair<String, Number>) {
    val message = JSONObject().put("v", 1).put("type", "car-camera").put("action", action)
    fields.forEach { message.put(it.first, it.second) }
    send(message)
  }

  fun viewport() {
    val c = container ?: return
    val d = c.dpi / 160f
    send(
      JSONObject()
        .put("v", 1)
        .put("type", "car-viewport")
        .put("width", c.width / d)
        .put("height", c.height / d)
        .put("stable", CarViewport.insets(stable, c.width, c.height, d))
        .put("visible", CarViewport.insets(visible, c.width, c.height, d))
        .put("dark", context.isDarkMode)
    )
  }

  override fun onStableAreaChanged(area: Rect) {
    stable = Rect(area)
    viewport()
  }

  override fun onVisibleAreaChanged(area: Rect) {
    visible = Rect(area)
    viewport()
  }

  override fun onScroll(dx: Float, dy: Float) {
    val d = (container?.dpi ?: 160) / 160f
    camera("pan", "dx" to dx / d, "dy" to dy / d)
  }

  override fun onFling(vx: Float, vy: Float) {
    val d = (container?.dpi ?: 160) / 160f
    camera("fling", "vx" to vx / d, "vy" to vy / d)
  }

  override fun onScale(x: Float, y: Float, factor: Float) {
    val d = (container?.dpi ?: 160) / 160f
    camera("zoom", "factor" to factor, "x" to x / d, "y" to y / d)
  }

  override fun onSurfaceDestroyed(value: SurfaceContainer) {
    handler.removeCallbacksAndMessages(null)
    release()
  }

  fun release() {
    reply = null
    lastPreview = null
    lastSnapshot = null
    loadedOrigin = null
    presentation?.dismiss()
    presentation = null
    web?.stopLoading()
    web?.destroy()
    web = null
    display?.release()
    display = null
    container = null
  }

  fun dispose() {
    handler.removeCallbacksAndMessages(null)
    release()
    CarState.observers.remove(observer)
  }
}
