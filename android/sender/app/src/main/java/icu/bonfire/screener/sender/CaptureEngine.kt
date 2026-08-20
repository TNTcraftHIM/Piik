package icu.bonfire.screener.sender

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.HardwareVideoEncoderFactory
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoEncoder
import org.webrtc.VideoEncoderFactory
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.atomic.AtomicBoolean

class CaptureEngine private constructor(
    context: Context,
    permissionData: Intent,
    onProjectionStopped: () -> Unit,
) : AutoCloseable {
    private lateinit var egl: EglBase
    lateinit var factory: PeerConnectionFactory
        private set
    lateinit var track: VideoTrack
        private set
    private lateinit var capturer: ScreenCapturerAndroid
    private lateinit var source: VideoSource
    private lateinit var helper: SurfaceTextureHelper
    private var closed = false

    init {
        try {
            initializeOnce(context)
            egl = EglBase.create()
            val encoderFactory = HardwareOnlyEncoderFactory(egl.eglBaseContext)
            if (encoderFactory.supportedCodecs.isEmpty()) error("No hardware VP8/H264 encoder is available")
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
            source = factory.createVideoSource(true)
            helper = SurfaceTextureHelper.create("ScreenerCapture", egl.eglBaseContext)
            capturer = ScreenCapturerAndroid(permissionData, object : MediaProjection.Callback() {
                override fun onStop() = onProjectionStopped()
            })
            capturer.initialize(helper, context.applicationContext, source.capturerObserver)
            capturer.startCapture(WIDTH, HEIGHT, FPS)
            track = factory.createVideoTrack("screener-screen", source)
            track.setEnabled(true)
        } catch (error: Throwable) {
            release()
            throw error
        }
    }

    override fun close() = release()

    private fun release() {
        if (closed) return
        closed = true
        if (::capturer.isInitialized) runCatching { capturer.stopCapture() }
        if (::capturer.isInitialized) runCatching { capturer.dispose() }
        if (::track.isInitialized) runCatching { track.dispose() }
        if (::source.isInitialized) runCatching { source.dispose() }
        if (::helper.isInitialized) runCatching { helper.dispose() }
        if (::factory.isInitialized) runCatching { factory.dispose() }
        if (::egl.isInitialized) runCatching { egl.release() }
    }

    private class HardwareOnlyEncoderFactory(context: EglBase.Context) : VideoEncoderFactory {
        private val delegate = HardwareVideoEncoderFactory(context, true, true)
        override fun createEncoder(info: VideoCodecInfo): VideoEncoder? =
            if (allowed(info)) delegate.createEncoder(info) else null

        override fun getSupportedCodecs(): Array<VideoCodecInfo> =
            delegate.supportedCodecs.filter(::allowed).toTypedArray()

        private fun allowed(info: VideoCodecInfo): Boolean =
            info.name.equals("VP8", true) || info.name.equals("H264", true)
    }

    companion object {
        const val WIDTH = 1280
        const val HEIGHT = 720
        const val FPS = 30
        private val initialized = AtomicBoolean()

        fun create(context: Context, permissionData: Intent, onProjectionStopped: () -> Unit) =
            CaptureEngine(context, permissionData, onProjectionStopped)

        private fun initializeOnce(context: Context) {
            if (initialized.compareAndSet(false, true)) {
                try {
                    PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                            .createInitializationOptions(),
                    )
                } catch (error: Throwable) {
                    initialized.set(false)
                    throw error
                }
            }
        }
    }
}
