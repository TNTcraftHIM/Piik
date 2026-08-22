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

func newViewerAdmission(maxViewers, endpointMediaCopyCapacity int) *viewerAdmission {
	edgeLimit := endpointMediaCopyCapacity
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

func (admission *viewerAdmission) Activate(peerID string) admissionAction {
	if _, exists := admission.active[peerID]; exists {
		return admissionDuplicate
	}
	_, wasWaiting := admission.waitSet[peerID]
	if !wasWaiting && len(admission.active)+len(admission.waiting) >= admission.roomLimit {
		return admissionFull
	}
	if len(admission.active) >= admission.edgeLimit {
		return admissionFull
	}
	if wasWaiting {
		admission.removeWaiting(peerID)
	}
	admission.active[peerID] = struct{}{}
	return admissionActivate
}

func (admission *viewerAdmission) Wait(peerID string) admissionAction {
	if _, exists := admission.waitSet[peerID]; exists {
		return admissionDuplicate
	}
	_, wasActive := admission.active[peerID]
	if !wasActive && len(admission.active)+len(admission.waiting) >= admission.roomLimit {
		return admissionFull
	}
	if wasActive {
		delete(admission.active, peerID)
	}
	admission.waiting = append(admission.waiting, peerID)
	admission.waitSet[peerID] = struct{}{}
	return admissionWait
}

func (admission *viewerAdmission) Leave(peerID string) (wasActive bool) {
	if _, exists := admission.active[peerID]; exists {
		delete(admission.active, peerID)
		return true
	}
	if _, exists := admission.waitSet[peerID]; !exists {
		return false
	}
	admission.removeWaiting(peerID)
	return false
}

func (admission *viewerAdmission) removeWaiting(peerID string) {
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
