package icu.bonfire.screener.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

const val SIGNALING_PROTOCOL = "screener-v2"
const val MAX_SIGNAL_BYTES = 64 * 1024
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val opaqueId = Regex("^[A-Za-z0-9_-]{8,128}$")
private val roomCode = Regex("^[1-9][0-9]{0,11}$")
private val hostToken = Regex("^[A-Za-z0-9_-]{32,128}$")
private val stunUrl = Regex("^stun:[^/\\s?#:]+(?::[1-9][0-9]{0,4})?$", RegexOption.IGNORE_CASE)

class ProtocolException(message: String) : IllegalArgumentException(message)

data class IceServer(val urls: List<String>)
data class IceConfig(val iceServers: List<IceServer>)

enum class RoutePhase(val wire: String) {
    PREPARE("prepare"),
    ACTIVE("active");
}

sealed interface RouteUpstream {
    data object None : RouteUpstream
    data object Sfu : RouteUpstream
    data class Peer(val peerId: String) : RouteUpstream
}

data class RouteAssignment(
    val upstream: RouteUpstream,
    val childPeerIds: List<String>,
    val sfuPublicationGeneration: String?,
)

data class SessionDescription(val type: String, val sdp: String)
data class IceCandidate(
    val candidate: String,
    val sdpMid: String?,
    val sdpMLineIndex: Int?,
    val usernameFragment: String?,
)

sealed interface SignalPayload {
    val connectionId: String

    data class Description(
        override val connectionId: String,
        val description: SessionDescription,
    ) : SignalPayload

    data class Candidate(
        override val connectionId: String,
        val candidate: IceCandidate?,
    ) : SignalPayload
}

sealed interface ServerEvent {
    data class Authenticated(
        val peerId: String,
        val iceConfig: IceConfig,
        val viewerPeerIds: List<String>,
        val routeRevision: Long?,
        val routeAssignment: RouteAssignment?,
    ) : ServerEvent

    data class Signal(val fromPeerId: String, val payload: SignalPayload) : ServerEvent
    data class RestartRequest(
        val fromPeerId: String,
        val connectionId: String,
        val rebuild: Boolean,
    ) : ServerEvent

    data class RouteUpdate(
        val revision: Long,
        val phase: RoutePhase,
        val assignment: RouteAssignment,
    ) : ServerEvent

    data class SelectedSfuIngress(
        val revision: Long,
        val hostPeerId: String,
        val publicationGeneration: String,
        val newConnectionId: String,
    ) : ServerEvent

    data class Error(val code: String, val message: String) : ServerEvent
    data class RoomClosed(val reason: String) : ServerEvent
    data class Ignored(val type: String) : ServerEvent
}

data class CreatedRoom(val roomId: String, val hostToken: String, val inviteUrl: String)

object Wire {
    const val MAX_HTTP_BYTES = 64 * 1024
    private val json = Json { isLenient = false }
    private val ignoredTypes = setOf(
        "host-status",
        "media-assignment",
        "peer-joined",
        "peer-left",
        "quality-settings",
        "sfu-config",
        "sharing-stopped",
        "viewer-access-revoked",
        "viewer-access-updated",
        "viewer-password-updated",
        "viewer-presence",
        "viewer-quality-evidence",
    )

