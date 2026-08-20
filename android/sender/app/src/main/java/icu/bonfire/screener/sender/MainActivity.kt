package icu.bonfire.screener.sender

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var serverUrl: EditText
    private lateinit var sitePassword: EditText
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var statusText: TextView
    private lateinit var inviteText: TextView
    private var pendingServer = ""
    private var pendingPassword = ""

    private val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
        override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
            statusText.text = resultData?.getString(ProjectionService.RESULT_STATUS) ?: "Sharing stopped"
            resultData?.getString(ProjectionService.RESULT_INVITE)?.let {
                inviteText.text = it
                inviteText.setOnClickListener { _ ->
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(
                        android.content.ClipData.newPlainText("Screener invite", it),
                    )
                }
            }
            val active = resultCode == ProjectionService.RESULT_ACTIVE
            startButton.isEnabled = !active
            stopButton.isEnabled = active
            if (!active) clearInvite()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        serverUrl = findViewById(R.id.server_url)
        sitePassword = findViewById(R.id.site_password)
        startButton = findViewById(R.id.start_button)
        stopButton = findViewById(R.id.stop_button)
        statusText = findViewById(R.id.status_text)
        inviteText = findViewById(R.id.invite_text)

        startButton.setOnClickListener { requestProjection() }
        stopButton.setOnClickListener {
            startService(Intent(this, ProjectionService::class.java).setAction(ProjectionService.ACTION_STOP))
            clearInvite()
            statusText.text = "Stopping"
        }
    }

    private fun requestProjection() {
        pendingServer = serverUrl.text.toString().trim().trimEnd('/')
        pendingPassword = sitePassword.text.toString()
        clearInvite()
        if (!pendingServer.startsWith("https://")) {
            statusText.text = "An HTTPS server URL is required"
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_PROJECTION)
    }

    @Deprecated("The platform projection picker still returns through this callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PROJECTION) return
        if (resultCode != RESULT_OK || data == null) {
            statusText.text = "Screen sharing was cancelled"
            return
        }
        startButton.isEnabled = false
        stopButton.isEnabled = true
        statusText.text = "Starting"
        val service = Intent(this, ProjectionService::class.java).apply {
            action = ProjectionService.ACTION_START
            putExtra(ProjectionService.EXTRA_SERVER_URL, pendingServer)
            putExtra(ProjectionService.EXTRA_SITE_PASSWORD, pendingPassword)
            putExtra(ProjectionService.EXTRA_PERMISSION_DATA, data)
            putExtra(ProjectionService.EXTRA_RECEIVER, receiver)
        }
        startForegroundService(service)
        sitePassword.text.clear()
        pendingPassword = ""
    }

    private fun clearInvite() {
        inviteText.text = ""
        inviteText.setOnClickListener(null)
    }

    companion object {
        private const val REQUEST_PROJECTION = 40
    }
}
