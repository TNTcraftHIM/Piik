package icu.bonfire.screener.sender

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var serverUrl: EditText
    private lateinit var sitePassword: EditText
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var audioTarget: Spinner
    private lateinit var statusText: TextView
    private lateinit var inviteText: TextView
    private var pendingServer = ""
    private var pendingPassword = ""
    private var pendingAudioUid: Int? = null
    private var pendingAudioName: String? = null

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
        audioTarget = findViewById(R.id.audio_target)
        statusText = findViewById(R.id.status_text)
        inviteText = findViewById(R.id.invite_text)

        audioTarget.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_item,
            loadAudioTargets(),
        ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

        startButton.setOnClickListener { prepareProjection() }
        stopButton.setOnClickListener {
            startService(Intent(this, ProjectionService::class.java).setAction(ProjectionService.ACTION_STOP))
            clearInvite()
            statusText.text = "Stopping"
        }
    }

    private fun prepareProjection() {
        pendingServer = serverUrl.text.toString().trim().trimEnd('/')
        pendingPassword = sitePassword.text.toString()
        val target = audioTarget.selectedItem as AudioTarget
        pendingAudioUid = target.uid
        pendingAudioName = target.packageName?.let { target.label }
        clearInvite()
        if (!pendingServer.startsWith("https://")) {
            statusText.text = "An HTTPS server URL is required"
            return
        }
        if (
            pendingAudioUid != null &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        requestProjection()
    }

    private fun requestProjection() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_PROJECTION)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_AUDIO) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            requestProjection()
        } else {
            statusText.text = "Playback audio permission was denied"
        }
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
            pendingAudioUid?.let { putExtra(ProjectionService.EXTRA_AUDIO_TARGET_UID, it) }
            pendingAudioName?.let { putExtra(ProjectionService.EXTRA_AUDIO_TARGET_NAME, it) }
        }
        startForegroundService(service)
        sitePassword.text.clear()
        pendingPassword = ""
    }

    private fun loadAudioTargets(): List<AudioTarget> {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val targets = packageManager.queryIntentActivities(
            launcher,
            PackageManager.ResolveInfoFlags.of(0L),
        ).mapNotNull { resolved ->
            val app = resolved.activityInfo?.applicationInfo ?: return@mapNotNull null
            if (app.uid == applicationInfo.uid) return@mapNotNull null
            val packages = packageManager.getPackagesForUid(app.uid)?.distinct()
            if (packages?.singleOrNull() != app.packageName) return@mapNotNull null
            val label = app.loadLabel(packageManager).toString().trim().ifEmpty { app.packageName }
            AudioTarget(label, app.packageName, app.uid)
        }.distinctBy { it.uid }.sortedBy { it.label.lowercase() }
        return listOf(AudioTarget("Off (video only)", null, null)) + targets
    }

    private fun clearInvite() {
        inviteText.text = ""
        inviteText.setOnClickListener(null)
    }

    companion object {
        private const val REQUEST_PROJECTION = 40
        private const val REQUEST_AUDIO = 41
    }

    private data class AudioTarget(val label: String, val packageName: String?, val uid: Int?) {
        override fun toString(): String = packageName?.let { "$label ($it)" } ?: label
    }
}
