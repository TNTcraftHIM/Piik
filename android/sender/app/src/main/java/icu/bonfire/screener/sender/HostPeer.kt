package icu.bonfire.screener.sender

import icu.bonfire.screener.protocol.IceConfig
import icu.bonfire.screener.protocol.SignalPayload
import icu.bonfire.screener.protocol.Wire
import icu.bonfire.screener.protocol.IceCandidate as WireCandidate
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.util.concurrent.Executor

class HostPeer(
    private val peerId: String,
    val connectionId: String,
    iceConfig: IceConfig,
    factory: PeerConnectionFactory,
    track: VideoTrack,
    audioTrack: AudioTrack?,
    private val serial: Executor,
    private val send: (String) -> Boolean,
    private val status: (String) -> Unit,
) : AutoCloseable {
    private val pending = ArrayDeque<WireCandidate?>()
    @Volatile
    private var closed = false
    private val connection: PeerConnection

    init {
        val servers = iceConfig.iceServers.map { PeerConnection.IceServer.builder(it.urls).createIceServer() }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        connection = factory.createPeerConnection(config, Observer()) ?: error("Could not create PeerConnection")
        try {
            val sender = connection.addTrack(track, listOf("screener")) ?: error("Could not add screen track")
            sender.parameters.let { parameters ->
                parameters.encodings.forEach { it.maxBitrateBps = 3_000_000 }
                if (!sender.setParameters(parameters)) error("Could not set video bitrate")
            }
            audioTrack?.let {
                connection.addTrack(it, listOf("screener")) ?: error("Could not add playback audio track")
            }
        } catch (error: Throwable) {
            closed = true
            runCatching { connection.dispose() }
            throw error
        }
    }

    fun start() = createOffer(false)

    fun restartIce() {
        if (closed) return
        connection.restartIce()
        createOffer(true)
    }

    fun accept(payload: SignalPayload) {
        if (closed || payload.connectionId != connectionId) return
        when (payload) {
            is SignalPayload.Description -> {
                val description = SessionDescription(SessionDescription.Type.ANSWER, payload.description.sdp)
                connection.setRemoteDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() = dispatch { flushCandidates() }
                    override fun onSetFailure(error: String?) = status("Viewer answer was rejected")
                }, description)
            }
            is SignalPayload.Candidate -> {
                if (connection.remoteDescription == null) {
                    if (pending.size < MAX_PENDING) pending += payload.candidate
                } else {
                    addCandidate(payload.candidate)
                }
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        pending.clear()
        connection.dispose()
    }

    private fun createOffer(restart: Boolean) {
        connection.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription?) {
                if (description == null || closed) return
                connection.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        if (!closed && !send(Wire.description(peerId, connectionId, "offer", description.description))) {
                            status("Signaling is temporarily unavailable")
                        }
                    }
                    override fun onSetFailure(error: String?) = status("Could not apply the screen offer")
                }, description)
            }
            override fun onCreateFailure(error: String?) = status(if (restart) "ICE restart failed" else "Viewer offer failed")
        }, MediaConstraints())
    }

    private fun flushCandidates() {
        while (!closed && pending.isNotEmpty()) addCandidate(pending.removeFirst())
    }

    private fun dispatch(block: () -> Unit) {
        runCatching { serial.execute(block) }
    }

    private fun addCandidate(candidate: WireCandidate?) {
        if (candidate == null) return
        connection.addIceCandidate(
            IceCandidate(candidate.sdpMid ?: "", candidate.sdpMLineIndex ?: 0, candidate.candidate),
        )
    }

    private inner class Observer : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            send(Wire.candidate(peerId, connectionId, WireCandidate(
                candidate.sdp,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                null,
            )))
        }
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) send(Wire.candidate(peerId, connectionId, null))
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) status("A viewer connection failed")
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Unit
        override fun onSetFailure(error: String?) = Unit
    }

    companion object {
        private const val MAX_PENDING = 64
    }
}