    fun decodeServerEvent(text: String): ServerEvent {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_SIGNAL_BYTES) {
            fail("signaling message is too large")
        }
        val root = parseObject(text)
        return try {
            when (val type = root.string("type", 1, 64)) {
                "authenticated" -> decodeAuthenticated(root)
                "signal" -> decodeSignal(root)
                "restart-request" -> decodeRestart(root)
                "route-update" -> decodeRouteUpdate(root)
                "selected-edge-turn" -> decodeSelectedEdge(root)
                "error" -> decodeError(root)
                "room-closed" -> decodeRoomClosed(root)
                in ignoredTypes -> ServerEvent.Ignored(type)
                else -> fail("unsupported signaling message")
            }
        } catch (error: ProtocolException) {
            throw error
        } catch (_: RuntimeException) {
            fail("invalid signaling message")
        }
    }

    fun decodeCreatedRoom(text: String): CreatedRoom {
        val root = parseObject(text)
        root.exact(
            setOf("roomId", "hostToken", "inviteUrl", "viewerPolicy", "viewerGrantExpiresAt", "expiresAt"),
        )
        val id = root.string("roomId", 1, 12).also { requireMatch(it, roomCode, "room ID") }
        val token = root.string("hostToken", 32, 128).also { requireMatch(it, hostToken, "host token") }
        val invite = root.string("inviteUrl", 1, 2048)
        if (!invite.startsWith("https://") && !invite.startsWith("http://")) fail("invalid invite URL")
        if (root.string("viewerPolicy", 1, 32) != "private-link") fail("unexpected viewer policy")
        root.requireNullableString("viewerGrantExpiresAt")
        root.requireNullableString("expiresAt")
        return CreatedRoom(id, token, invite)
    }

    fun authenticate(roomId: String, token: String, clientId: String, shareGeneration: String): String {
        requireMatch(roomId, roomCode, "room ID")
        requireMatch(token, hostToken, "host token")
        requireOpaque(clientId, "client ID")
        requireOpaque(shareGeneration, "share generation")
        return buildJsonObject {
            put("type", "authenticate")
            put("protocol", SIGNALING_PROTOCOL)
            put("roomId", roomId)
            put("role", "host")
            put("token", token)
            put("clientId", clientId)
            put("shareGeneration", shareGeneration)
        }.toString()
    }

    fun qualitySettings(): String = buildJsonObject {
        put("type", "set-quality-settings")
        put("qualitySettings", buildJsonObject {
            put("resolution", "720p")
            put("maxFramerate", 30)
            put("maxBitrate", 3_000_000)
            put("degradationPreference", "maintain-resolution")
        })
    }.toString()

    fun description(targetPeerId: String, connectionId: String, type: String, sdp: String): String {
        requireOpaque(targetPeerId, "target peer ID")
        requireOpaque(connectionId, "connection ID")
        if (type != "offer" || sdp.isEmpty() || sdp.length > 48 * 1024) fail("invalid local offer")
        return signal(targetPeerId, buildJsonObject {
            put("kind", "description")
            put("connectionId", connectionId)
            put("description", buildJsonObject {
                put("type", type)
                put("sdp", sdp)
            })
        })
    }

    fun candidate(targetPeerId: String, connectionId: String, value: IceCandidate?): String {
        requireOpaque(targetPeerId, "target peer ID")
        requireOpaque(connectionId, "connection ID")
        return signal(targetPeerId, buildJsonObject {
            put("kind", "candidate")
            put("connectionId", connectionId)
            put("candidate", value?.let { candidateJson(it) } ?: JsonNull)
        })
    }

    fun routeReady(revision: Long, phase: RoutePhase): String = buildJsonObject {
        put("type", "route-ready")
        put("revision", validRevision(revision))
        put("phase", phase.wire)
    }.toString()

    fun routeFailed(revision: Long, phase: RoutePhase, connectionId: String?): String = buildJsonObject {
        put("type", "route-failed")
        put("revision", validRevision(revision))
        put("phase", phase.wire)
        if (connectionId == null) put("connectionId", JsonNull)
        else put("connectionId", connectionId.also { requireOpaque(it, "connection ID") })
    }.toString()

    fun abandonRoom(): String = "{\"type\":\"abandon-room\"}"

    private fun decodeAuthenticated(root: JsonObject): ServerEvent.Authenticated {
        val base = setOf(
            "type", "protocol", "role", "peerId", "roomExpiresAt", "maxViewers", "hostOnline",
            "connectionId", "viewerPeerIds", "iceConfig", "viewerPolicy", "viewerAuthorizationGeneration",
        )
        val peerAssisted = root["mediaMode"]?.jsonPrimitive?.contentOrNull == "peer-assisted"
        val peerFields = setOf("mediaMode", "mediaAssignment", "routeRevision", "routeAssignment", "qualitySettings")
        root.exact(if (peerAssisted) base + peerFields else base, if (peerAssisted) setOf("sfuStandbyUrl") else emptySet())
        if (root.string("protocol", 1, 32) != SIGNALING_PROTOCOL || root.string("role", 1, 16) != "host") {
            fail("unexpected authentication response")
        }
        if (root.boolean("hostOnline") != true || root["connectionId"] !is JsonNull) {
            fail("invalid host authentication state")
        }
        root.requireNullableString("roomExpiresAt")
        val maxViewers = root.integer("maxViewers", 1, 16)
        root.string("viewerPolicy", 1, 32).also {
            if (it != "private-link" && it != "public-watch") fail("invalid viewer policy")
        }
        requireOpaque(root.string("viewerAuthorizationGeneration", 8, 128), "authorization generation")
        val viewers = root.idArray("viewerPeerIds", maxViewers)
        val ice = decodeIceConfig(root.objectValue("iceConfig"))
        if (!peerAssisted) {
            return ServerEvent.Authenticated(root.opaque("peerId"), ice, viewers, null, null)
        }
        root.objectValue("mediaAssignment").also {
            it.exact(setOf("parentPeerId", "childPeerIds"))
            if (it["parentPeerId"] !is JsonNull) fail("host cannot have a media parent")
            it.idArray("childPeerIds", 2)
        }
        decodeQuality(root.objectValue("qualitySettings"))
        return ServerEvent.Authenticated(
            root.opaque("peerId"),
            ice,
            viewers,
            root.revision("routeRevision"),
            decodeAssignment(root.objectValue("routeAssignment")),
        )
    }

    private fun decodeSignal(root: JsonObject): ServerEvent.Signal {
        root.exact(setOf("type", "fromPeerId", "payload"))
        val from = root.opaque("fromPeerId")
        val payload = root.objectValue("payload")
        return when (payload.string("kind", 1, 32)) {
            "description" -> {
                payload.exact(setOf("kind", "connectionId", "description"))
                val description = payload.objectValue("description")
                description.exact(setOf("type", "sdp"))
                val type = description.string("type", 1, 16)
                if (type != "answer") fail("host only accepts answers")
                ServerEvent.Signal(from, SignalPayload.Description(
                    payload.opaque("connectionId"),
                    SessionDescription(type, description.string("sdp", 1, 48 * 1024)),
                ))
            }
            "candidate" -> {
                payload.exact(setOf("kind", "connectionId", "candidate"))
                val candidate = when (val value = payload["candidate"] ?: fail("missing candidate")) {
                    JsonNull -> null
                    is JsonObject -> decodeCandidate(value)
                    else -> fail("invalid candidate")
                }
                ServerEvent.Signal(from, SignalPayload.Candidate(payload.opaque("connectionId"), candidate))
            }
            else -> fail("unsupported signal payload")
        }
    }

    private fun decodeRestart(root: JsonObject): ServerEvent.RestartRequest {
        root.exact(setOf("type", "fromPeerId", "connectionId", "rebuild"))
        return ServerEvent.RestartRequest(root.opaque("fromPeerId"), root.opaque("connectionId"), root.boolean("rebuild"))
    }

    private fun decodeRouteUpdate(root: JsonObject): ServerEvent.RouteUpdate {
        root.exact(setOf("type", "revision", "phase", "assignment"))
        val phase = when (root.string("phase", 1, 16)) {
            "prepare" -> RoutePhase.PREPARE
            "active" -> RoutePhase.ACTIVE
            else -> fail("invalid route phase")
        }
        return ServerEvent.RouteUpdate(root.revision("revision"), phase, decodeAssignment(root.objectValue("assignment")))
    }

    private fun decodeSelectedEdge(root: JsonObject): ServerEvent {
        val kind = root.string("edgeKind", 1, 32)
        if (kind != "host-sfu-ingress") return ServerEvent.Ignored("selected-edge-turn")
        root.exact(setOf(
            "type", "edgeKind", "revision", "hostPeerId", "publicationGeneration", "oldConnectionId",
            "newConnectionId", "expiresAt", "iceServer",
        ))
        root.objectValue("iceServer")
        return ServerEvent.SelectedSfuIngress(
            root.revision("revision"),
            root.opaque("hostPeerId"),
            root.opaque("publicationGeneration"),
            root.opaque("newConnectionId"),
        )
    }

    private fun decodeError(root: JsonObject): ServerEvent.Error {
        root.exact(setOf("type", "code", "message"))
        return ServerEvent.Error(root.string("code", 1, 64), root.string("message", 1, 256))
    }

    private fun decodeRoomClosed(root: JsonObject): ServerEvent.RoomClosed {
        root.exact(setOf("type", "reason"))
        val reason = root.string("reason", 1, 32)
        if (reason != "host-ended" && reason != "expired") fail("invalid room close reason")
        return ServerEvent.RoomClosed(reason)
    }

    private fun decodeAssignment(root: JsonObject): RouteAssignment {
        root.exact(setOf("upstream", "childPeerIds", "sfuPublicationGeneration"))
        val upstreamObject = root.objectValue("upstream")
        val upstream = when (upstreamObject.string("kind", 1, 16)) {
            "none" -> {
                upstreamObject.exact(setOf("kind"))
                RouteUpstream.None
            }
            "sfu" -> {
                upstreamObject.exact(setOf("kind"))
                RouteUpstream.Sfu
            }
            "peer" -> {
                upstreamObject.exact(setOf("kind", "peerId"))
                RouteUpstream.Peer(upstreamObject.opaque("peerId"))
            }
            else -> fail("invalid route upstream")
        }
        if (upstream !is RouteUpstream.None) fail("host route must not have an upstream")
        val children = root.idArray("childPeerIds", 2)
        if (children.toSet().size != children.size) fail("duplicate route child")
        val publication = root.nullableOpaque("sfuPublicationGeneration")
        return RouteAssignment(upstream, children, publication)
    }

    private fun decodeIceConfig(root: JsonObject): IceConfig {
        root.exact(setOf("iceServers"))
        val values = root.array("iceServers")
        if (values.size > 8) fail("too many ICE servers")
        return IceConfig(values.map { element ->
            val server = element as? JsonObject ?: fail("invalid ICE server")
            server.exact(setOf("urls"))
            val urls = when (val raw = server["urls"] ?: fail("missing ICE URLs")) {
                is JsonPrimitive -> listOf(raw.content)
                is JsonArray -> raw.map { it.jsonPrimitive.content }
                else -> fail("invalid ICE URLs")
            }
            if (urls.isEmpty() || urls.size > 8 || urls.any { it.length > 512 || !stunUrl.matches(it) }) {
                fail("invalid STUN URLs")
            }
            IceServer(urls)
        })
    }

    private fun decodeQuality(root: JsonObject) {
        root.exact(setOf("resolution", "maxFramerate", "maxBitrate", "degradationPreference"))
        if (root.string("resolution", 1, 16) !in setOf("720p", "1080p", "1440p")) fail("invalid quality")
        root.integer("maxFramerate", 15, 60)
        root.integer("maxBitrate", 2_000_000, 12_000_000)
        if (root.string("degradationPreference", 1, 32) !in setOf("maintain-resolution", "balanced", "maintain-framerate")) {
            fail("invalid quality")
        }
    }

    private fun decodeCandidate(root: JsonObject): IceCandidate {
        root.exact(setOf("candidate"), setOf("sdpMid", "sdpMLineIndex", "usernameFragment"))
        return IceCandidate(
            root.string("candidate", 0, 4096),
            root.optionalNullableString("sdpMid", 128),
            root.optionalNullableInteger("sdpMLineIndex", 0, 255),
            root.optionalNullableString("usernameFragment", 256),
        )
    }

    private fun signal(targetPeerId: String, payload: JsonObject): String = buildJsonObject {
        put("type", "signal")
        put("targetPeerId", targetPeerId)
        put("payload", payload)
    }.toString()

    private fun candidateJson(value: IceCandidate): JsonObject {
        if (value.candidate.length > 4096 || (value.sdpMid?.length ?: 0) > 128 ||
            value.sdpMLineIndex?.let { it !in 0..255 } == true || (value.usernameFragment?.length ?: 0) > 256
        ) fail("invalid local candidate")
        return buildJsonObject {
            put("candidate", value.candidate)
            value.sdpMid?.let { put("sdpMid", it) }
            value.sdpMLineIndex?.let { put("sdpMLineIndex", it) }
            value.usernameFragment?.let { put("usernameFragment", it) }
        }
    }

    private fun parseObject(text: String): JsonObject = try {
        json.parseToJsonElement(text).jsonObject
    } catch (_: Exception) {
        fail("invalid JSON object")
    }
}

