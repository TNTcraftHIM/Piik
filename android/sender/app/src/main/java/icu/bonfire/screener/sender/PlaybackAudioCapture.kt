package icu.bonfire.screener.sender

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.SystemClock
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class PlaybackAudioCapture(
    private val targetUid: Int,
    private val onUnavailable: () -> Unit,
) : JavaAudioDeviceModule.AudioBufferCallback, AutoCloseable {
    private val record = AtomicReference<AudioRecord?>()
    private val closed = AtomicBoolean()
    private val unavailable = AtomicBoolean()

    fun start(projection: MediaProjection): Boolean {
        if (closed.get()) return false
        val created = try {
            val configuration = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUid(targetUid)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .build()
            val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_MASK, AUDIO_FORMAT)
            if (minimum <= 0) return fail()
            AudioRecord.Builder()
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AUDIO_FORMAT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(CHANNEL_MASK)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minimum * 2, FRAME_BYTES))
                .setAudioPlaybackCaptureConfig(configuration)
                .build()
        } catch (_: Exception) {
            return fail()
        }
        try {
            created.startRecording()
            if (created.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                created.release()
                return fail()
            }
        } catch (_: Exception) {
            created.release()
            return fail()
        }
        if (closed.get() || !record.compareAndSet(null, created)) {
            runCatching { created.stop() }
            created.release()
            return false
        }
        return true
    }

    override fun onBuffer(
        buffer: ByteBuffer,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
        bytesRead: Int,
        captureTimeNs: Long,
    ): Long {
        if (
            audioFormat != AUDIO_FORMAT || channelCount != CHANNEL_COUNT ||
            sampleRate != SAMPLE_RATE || buffer.capacity() != FRAME_BYTES
        ) {
            fail()
            silence(buffer)
            return 0L
        }
        val active = record.get()
        if (active == null) {
            SystemClock.sleep(FRAME_DURATION_MS)
            silence(buffer)
            return 0L
        }
        buffer.clear()
        val read = try {
            active.read(buffer, buffer.capacity(), AudioRecord.READ_BLOCKING)
        } catch (_: Exception) {
            AudioRecord.ERROR_INVALID_OPERATION
        }
        if (read != buffer.capacity()) {
            SystemClock.sleep(FRAME_DURATION_MS)
            silence(buffer)
            if (read < 0) fail()
        }
        buffer.clear()
        return 0L
    }

    override fun close() {
        closed.set(true)
        record.getAndSet(null)?.let {
            runCatching { it.stop() }
            it.release()
        }
    }

    private fun fail(): Boolean {
        close()
        if (unavailable.compareAndSet(false, true)) onUnavailable()
        return false
    }

    private fun silence(buffer: ByteBuffer) {
        buffer.clear()
        while (buffer.hasRemaining()) buffer.put(0)
        buffer.clear()
    }

    companion object {
        const val SAMPLE_RATE = 48_000
        private const val CHANNEL_COUNT = 1
        private const val CHANNEL_MASK = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val FRAME_BYTES = SAMPLE_RATE / 100 * CHANNEL_COUNT * 2
        private const val FRAME_DURATION_MS = 10L
    }
}
