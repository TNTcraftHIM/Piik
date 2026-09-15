package route

import (
	"errors"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// pruneDepartedLeaves removes departed viewers without
// children to a fixpoint, in participants order, and drops an
// orphaned publication.
func (c *Controller) pruneDepartedLeaves(released *[]*Resource) []string {
	removed := []string{}
	changed := true
	for changed {
		changed = false
		// Live iteration: deleting the visited entry is JS-safe (ordered.Map.All).
		for _, current := range c.participants.All() {
			if current.role != protocol.RoleViewer || !current.departureConfirmed || len(c.childrenOf(current.peerID)) > 0 {
				continue
			}
			edge, _ := c.upstreamByViewer.Get(current.peerID)
			if edge != nil && edge.Kind == UpstreamSfu {
				c.retireSfuEdge(current.peerID, edge, released, false)
			} else {
				c.upstreamByViewer.Delete(current.peerID)
			}
			c.clearQualityForParticipant(current.peerID)
			c.participants.Delete(current.peerID)
			delete(c.routeTimings, current.peerID)
			c.directContinuations.Delete(current.peerID)
			c.clearSfuBootstrapForDemand(current.peerID)
			removed = append(removed, current.peerID)
			changed = true
		}
	}
	if len(removed) > 0 {
		if !c.hasSfuSubscribers() && c.hostPublication != nil {
			c.clearSfuQuality()
			if c.hostPublication.PhysicalActive {
				*released = append(*released, c.hostPublication.Resource)
			}
			c.hostPublication = nil
		}
		c.revision = c.allocateRevision()
		c.touchFacts()
		c.pruneRetiringSfuAnchors()
	}
	return removed
}

func (c *Controller) retireInvalidOperationEdge(childPeerID string, released *[]*Resource) bool {
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	if edge == nil || !c.edgeRequiresMove(childPeerID, edge) {
		return false
	}
	if edge.Kind == UpstreamSfu {
		c.retireSfuEdge(childPeerID, edge, released, c.retainsAnchor(childPeerID))
		c.pruneRetiringSfuAnchors()
	} else {
		edge.PhysicalActive = false
		edge.Usable = false
	}
	if edge.Kind == UpstreamSfu && !c.hasSfuSubscribers() && c.hostPublication != nil {
		publication := c.hostPublication
		if publication.PhysicalActive {
			*released = append(*released, publication.Resource)
		}
		publication.PhysicalActive = false
		publication.Usable = false
		c.hostPublication = nil
	}
	return true
}

func (c *Controller) edgeRequiresMove(childPeerID string, edge *CommittedEdge) bool {
	if !edge.Usable || !edge.PhysicalActive {
		return true
	}
	if edge.Kind == UpstreamSfu {
		return c.hostPublication == nil || !c.hostPublication.Usable ||
			!c.hostPublication.PhysicalActive ||
			c.hostPublication.Generation != edge.PublicationGeneration
	}
	if parent, ok := c.participants.Get(edge.ParentPeerID); ok && parent.departureConfirmed {
		return true
	}
	for _, overflowing := range c.overflowPeerChildren(edge.ParentPeerID) {
		if overflowing == childPeerID {
			return true
		}
	}
	return false
}

// rebindCommittedSession preserves the reconnecting peer's edges and
// publication, updating them to its new session ID.
func (c *Controller) rebindCommittedSession(peerID, sessionID string) {
	if ownEdge, ok := c.upstreamByViewer.Get(peerID); ok {
		ownEdge.ChildSessionID = sessionID
	}
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind != UpstreamPeer || edge.ParentPeerID != peerID {
			continue
		}
		edge.ParentSessionID = sessionID
	}
	if peerID == c.hostPeerID && c.hostPublication != nil {
		c.hostPublication.HostSessionID = sessionID
	}
}

func (c *Controller) removePublicationGeneration(generation string) []*Resource {
	released := []*Resource{}
	for viewerPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind != UpstreamSfu || edge.PublicationGeneration != generation {
			continue
		}
		c.retireSfuEdge(viewerPeerID, edge, &released, c.retainsAnchor(viewerPeerID))
	}
	if c.hostPublication != nil && c.hostPublication.Generation == generation {
		if c.hostPublication.PhysicalActive {
			released = append(released, c.hostPublication.Resource)
		}
		c.hostPublication = nil
	}
	c.pruneRetiringSfuAnchors()
	return released
}

// retainsAnchor is the TS default argument of retireSfuEdge
// (`this.childrenOf(viewerPeerId).length > 0`), evaluated at call time.
func (c *Controller) retainsAnchor(viewerPeerID string) bool {
	return len(c.childrenOf(viewerPeerID)) > 0
}

