package org.openmapx.androidauto

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** RN 0.86's base class starts the application's ReactHost in bridgeless mode. */
class CarRuntimeService : HeadlessJsTaskService() {
  override fun onDestroy() {
    CarState.command("detach")
    super.onDestroy()
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? =
    if (!CarState.connected) null
    else HeadlessJsTaskConfig("OpenMapXCarRuntime", Arguments.createMap(), 0, true)
}
