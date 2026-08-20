package icu.bonfire.screener.sender

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Bundle
import android.os.IBinder
import android.os.ResultReceiver
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ProjectionService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val stopping = AtomicBoolean()
    private var receiver: ResultReceiver? = null
    private var capture: CaptureEngine? = null
    private var session: RemoteSession? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            finish("Sharing stopped")
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_START || session != null || stopping.get()) return START_NOT_STICKY
        receiver = intent.getParcelableExtra(EXTRA_RECEIVER, ResultReceiver::class.java)
        startForeground(
            NOTIFICATION_ID,
            notification("Starting screen sharing"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
        )
        val server = intent.getStringExtra(EXTRA_SERVER_URL)
        val password = intent.getStringExtra(EXTRA_SITE_PASSWORD)
        val permission = intent.getParcelableExtra(EXTRA_PERMISSION_DATA, Intent::class.java)
        if (server == null || password == null || permission == null) {
            finish("Screen sharing could not start")
            return START_NOT_STICKY
        }
        sendResult(RESULT_ACTIVE, "Starting")
        worker.execute {
            try {
                val engine = CaptureEngine(applicationContext, permission) {
                    finish("The system stopped screen sharing")
                }
                if (stopping.get()) {
                    engine.close()
                    return@execute
                }
                capture = engine
                val remote = RemoteSession(server, password, engine.factory, engine.track, worker, object : RemoteSession.Events {
                    override fun onRoom(inviteUrl: String) {
                        sendResult(RESULT_ACTIVE, "Sharing 720p30 with hardware ${engine.codecs}", inviteUrl)
                        getSystemService(NotificationManager::class.java)
                            .notify(NOTIFICATION_ID, notification("Screen sharing is active"))
                    }

                    override fun onStatus(message: String) = sendResult(RESULT_ACTIVE, message)
                    override fun onFatal(message: String) = finish(message)
                })
                session = remote
                remote.start()
            } catch (_: Exception) {
                finish("Screen sharing could not start")
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        session?.close()
        capture?.close()
        worker.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun finish(message: String) {
        if (!stopping.compareAndSet(false, true)) return
        sendResult(RESULT_STOPPED, message)
        worker.execute {
            session?.close()
            session = null
            capture?.close()
            capture = null
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun sendResult(code: Int, status: String, invite: String? = null) {
        receiver?.send(code, Bundle().apply {
            putString(RESULT_STATUS, status)
            invite?.let { putString(RESULT_INVITE, it) }
        })
    }

    private fun notification(text: String): Notification {
        val activity = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Screener Sender")
            .setContentText(text)
            .setContentIntent(activity)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_START = "icu.bonfire.screener.sender.START"
        const val ACTION_STOP = "icu.bonfire.screener.sender.STOP"
        const val EXTRA_SERVER_URL = "serverUrl"
        const val EXTRA_SITE_PASSWORD = "sitePassword"
        const val EXTRA_PERMISSION_DATA = "projectionPermission"
        const val EXTRA_RECEIVER = "receiver"
        const val RESULT_STATUS = "status"
        const val RESULT_INVITE = "invite"
        const val RESULT_STOPPED = 0
        const val RESULT_ACTIVE = 1
        private const val CHANNEL_ID = "screen-sharing"
        private const val NOTIFICATION_ID = 70
    }
}
