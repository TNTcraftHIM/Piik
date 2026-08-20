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

class CaptureEngine(
    context: Context,
    permissionData: Intent,
    onProjectionStopped: () -> Unit,
) : AutoCloseable {
    private val egl = EglBase.create()
    private val encoderFactory = HardwareOnlyEncoderFactory(egl.eglBaseContext)
    val factory: PeerConnectionFactory
    val track: VideoTrack
    val codecs: String
    private val capturer: ScreenCapturerAndroid
    private val source: VideoSource
    private val helper: SurfaceTextureHelper
    private var closed = false

    init {
        initializeOnce(context)
        val supported = encoderFactory.supportedCodecs
        if (supported.isEmpty()) error("No hardware VP8/H264 encoder is available")
        codecs = supported.map { it.name.uppercase() }.distinct().joinToString("/")
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
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { capturer.stopCapture() }
        capturer.dispose()
        track.dispose()
        source.dispose()
        helper.dispose()
        factory.dispose()
        egl.release()
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

        private fun initializeOnce(context: Context) {
            if (initialized.compareAndSet(false, true)) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .createInitializationOptions(),
                )
            }
        }
    }
}
