import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  type NotificationScheduler,
  planReconciliation,
  type ReconcileResult,
  type ScheduledNotification,
} from "./NotificationScheduler";
import { isOpenMapXNotificationId } from "./notificationIds";

/**
 * `expo-notifications`, restricted to local scheduling.
 *
 * No push token is requested and no remote credential is configured; the module
 * is used purely as a wrapper around the platforms' local alarm APIs.
 */

export const ANDROID_NAVIGATION_CHANNEL = "openmapx-navigation-alerts";

export class ExpoNotificationScheduler implements NotificationScheduler {
  private prepared = false;

  async prepare(): Promise<void> {
    if (this.prepared || Platform.OS !== "android") {
      this.prepared = true;
      return;
    }
    await Notifications.setNotificationChannelAsync(ANDROID_NAVIGATION_CHANNEL, {
      name: "Navigation alerts",
      importance: Notifications.AndroidImportance.HIGH,
      // A vibration pattern matters here: an alighting alert is often felt
      // rather than seen, because the phone is in a pocket.
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      showBadge: false,
    });
    this.prepared = true;
  }

  private async schedule(request: ScheduledNotification, interruption: boolean): Promise<void> {
    await this.prepare();
    await Notifications.scheduleNotificationAsync({
      identifier: request.id,
      content: {
        title: request.title,
        body: request.body,
        sound: true,
        ...(Platform.OS === "android" ? { channelId: ANDROID_NAVIGATION_CHANNEL } : {}),
        ...(interruption && Platform.OS === "ios"
          ? { interruptionLevel: "timeSensitive" as const }
          : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(request.triggerAtMs),
      },
    });
  }

  scheduleAlight(request: ScheduledNotification): Promise<void> {
    return this.schedule(request, false);
  }

  scheduleCriticalInterruption(request: ScheduledNotification): Promise<void> {
    // Time-sensitive, not "critical": a genuine critical alert needs an Apple
    // entitlement this app has no grounds to request.
    return this.schedule(request, true);
  }

  async cancel(id: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(id);
  }

  async cancelSession(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.cancel(id);
  }

  async pending(): Promise<string[]> {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return scheduled.map((entry) => entry.identifier);
  }

  async reconcile(records: readonly ScheduledNotification[]): Promise<ReconcileResult> {
    const { toSchedule, toCancel, orphans } = planReconciliation(
      records,
      await this.pending(),
      isOpenMapXNotificationId,
    );

    for (const id of toCancel) await this.cancel(id);
    for (const record of toSchedule) {
      await this.schedule(record, record.category === "critical");
    }
    return { scheduled: toSchedule.length, cancelled: toCancel.length, orphans: orphans.length };
  }
}
