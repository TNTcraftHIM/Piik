package icu.bonfire.screener.sender

import icu.bonfire.screener.protocol.HostRoute
import icu.bonfire.screener.protocol.ProtocolException
import icu.bonfire.screener.protocol.RouteAction
import icu.bonfire.screener.protocol.ServerEvent
import icu.bonfire.screener.protocol.Wire
import okhttp3.Call
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.webrtc.AudioTrack
import org.webrtc.PeerConnectionFactory
import org.webrtc.VideoTrack
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class RemoteSession(
    serverUrl: String,
    private var sitePassword: String,
    private val factory: PeerConnectionFactory,
    private val track: VideoTrack,
    private val audioTrack: AudioTrack?,
    private val serial: Executor,
    private val events: Events,
) : AutoCloseable {
    interface Events {
        fun onRoom(inviteUrl: String)
        fun onStatus(message: String)
        fun onFatal(message: String)
    }

    private val baseUrl = serverUrl.toHttpUrl()
    private val cookieJar = MemoryCookieJar()
    private val client = OkHttpClient.Builder().cookieJar(cookieJar).followRedirects(false).build()
    private val route = HostRoute()
    private val peers = linkedMapOf<String, HostPeer>()
    private val stopped = AtomicBoolean()
    private val closed = AtomicBoolean()
    private val activeCall = AtomicReference<Call?>()
    @Volatile
    private var socket: WebSocket? = null
    private var room: Room? = null
    private var iceConfig: icu.bonfire.screener.protocol.IceConfig? = null

    init {
        require(
            baseUrl.isHttps && baseUrl.query == null && baseUrl.fragment == null &&
                baseUrl.username.isEmpty() && baseUrl.password.isEmpty(),
        )
    }

    fun start() {
        try {
            authenticateSite()
        } finally {
            sitePassword = ""
        }
        if (stopped.get()) return
        val created = createRoom()
        if (stopped.get()) return
        room = Room(created.roomId, created.hostToken, opaqueId(), opaqueId())
        events.onRoom(created.inviteUrl)
        connectSignal()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        stopped.set(true)
        activeCall.get()?.cancel()
        val activeSocket = socket
        if (room != null) activeSocket?.send(Wire.abandonRoom())
        activeSocket?.close(1000, "sender stopped")
        socket = null
        peers.values.forEach(HostPeer::close)
        peers.clear()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    fun cancelPending() {
        stopped.set(true)
        activeCall.get()?.cancel()
    }

    private fun authenticateSite() {
        val request = Request.Builder()
            .url(endpoint(SITE_ACCESS_PATH))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer ${sitePassword.trim()}")
            .post("".toRequestBody(null))
            .build()
        execute(request, "Site access was denied")
    }

    private fun createRoom(): icu.bonfire.screener.protocol.CreatedRoom {
        val body = """{"viewerPolicy":"private-link","hostClaimTtlSeconds":300}"""
        val request = Request.Builder()
            .url(endpoint(ROOMS_PATH))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Origin", origin())
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        return Wire.decodeCreatedRoom(execute(request, "Room creation failed"))
    }

    private fun execute(request: Request, failure: String): String {
        val call = client.newCall(request)
        check(activeCall.compareAndSet(null, call))
        try {
            if (stopped.get()) call.cancel()
            return call.execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful || text.toByteArray().size > Wire.MAX_HTTP_BYTES) error(failure)
                text
            }
        } finally {
            activeCall.compareAndSet(call, null)
        }
    }

    private fun connectSignal() {
        val wsUrl = endpoint(SIGNAL_PATH).toString().replaceFirst("https://", "wss://")
        val cookies = cookieJar.loadForRequest(baseUrl).joinToString("; ") { "${it.name}=${it.value}" }
        val request = Request.Builder().url(wsUrl).header("Origin", origin()).apply {
            if (cookies.isNotEmpty()) header("Cookie", cookies)
        }.build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                dispatch {
                    if (stopped.get()) return@dispatch
                    val identity = room ?: return@dispatch
                    webSocket.send(Wire.authenticate(identity.id, identity.token, identity.clientId, identity.shareGeneration))
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                dispatch { if (!stopped.get()) accept(text) }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                fatal("Signaling connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!stopped.get()) fatal("Signaling connection closed")
            }
        })
    }

    private fun accept(text: String) {
        val event = try {
            Wire.decodeServerEvent(text)
        } catch (_: ProtocolException) {
            fatal("The server protocol does not match this sender")
            return
        }
        when (event) {
            is ServerEvent.Authenticated -> {
                iceConfig = event.iceConfig
                val assignment = event.routeAssignment
                val revision = event.routeRevision
                if (assignment == null || revision == null) {
                    fatal("This sender requires peer-assisted media")
                    return
                }
                socket?.send(Wire.qualitySettings())
                apply(route.authoritative(event.peerId, revision, assignment))
                events.onStatus("Connected; ${peers.size} viewer edge(s)")
            }
            is ServerEvent.RouteUpdate -> apply(route.update(event))
            is ServerEvent.SelectedSfuIngress -> apply(route.selectedSfuIngress(event))
            is ServerEvent.Signal -> {
                if (route.isAssignedChild(event.fromPeerId)) peers[event.fromPeerId]?.accept(event.payload)
            }
            is ServerEvent.RestartRequest -> recover(event)
            is ServerEvent.RoomClosed -> fatal(if (event.reason == "expired") "Room expired" else "Room closed")
            is ServerEvent.Error -> {
                if (event.code in FATAL_ERRORS) fatal("The server rejected this sender")
                else events.onStatus("A media route is unavailable")
            }
            is ServerEvent.Ignored -> Unit
        }
    }

    private fun apply(actions: List<RouteAction>) {
        actions.forEach {
            when (it) {
                is RouteAction.ReconcileChildren -> reconcile(it.peerIds)
                is RouteAction.Ready -> socket?.send(Wire.routeReady(it.revision, it.phase))
                is RouteAction.Failed -> socket?.send(Wire.routeFailed(it.revision, it.phase, it.connectionId))
            }
        }
    }

    private fun reconcile(peerIds: Collection<String>) {
        val desired = peerIds.distinct().take(MAX_EDGES).toSet()
        (peers.keys - desired).forEach { peers.remove(it)?.close() }
        desired.filterNot(peers::containsKey).forEach { peerId ->
            val config = iceConfig ?: return@forEach
            peers[peerId] = HostPeer(
                peerId, opaqueId(), config, factory, track, audioTrack, serial, ::send, events::onStatus,
            ).also {
                it.start()
            }
        }
    }

    private fun recover(event: ServerEvent.RestartRequest) {
        val peer = peers[event.fromPeerId] ?: return
        if (peer.connectionId != event.connectionId) return
        if (event.rebuild) {
            peer.close()
            peers.remove(event.fromPeerId)
            reconcile(routeChildren() + event.fromPeerId)
        } else {
            peer.restartIce()
        }
    }

    private fun routeChildren(): Set<String> = peers.keys.toSet()
    private fun send(message: String): Boolean = socket?.send(message) == true
    private fun dispatch(block: () -> Unit) {
        runCatching { serial.execute(block) }
    }
    private fun fatal(message: String) {
        if (stopped.get()) return
        events.onFatal(message)
    }

    private fun endpoint(path: String): HttpUrl = baseUrl.newBuilder().encodedPath(path).query(null).fragment(null).build()
    private fun origin(): String = baseUrl.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().removeSuffix("/")

    private data class Room(val id: String, val token: String, val clientId: String, val shareGeneration: String)

    private class MemoryCookieJar : CookieJar {
        private val cookies = mutableListOf<Cookie>()
        override fun saveFromResponse(url: HttpUrl, values: List<Cookie>) = synchronized(cookies) {
            values.forEach { value ->
                cookies.removeAll { it.name == value.name && it.domain == value.domain && it.path == value.path }
                if (value.expiresAt > System.currentTimeMillis()) cookies += value
            }
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(cookies) {
            cookies.removeAll { it.expiresAt <= System.currentTimeMillis() }
            cookies.filter { it.matches(url) }
        }
    }

    companion object {
        private const val SITE_ACCESS_PATH = "/api/site-access"
        private const val ROOMS_PATH = "/api/rooms"
        private const val SIGNAL_PATH = "/signal"
        private const val MAX_EDGES = 2
        private val FATAL_ERRORS = setOf("AUTH_REQUIRED", "INVALID_TOKEN", "ROOM_EXPIRED", "HOST_ALREADY_CONNECTED")
        private fun opaqueId(): String = UUID.randomUUID().toString()
    }
}
