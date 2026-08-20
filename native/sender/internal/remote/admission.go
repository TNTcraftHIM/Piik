package remote

type admissionAction uint8

const (
	admissionDuplicate admissionAction = iota
	admissionActivate
	admissionWait
	admissionFull
)

type viewerAdmission struct {
	edgeLimit int
	roomLimit int
	active    map[string]struct{}
	waiting   []string
	waitSet   map[string]struct{}
}

func newViewerAdmission(maxViewers int) *viewerAdmission {
	edgeLimit := maxHostEdges
	if maxViewers < edgeLimit {
		edgeLimit = maxViewers
	}
	return &viewerAdmission{
		edgeLimit: edgeLimit,
		roomLimit: maxViewers,
		active:    make(map[string]struct{}),
		waitSet:   make(map[string]struct{}),
	}
}

func (admission *viewerAdmission) Join(peerID string) admissionAction {
	if _, exists := admission.active[peerID]; exists {
		return admissionDuplicate
	}
	if _, exists := admission.waitSet[peerID]; exists {
		return admissionDuplicate
	}
	if len(admission.active) < admission.edgeLimit {
		admission.active[peerID] = struct{}{}
		return admissionActivate
	}
	if len(admission.active)+len(admission.waiting) >= admission.roomLimit {
		return admissionFull
	}
	admission.waiting = append(admission.waiting, peerID)
	admission.waitSet[peerID] = struct{}{}
	return admissionWait
}

func (admission *viewerAdmission) Leave(peerID string) (wasActive bool, promoted string) {
	if _, exists := admission.active[peerID]; exists {
		delete(admission.active, peerID)
		return true, admission.promoteNext()
	}
	if _, exists := admission.waitSet[peerID]; !exists {
		return false, ""
	}
	delete(admission.waitSet, peerID)
	for index, waitingID := range admission.waiting {
		if waitingID != peerID {
			continue
		}
		copy(admission.waiting[index:], admission.waiting[index+1:])
		admission.waiting[len(admission.waiting)-1] = ""
		admission.waiting = admission.waiting[:len(admission.waiting)-1]
		break
	}
	return false, ""
}

func (admission *viewerAdmission) AbortActivation(peerID string) {
	delete(admission.active, peerID)
}

func (admission *viewerAdmission) Counts() (active, waiting int) {
	return len(admission.active), len(admission.waiting)
}

func (admission *viewerAdmission) IsActive(peerID string) bool {
	_, exists := admission.active[peerID]
	return exists
}

func (admission *viewerAdmission) promoteNext() string {
	if len(admission.waiting) == 0 {
		return ""
	}
	promoted := admission.waiting[0]
	admission.waiting[0] = ""
	admission.waiting = admission.waiting[1:]
	delete(admission.waitSet, promoted)
	admission.active[promoted] = struct{}{}
	return promoted
}