private fun JsonObject.exact(required: Set<String>, optional: Set<String> = emptySet()) {
    if (!keys.containsAll(required) || keys.any { it !in required && it !in optional }) fail("invalid message shape")
}

private fun JsonObject.string(key: String, min: Int, max: Int): String {
    val value = (this[key] as? JsonPrimitive)?.takeUnless { it.isString.not() }?.contentOrNull
        ?: fail("missing string $key")
    if (value.length !in min..max) fail("invalid string $key")
    return value
}

private fun JsonObject.opaque(key: String): String = string(key, 8, 128).also { requireOpaque(it, key) }

private fun JsonObject.nullableOpaque(key: String): String? = when (val value = this[key] ?: fail("missing $key")) {
    JsonNull -> null
    is JsonPrimitive -> value.content.also { requireOpaque(it, key) }
    else -> fail("invalid $key")
}

private fun JsonObject.boolean(key: String): Boolean = this[key]?.jsonPrimitive?.booleanOrNull ?: fail("invalid $key")
private fun JsonObject.integer(key: String, min: Int, max: Int): Int =
    this[key]?.jsonPrimitive?.intOrNull?.takeIf { it in min..max } ?: fail("invalid $key")
private fun JsonObject.revision(key: String): Long =
    this[key]?.jsonPrimitive?.longOrNull?.let(::validRevision) ?: fail("invalid $key")
