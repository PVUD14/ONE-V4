package pro.ai8ht.one

// What the phone itself does for growth field staff (GROWTH-06; design §14.1, §14.3):
//
//  - Follow-up reminders: a local notification at 09:00 on the morning a follow-up is due,
//    scheduled on the device with AlarmManager. No server push, and no text leaves the phone. Only
//    the organisation's name is shown (the follow-up's own words may be more than a lock screen
//    should carry). Cancelled and rescheduled whenever the follow-ups are read, and all cancelled at
//    sign-out.
//  - Visit location: read once, when the person taps "Attach my location", with the foreground
//    coarse permission only. Never in the background, never at any other moment. Rounded to 3
//    decimal places (about 100 m) before it is queued; the server and the database round again.

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Looper
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.roundToInt

internal object GrowthReminders {
    const val CHANNEL_ID = "growth_follow_ups"
    private const val PREFS = "one-growth-device"
    private const val SCHEDULED = "scheduled_reminders"
    private const val EXTRA_LEAD = "lead_name"
    private const val MAX_SCHEDULED = 60
    private val REMINDER_TIME: LocalTime = LocalTime.of(9, 0)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Follow-up reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A reminder on the morning a growth follow-up is due."
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
    }

    fun notificationsAllowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun pendingIntent(context: Context, followUpId: String, leadName: String?): PendingIntent {
        val intent = Intent(context, GrowthReminderReceiver::class.java).apply {
            action = "pro.ai8ht.one.GROWTH_FOLLOW_UP_DUE"
            // A distinct data URI keeps each follow-up's alarm separate.
            data = android.net.Uri.parse("one-growth-follow-up://$followUpId")
            if (leadName != null) putExtra(EXTRA_LEAD, leadName)
        }
        return PendingIntent.getBroadcast(context, followUpId.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Replaces every scheduled reminder with one per open follow-up of mine whose 09:00 is still ahead. */
    fun resync(context: Context, followUps: List<GrowthFollowUpDto>) {
        ensureChannel(context)
        cancelAll(context)
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val zone = ZoneId.systemDefault()
        val now = System.currentTimeMillis()
        val scheduled = mutableSetOf<String>()
        followUps.filter { it.state == "OPEN" && it.assignee.isMe }.forEach { followUp ->
            if (scheduled.size >= MAX_SCHEDULED) return@forEach
            val due = runCatching { LocalDate.parse(followUp.dueOn) }.getOrNull() ?: return@forEach
            val at = due.atTime(REMINDER_TIME).atZone(zone).toInstant().toEpochMilli()
            if (at <= now) return@forEach
            // Inexact on purpose: a morning reminder needs no exact-alarm permission.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pendingIntent(context, followUp.id, followUp.leadName))
            scheduled += followUp.id
        }
        prefs(context).edit().putStringSet(SCHEDULED, scheduled).apply()
    }

    fun cancelAll(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        prefs(context).getStringSet(SCHEDULED, emptySet()).orEmpty().forEach { id -> alarms?.cancel(pendingIntent(context, id, null)) }
        prefs(context).edit().remove(SCHEDULED).apply()
    }

    internal fun leadNameFrom(intent: Intent): String? = intent.getStringExtra(EXTRA_LEAD)

    // --- Location notice acknowledgement (cleared at sign-out with the rest) -------------------
    fun locationNoticeSeen(context: Context): String? = prefs(context).getString("location_notice_seen", null)
    fun setLocationNoticeSeen(context: Context, version: String) { prefs(context).edit().putString("location_notice_seen", version).apply() }

    /** Sign-out: no reminder, acknowledgement or schedule outlives the session. */
    fun clearForSignOut(context: Context) {
        cancelAll(context)
        prefs(context).edit().clear().apply()
        context.getSystemService(NotificationManager::class.java)?.cancelAll()
    }
}

/** Posts the morning reminder. Registered in the manifest, not exported. */
class GrowthReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!GrowthReminders.notificationsAllowed(context)) return
        GrowthReminders.ensureChannel(context)
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE)
        val leadName = GrowthReminders.leadNameFrom(intent)
        val notification = Notification.Builder(context, GrowthReminders.CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle("Follow-up due today")
            .setContentText(leadName?.let { "$it — open Field in ONE" } ?: "Open Field in ONE")
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)?.notify(intent.data?.toString()?.hashCode() ?: 0, notification)
    }
}

internal data class CoarseFix(val latitude: Double, val longitude: Double, val accuracyM: Int)

internal object GrowthLocation {
    fun permitted(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** About 100 m: three decimal places, half away from zero (as the server and Postgres round). */
    fun round3(value: Double): Double = Math.signum(value) * (abs(value) * 1000.0).roundToInt() / 1000.0

    /**
     * One approximate fix, read now, or null when none arrives within 20 seconds. Only called from
     * the "Attach my location" tap, after the permission was granted.
     */
    @SuppressLint("MissingPermission")
    suspend fun current(context: Context): CoarseFix? {
        if (!permitted(context)) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null
        // Coarse permission only. Up to Android 11 that means the network provider (GPS needs fine
        // location, which this app never asks for). From Android 12 the system itself coarsens every
        // provider for an app holding only approximate permission, so fused, network and then GPS are
        // tried in turn — a phone without Google location services still gets an approximate fix.
        val candidates = if (Build.VERSION.SDK_INT >= 31) {
            listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER)
        }
        val enabled = candidates.filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        var location: Location? = null
        for (provider in enabled) {
            location = runCatching { withTimeoutOrNull(10_000) { oneFix(context, manager, provider) } }.getOrNull()
            if (location != null) break
        }
        return location?.let { CoarseFix(round3(it.latitude), round3(it.longitude), it.accuracy.roundToInt().coerceIn(0, 50_000)) }
    }

    @SuppressLint("MissingPermission")
    private suspend fun oneFix(context: Context, manager: LocationManager, provider: String): Location? = suspendCancellableCoroutine { continuation ->
        if (Build.VERSION.SDK_INT >= 30) {
            val cancel = CancellationSignal()
            continuation.invokeOnCancellation { cancel.cancel() }
            manager.getCurrentLocation(provider, cancel, context.mainExecutor) { fix -> if (continuation.isActive) continuation.resume(fix) }
        } else {
            val listener = object : android.location.LocationListener {
                override fun onLocationChanged(fix: Location) { if (continuation.isActive) continuation.resume(fix) }
                @Deprecated("Required on API < 29") override fun onStatusChanged(p: String?, s: Int, b: android.os.Bundle?) {}
                override fun onProviderEnabled(p: String) {}
                override fun onProviderDisabled(p: String) {}
            }
            continuation.invokeOnCancellation { manager.removeUpdates(listener) }
            @Suppress("DEPRECATION")
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        }
    }
}
