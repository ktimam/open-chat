package com.ocplugin.app.privateapps

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.ocplugin.app.R
import com.ocplugin.app.isUnofficialLocalTest

/** Keeps only approved native loopback attempts runnable while their browser is foreground. */
class LocalAppTransferService : Service() {
    private var foreground = false
    private val expiry = Runnable { expireOwners() }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() { super.onCreate(); instance = this }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val owner = intent?.getStringExtra(EXTRA_OWNER)
        if (!isUnofficialLocalTest(this) || intent?.action != ACTION_START || owner == null ||
            !pending.containsKey(owner) || !policy.active(owner, SystemClock.elapsedRealtime())) {
            owner?.let { failOwner(it) }
            if (policy.remaining(SystemClock.elapsedRealtime()) == null) stopNow()
            return START_NOT_STICKY
        }
        try {
            if (!foreground) {
                ensureChannel()
                val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                    this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                val returnToApp = launch?.let { PendingIntent.getActivity(this, NOTIFICATION_ID, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
                val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification_small)
                    .setContentTitle("Private app transfer")
                    .setContentText("An approved local connection is active. Open the app to review or cancel.")
                    .setContentIntent(returnToApp)
                    .setPriority(NotificationCompat.PRIORITY_LOW).setOngoing(true).setSilent(true)
                    .setVisibility(NotificationCompat.VISIBILITY_SECRET).build()
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
                foreground = true
            }
            // A queued start is not an acknowledgment: only foreground establishment is.
            pending.remove(owner)?.invoke(true)
            expireOwners()
        } catch (_: Exception) { stopNow() }
        return START_NOT_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Private app transfers", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null); enableVibration(false); setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            })
    }

    private fun expireOwners() {
        main.removeCallbacks(expiry)
        val now = SystemClock.elapsedRealtime()
        pending.keys.toList().filter { !policy.active(it, now) }.forEach { failOwner(it) }
        val remaining = policy.remaining(now)
        if (remaining == null) stopNow() else main.postDelayed(expiry, minOf(remaining, 1_000L))
    }

    private fun stopNow() {
        main.removeCallbacks(expiry)
        // A delayed destroy from an older service must not touch a replacement's notification.
        if (instance !== this) { foreground = false; return }
        instance = null; stoppingInstance = this; policy.clear()
        val callbacks = pending.values.toList(); pending.clear(); callbacks.forEach { it(false) }
        foreground = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    override fun onTimeout(startId: Int, fgsType: Int) { stopNow() }
    override fun onTaskRemoved(rootIntent: Intent?) { stopNow(); super.onTaskRemoved(rootIntent) }
    override fun onDestroy() {
        stopNow()
        if (stoppingInstance === this) stoppingInstance = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "oc_private_app_transfer"
        private const val NOTIFICATION_ID = 0x0C_A990
        private const val ACTION_START = "com.ocplugin.app.PRIVATE_TRANSFER_START"
        private const val EXTRA_OWNER = "owner"
        private val main = Handler(Looper.getMainLooper())
        private val policy = LocalAppLeasePolicy()
        private val pending = mutableMapOf<String, (Boolean) -> Unit>()
        private var instance: LocalAppTransferService? = null
        private var stoppingInstance: LocalAppTransferService? = null
        private fun failOwner(owner: String) { policy.release(owner); pending.remove(owner)?.invoke(false) }

        fun start(activity: Activity, owner: String, remainingMs: Long, result: (Boolean) -> Unit) {
            activity.runOnUiThread {
                if (!isUnofficialLocalTest(activity) || stoppingInstance != null || activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus() ||
                    !policy.start(owner, SystemClock.elapsedRealtime(), remainingMs)) { result(false); return@runOnUiThread }
                pending[owner] = result
                val service = instance
                if (service?.foreground == true) {
                    pending.remove(owner)?.invoke(true); service.expireOwners()
                } else {
                    try {
                        ContextCompat.startForegroundService(activity, Intent(activity, LocalAppTransferService::class.java)
                            .setAction(ACTION_START).putExtra(EXTRA_OWNER, owner))
                        main.postDelayed({
                            if (pending.containsKey(owner)) { failOwner(owner); instance?.expireOwners() }
                        }, 3_000L)
                    } catch (_: Exception) { failOwner(owner); instance?.expireOwners() }
                }
            }
        }
        fun extend(owner: String, remainingMs: Long): Boolean {
            val service = instance ?: return false
            if (!service.foreground || !policy.extend(owner, SystemClock.elapsedRealtime(), remainingMs)) return false
            service.expireOwners(); return true
        }
        fun active(owner: String): Boolean = instance?.foreground == true && policy.active(owner, SystemClock.elapsedRealtime())
        fun release(owner: String) { failOwner(owner); instance?.expireOwners() }
    }
}