private fun JsonObject.objectValue(key: String): JsonObject = this[key] as? JsonObject ?: fail("invalid $key")
private fun JsonObject.array(key: String): JsonArray = this[key] as? JsonArray ?: fail("invalid $key")
private fun JsonObject.idArray(key: String, max: Int): List<String> {
    val values = array(key)
    if (values.size > max) fail("too many $key")
    return values.map { it.jsonPrimitive.content.also { id -> requireOpaque(id, key) } }
}

private fun JsonObject.requireNullableString(key: String) {
    val value = this[key] ?: fail("missing $key")
    if (value !is JsonNull && (value !is JsonPrimitive || !value.isString)) fail("invalid $key")
}

private fun JsonObject.optionalNullableString(key: String, max: Int): String? = when (val value = this[key]) {
    null, JsonNull -> null
    is JsonPrimitive -> value.content.takeIf { value.isString && it.length <= max } ?: fail("invalid $key")
    else -> fail("invalid $key")
}

private fun JsonObject.optionalNullableInteger(key: String, min: Int, max: Int): Int? = when (val value = this[key]) {
    null, JsonNull -> null
    is JsonPrimitive -> value.intOrNull?.takeIf { it in min..max } ?: fail("invalid $key")
    else -> fail("invalid $key")
}

private fun validRevision(value: Long): Long = value.takeIf { it in 0..MAX_SAFE_INTEGER } ?: fail("invalid route revision")
private fun requireOpaque(value: String, label: String) = requireMatch(value, opaqueId, label)
private fun requireMatch(value: String, pattern: Regex, label: String) {
    if (!pattern.matches(value)) fail("invalid $label")
}
private fun fail(message: String): Nothing = throw ProtocolException(message)
