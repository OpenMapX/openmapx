package expo.modules.openmapxintake

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class IntakePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context) = listOf(object : ReactActivityLifecycleListener {
    private fun receive(activity: Activity?, intent: Intent, state: Bundle?) {
      if (!IncomingIntent.shouldCapture(intent, state)) return
      IntakeIngress.capture(activityContext, Intent(intent))
      activity?.intent = Intent(Intent.ACTION_MAIN).setPackage(activityContext.packageName)
    }
    override fun onCreate(activity: Activity, savedInstanceState: Bundle?) { receive(activity, activity.intent, savedInstanceState) }
    override fun onNewIntent(intent: Intent): Boolean { receive(activityContext as? Activity, intent, null); return false }
  })
}
