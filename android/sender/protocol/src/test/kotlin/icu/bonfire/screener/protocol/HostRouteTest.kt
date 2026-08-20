package icu.bonfire.screener.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class HostRouteTest {
    private val childA = "viewer_A123"
    private val childB = "viewer_B123"
    private val host = "host_123456"

    @Test
    fun `peer-assisted snapshot reconciles direct children without an acknowledgement`() {
        val event = Wire.decodeServerEvent(authenticatedJson())
        val authenticated = assertIs<ServerEvent.Authenticated>(event)
        val route = HostRoute()

        assertEquals(
            listOf(RouteAction.ReconcileChildren(listOf(childA, childB))),
            route.authoritative(authenticated.peerId, authenticated.routeRevision!!, authenticated.routeAssignment!!),
        )
        assertTrue(route.isAssignedChild(childA))
    }

    @Test
    fun `active direct update commits children and acknowledges once`() {
        val route = HostRoute()
        route.authoritative(host, 4, direct(childA))
        val update = ServerEvent.RouteUpdate(5, RoutePhase.ACTIVE, direct(childB))

        assertEquals(
            listOf(
                RouteAction.ReconcileChildren(listOf(childB)),
                RouteAction.Ready(5, RoutePhase.ACTIVE),
            ),
            route.update(update),
        )
        assertEquals(emptyList(), route.update(update))
    }

    @Test
    fun `SFU prepare and active assignments fail without replacing direct media early`() {
        val route = HostRoute()
        route.authoritative(host, 7, direct(childA))
        val sfu = direct(childA).copy(sfuPublicationGeneration = "publication_123")

        assertEquals(
            listOf(RouteAction.Failed(8, RoutePhase.PREPARE, null)),
            route.update(ServerEvent.RouteUpdate(8, RoutePhase.PREPARE, sfu)),
        )
        assertTrue(route.isAssignedChild(childA))
        assertEquals(
            listOf(
                RouteAction.ReconcileChildren(listOf(childA)),
                RouteAction.Failed(8, RoutePhase.ACTIVE, null),
            ),
            route.update(ServerEvent.RouteUpdate(8, RoutePhase.ACTIVE, sfu)),
        )
    }

    @Test
    fun `unsupported selected SFU ingress closes the replacement attempt`() {
        val route = HostRoute()
        val assignment = direct(childA).copy(sfuPublicationGeneration = "publication_123")
        route.authoritative(host, 9, assignment)

        assertEquals(
            listOf(RouteAction.Failed(9, RoutePhase.ACTIVE, "connection_123")),
            route.selectedSfuIngress(
                ServerEvent.SelectedSfuIngress(9, host, "publication_123", "connection_123"),
            ),
        )
    }

    @Test
    fun `strict actionable messages reject unknown fields`() {
        assertFailsWith<ProtocolException> {
            Wire.decodeServerEvent(
                """{"type":"route-update","revision":4,"phase":"active","assignment":{"upstream":{"kind":"none"},"childPeerIds":["$childA"],"sfuPublicationGeneration":null},"legacy":true}""",
            )
        }
    }

    @Test
    fun `inbound answer retains target connection generation`() {
        val event = Wire.decodeServerEvent(
            """{"type":"signal","fromPeerId":"$childA","payload":{"kind":"description","connectionId":"connection_123","description":{"type":"answer","sdp":"v=0"}}}""",
        )
        val signal = assertIs<ServerEvent.Signal>(event)
        assertEquals("connection_123", signal.payload.connectionId)
    }

    private fun direct(vararg peers: String) = RouteAssignment(RouteUpstream.None, peers.toList(), null)

    private fun authenticatedJson(): String = """
        {
          "type":"authenticated","protocol":"screener-v2","role":"host","peerId":"$host",
          "roomExpiresAt":null,"maxViewers":8,"hostOnline":true,"connectionId":null,
          "viewerPeerIds":["$childA","$childB"],
          "iceConfig":{"iceServers":[{"urls":["stun:stun.example.test:3478"]}]},
          "viewerPolicy":"private-link","viewerAuthorizationGeneration":"authorization_123",
          "mediaMode":"peer-assisted","mediaAssignment":{"parentPeerId":null,"childPeerIds":["$childA","$childB"]},
          "routeRevision":3,"routeAssignment":{"upstream":{"kind":"none"},"childPeerIds":["$childA","$childB"],"sfuPublicationGeneration":null},
          "qualitySettings":{"resolution":"720p","maxFramerate":30,"maxBitrate":3000000,"degradationPreference":"maintain-resolution"}
        }
    """.trimIndent()
}
