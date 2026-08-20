package remote

import "testing"

func TestViewerAdmissionNeverExceedsTwoEdgesAndPromotesInJoinOrder(t *testing.T) {
	admission := newViewerAdmission(4)
	assertAdmission(t, admission, "viewer-a", admissionActivate)
	assertAdmission(t, admission, "viewer-b", admissionActivate)
	assertAdmission(t, admission, "viewer-c", admissionWait)
	assertAdmission(t, admission, "viewer-d", admissionWait)
	assertAdmission(t, admission, "viewer-c", admissionDuplicate)
	assertAdmission(t, admission, "viewer-e", admissionFull)

	active, waiting := admission.Counts()
	if active != 2 || waiting != 2 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
	wasActive, promoted := admission.Leave("viewer-b")
	if !wasActive || promoted != "viewer-c" {
		t.Fatalf("leave promoted %q from active=%t", promoted, wasActive)
	}
	if admission.IsActive("viewer-b") || !admission.IsActive("viewer-c") {
		t.Fatal("promotion did not atomically replace the freed edge")
	}
	active, waiting = admission.Counts()
	if active != 2 || waiting != 1 {
		t.Fatalf("post-promotion counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionRemovesAWaitingViewerWithoutPromotion(t *testing.T) {
	admission := newViewerAdmission(3)
	assertAdmission(t, admission, "viewer-a", admissionActivate)
	assertAdmission(t, admission, "viewer-b", admissionActivate)
	assertAdmission(t, admission, "viewer-c", admissionWait)

	wasActive, promoted := admission.Leave("viewer-c")
	if wasActive || promoted != "" {
		t.Fatalf("waiting leave = active %t, promotion %q", wasActive, promoted)
	}
	active, waiting := admission.Counts()
	if active != 2 || waiting != 0 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionUsesTheSmallerRoomLimit(t *testing.T) {
	admission := newViewerAdmission(1)
	assertAdmission(t, admission, "viewer-a", admissionActivate)
	assertAdmission(t, admission, "viewer-b", admissionFull)
	active, waiting := admission.Counts()
	if active != 1 || waiting != 0 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionClearsFailedActivation(t *testing.T) {
	admission := newViewerAdmission(4)
	assertAdmission(t, admission, "viewer-a", admissionActivate)
	assertAdmission(t, admission, "viewer-b", admissionActivate)
	assertAdmission(t, admission, "viewer-c", admissionWait)
	assertAdmission(t, admission, "viewer-d", admissionWait)

	_, promoted := admission.Leave("viewer-a")
	if promoted != "viewer-c" {
		t.Fatalf("first promotion = %q", promoted)
	}
	admission.AbortActivation(promoted)
	if admission.IsActive("viewer-c") || admission.IsActive("viewer-d") {
		t.Fatal("failed activation left a viewer in the active set")
	}
	active, waiting := admission.Counts()
	if active != 1 || waiting != 1 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func assertAdmission(t *testing.T, admission *viewerAdmission, peerID string, want admissionAction) {
	t.Helper()
	if got := admission.Join(peerID); got != want {
		t.Fatalf("join %q = %d, want %d", peerID, got, want)
	}
}
