package icu.bonfire.screener.protocol

sealed interface RouteAction {
    data class ReconcileChildren(val peerIds: List<String>) : RouteAction
    data class Ready(val revision: Long, val phase: RoutePhase) : RouteAction
    data class Failed(val revision: Long, val phase: RoutePhase, val connectionId: String?) : RouteAction
}

class HostRoute {
    private var revision = -1L
    private var phase: RoutePhase? = null
    private var planned: RouteAssignment? = null
    private var active: RouteAssignment? = null
    private var hostPeerId: String? = null

    fun authoritative(
        hostPeerId: String,
        revision: Long,
        assignment: RouteAssignment,
    ): List<RouteAction> {
        this.hostPeerId = hostPeerId
        this.revision = revision
        phase = RoutePhase.ACTIVE
        planned = assignment.copy(childPeerIds = assignment.childPeerIds.toList())
        active = planned
        return activeActions(revision, assignment, acknowledge = false)
    }

    fun update(event: ServerEvent.RouteUpdate): List<RouteAction> {
        val result = accept(event)
        if (!result) return emptyList()
        if (event.phase == RoutePhase.PREPARE) {
            return if (event.assignment.sfuPublicationGeneration != null) {
                listOf(RouteAction.Failed(event.revision, RoutePhase.PREPARE, null))
            } else {
                emptyList()
            }
        }
        active = event.assignment.copy(childPeerIds = event.assignment.childPeerIds.toList())
        return activeActions(event.revision, event.assignment, acknowledge = true)
    }

    fun selectedSfuIngress(event: ServerEvent.SelectedSfuIngress): List<RouteAction> {
        val assignment = active ?: return emptyList()
        if (
            phase != RoutePhase.ACTIVE ||
            event.revision != revision ||
            event.hostPeerId != hostPeerId ||
            event.publicationGeneration != assignment.sfuPublicationGeneration
        ) return emptyList()
        return listOf(RouteAction.Failed(event.revision, RoutePhase.ACTIVE, event.newConnectionId))
    }

    fun isAssignedChild(peerId: String): Boolean = active?.childPeerIds?.contains(peerId) == true

    private fun accept(event: ServerEvent.RouteUpdate): Boolean {
        if (event.revision < revision) return false
        if (event.revision == revision) {
            if (planned != event.assignment || phase == RoutePhase.ACTIVE && event.phase == RoutePhase.PREPARE) return false
            if (phase == event.phase) return false
        }
        revision = event.revision
        phase = event.phase
        planned = event.assignment.copy(childPeerIds = event.assignment.childPeerIds.toList())
        return true
    }

    private fun activeActions(
        revision: Long,
        assignment: RouteAssignment,
        acknowledge: Boolean,
    ): List<RouteAction> = buildList {
        add(RouteAction.ReconcileChildren(assignment.childPeerIds.toList()))
        if (assignment.sfuPublicationGeneration != null) {
            add(RouteAction.Failed(revision, RoutePhase.ACTIVE, null))
        } else if (acknowledge) {
            add(RouteAction.Ready(revision, RoutePhase.ACTIVE))
        }
    }
}
