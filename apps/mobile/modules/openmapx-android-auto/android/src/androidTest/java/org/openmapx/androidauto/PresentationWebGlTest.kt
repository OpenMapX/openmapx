package org.openmapx.androidauto

import android.app.Presentation
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.media.ImageReader
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Device-only WP-N0 renderer proof. A JVM WebView cannot establish GPU rendering. */
@RunWith(AndroidJUnit4::class)
class PresentationWebGlTest {
  @Test
  fun mapLibreRendersAfterVirtualDisplayRecreationWithoutActivity() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    repeat(2) {
      val loaded = CountDownLatch(1)
      var presentation: Presentation? = null
      var web: WebView? = null
      var display: android.hardware.display.VirtualDisplay? = null
      val reader = ImageReader.newInstance(800, 480, PixelFormat.RGBA_8888, 3)
      try {
        instrumentation.runOnMainSync {
          val context = instrumentation.targetContext
          display =
            context
              .getSystemService(DisplayManager::class.java)
              .createVirtualDisplay("car-proof", 800, 480, 160, reader.surface, 0)
          presentation =
            Presentation(context, display!!.display).also { p ->
              p.window!!.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)
              web =
                WebView(p.context).also { view ->
                  view.settings.javaScriptEnabled = true
                  view.settings.allowFileAccess = true
                  view.webChromeClient =
                    object : WebChromeClient() {
                      override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                        if (message.message() == "CAR_WEBGL_RENDERED") loaded.countDown()
                        android.util.Log.i("CarWebGlProof", message.message())
                        return true
                      }
                    }
                  p.setContentView(view)
                }
              p.show()
            }
          web!!.loadDataWithBaseURL(
            "file:///android_asset/",
            """
            <html><body style="margin:0"><div id="map" style="width:800px;height:480px"></div>
            <script src="maplibre-gl.js"></script><script>
            const map = new maplibregl.Map({container:'map',attributionControl:false,
              style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#00ff00'}}]}});
            map.once('render',()=>console.log('CAR_WEBGL_RENDERED'));
            </script></body></html>
          """
              .trimIndent(),
            "text/html",
            "utf-8",
            null,
          )
        }
        assertTrue(
          "MapLibre WebGL render event on iteration $it",
          loaded.await(45, TimeUnit.SECONDS),
        )
        // This asserts actual Surface output as well as JS/WebGL startup.
        var colored = false
        val deadline = System.currentTimeMillis() + 10000
        while (!colored && System.currentTimeMillis() < deadline) {
          val image = reader.acquireLatestImage()
          if (image != null) {
            val buffer = image.planes[0].buffer
            val offset = 240 * image.planes[0].rowStride + 400 * image.planes[0].pixelStride
            colored = (buffer.get(offset + 1).toInt() and 255) > 200
            image.close()
          }
          if (!colored) Thread.sleep(100)
        }
        assertTrue(
          "Green WebGL pixels reached the virtual-display Surface on iteration $it",
          colored,
        )
      } finally {
        instrumentation.runOnMainSync {
          presentation?.dismiss()
          web?.destroy()
          display?.release()
        }
        reader.close()
      }
    }
  }
}