// retireSfuEdge releases the subscription only while it is
// still physically active, then keeps the edge as an anchor for attached
// peer descendants or deletes it.
func (c *Controller) retireSfuEdge(viewerPeerID string, edge *CommittedEdge, released *[]*Resource, retainAnchor bool) {
	if edge.PhysicalActive {
		*released = append(*released, edge.Resource)
	}
	c.clearQualityForParticipant(viewerPeerID)
	if retainAnchor {
		edge.Usable = false
		edge.PhysicalActive = false
		c.retiringPublicationGenerations.Set(edge.PublicationGeneration, struct{}{})
	} else {
		c.upstreamByViewer.Delete(viewerPeerID)
	}
}

// hasRetiringAnchor reports whether an inactive SFU edge still references
// the generation (the `some` at 4816 and 4880).
func (c *Controller) hasRetiringAnchor(generation string) bool {
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind == UpstreamSfu && !edge.PhysicalActive && edge.PublicationGeneration == generation {
			return true
		}
	}
	return false
}

func (c *Controller) pruneRetiringSfuAnchors() {
	removed := true
	for removed {
		removed = false
		for viewerPeerID, edge := range c.upstreamByViewer.All() {
			if edge.Kind == UpstreamSfu &&
				!edge.PhysicalActive &&
				c.retiringPublicationGenerations.Has(edge.PublicationGeneration) &&
				len(c.childrenOf(viewerPeerID)) == 0 {
				c.upstreamByViewer.Delete(viewerPeerID)
				removed = true
			}
		}
	}
	for generation := range c.retiringPublicationGenerations.All() {
		if !c.hasRetiringAnchor(generation) {
			c.retiringPublicationGenerations.Delete(generation)
		}
	}
}

// assertGraph panics on programming errors. Edge insertion order and
// participant order determine which violation is reported first.
func (c *Controller) assertGraph() {
	host, _ := c.participants.Get(c.hostPeerID)
	if host == nil || host.role != protocol.RoleHost {
		panic(errors.New("Route Host is missing"))
	}
	for child, edge := range c.upstreamByViewer.All() {
		c.assertViewer(child)
		if edge.Kind == UpstreamPeer && !c.participants.Has(edge.ParentPeerID) {
			panic(errors.New("Route parent is missing"))
		}
		if edge.Kind == UpstreamSfu && edge.PhysicalActive &&
			(c.hostPublication == nil || c.hostPublication.Generation != edge.PublicationGeneration) {
			panic(errors.New("SFU publication is stale"))
		}
		if edge.Kind == UpstreamSfu && !edge.PhysicalActive &&
			!c.retiringPublicationGenerations.Has(edge.PublicationGeneration) {
			panic(errors.New("Retiring SFU publication is unknown"))
		}
		seen := make(map[string]struct{})
		current := child
		for current != c.hostPeerID {
			if _, visited := seen[current]; visited {
				panic(errors.New("Peer route contains a cycle"))
			}
			seen[current] = struct{}{}
			currentEdge, ok := c.upstreamByViewer.Get(current)
			if !ok {
				panic(errors.New("Route is not source-reachable"))
			}
			if currentEdge.Kind == UpstreamSfu {
				var unknown bool
				if currentEdge.PhysicalActive {
					unknown = c.hostPublication == nil || c.hostPublication.Generation != currentEdge.PublicationGeneration
				} else {
					unknown = !c.retiringPublicationGenerations.Has(currentEdge.PublicationGeneration)
				}
				if unknown {
					panic(errors.New("Route terminates at an unknown SFU publication"))
				}
				break
			}
			current = currentEdge.ParentPeerID
		}
	}
	for _, current := range c.participants.Values() {
		if !protocol.EndpointMediaCopyCountFits(c.usedSlots(current.peerID), c.endpointMediaCopyCapacity, protocol.EndpointMediaCopySteady) {
			panic(errors.New("Committed route exceeds endpoint capacity"))
		}
	}
	for generation := range c.retiringPublicationGenerations.All() {
		if !c.hasRetiringAnchor(generation) {
			panic(errors.New("Retiring SFU publication has no anchor"))
		}
	}
}

func (c *Controller) assertViewer(peerID string) {
	if current, ok := c.participants.Get(peerID); !ok || current.role != protocol.RoleViewer {
		panic(errors.New("Route child must be a Viewer"))
	}
}

func (c *Controller) hasSfuSubscribers() bool {
	return c.sfuSubscriberCount() > 0
}

func (c *Controller) sfuSubscriberCount() int {
	count := 0
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind == UpstreamSfu && edge.PhysicalActive {
			count++
		}
	}
	return count
}

// committedResources returns SFU subscriptions in map order, then the
// publication.
func (c *Controller) committedResources() []*Resource {
	resources := []*Resource{}
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind == UpstreamSfu && edge.PhysicalActive {
			resources = append(resources, edge.Resource)
		}
	}
	if c.hostPublication != nil && c.hostPublication.PhysicalActive {
		resources = append(resources, c.hostPublication.Resource)
	}
	return resources
}
