package remote

import "testing"

func TestViewerAdmissionMirrorsAuthoritativeActiveAndWaitingSets(t *testing.T) {
	admission := newViewerAdmission(4, 2)
	assertActiveAdmission(t, admission, "viewer-a", admissionActivate)
	assertActiveAdmission(t, admission, "viewer-b", admissionActivate)
	assertWaitingAdmission(t, admission, "viewer-c", admissionWait)
	assertWaitingAdmission(t, admission, "viewer-d", admissionWait)
	assertWaitingAdmission(t, admission, "viewer-c", admissionDuplicate)
	assertWaitingAdmission(t, admission, "viewer-e", admissionFull)

	active, waiting := admission.Counts()
	if active != 2 || waiting != 2 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
	if !admission.Leave("viewer-b") {
		t.Fatal("active leave was not recorded")
	}
	if admission.IsActive("viewer-b") || admission.IsActive("viewer-c") {
		t.Fatal("leave promoted a Viewer without server authority")
	}
	active, waiting = admission.Counts()
	if active != 1 || waiting != 2 {
		t.Fatalf("post-leave counts = %d active, %d waiting", active, waiting)
	}
	assertActiveAdmission(t, admission, "viewer-c", admissionActivate)
	active, waiting = admission.Counts()
	if active != 2 || waiting != 1 {
		t.Fatalf("server promotion counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionRemovesAWaitingViewerWithoutPromotion(t *testing.T) {
	admission := newViewerAdmission(3, 2)
	assertActiveAdmission(t, admission, "viewer-a", admissionActivate)
	assertActiveAdmission(t, admission, "viewer-b", admissionActivate)
	assertWaitingAdmission(t, admission, "viewer-c", admissionWait)

	if admission.Leave("viewer-c") {
		t.Fatal("waiting leave was reported as active")
	}
	active, waiting := admission.Counts()
	if active != 2 || waiting != 0 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionUsesTheSmallerRoomLimit(t *testing.T) {
	admission := newViewerAdmission(1, 3)
	assertActiveAdmission(t, admission, "viewer-a", admissionActivate)
	assertWaitingAdmission(t, admission, "viewer-b", admissionFull)
	active, waiting := admission.Counts()
	if active != 1 || waiting != 0 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionClearsFailedActivation(t *testing.T) {
	admission := newViewerAdmission(4, 2)
	assertActiveAdmission(t, admission, "viewer-a", admissionActivate)
	assertActiveAdmission(t, admission, "viewer-b", admissionActivate)
	assertWaitingAdmission(t, admission, "viewer-c", admissionWait)
	assertWaitingAdmission(t, admission, "viewer-d", admissionWait)

	admission.Leave("viewer-a")
	assertActiveAdmission(t, admission, "viewer-c", admissionActivate)
	admission.AbortActivation("viewer-c")
	if admission.IsActive("viewer-c") || admission.IsActive("viewer-d") {
		t.Fatal("failed activation left a viewer in the active set")
	}
	active, waiting := admission.Counts()
	if active != 1 || waiting != 1 {
		t.Fatalf("counts = %d active, %d waiting", active, waiting)
	}
}

func TestViewerAdmissionNeverActivatesAWaitingViewerIntoAFreeSlot(t *testing.T) {
	admission := newViewerAdmission(4, 2)
	assertWaitingAdmission(t, admission, "viewer-a", admissionWait)
	active, waiting := admission.Counts()
	if active != 0 || waiting != 1 || admission.IsActive("viewer-a") {
		t.Fatalf("waiting authority = %d active, %d waiting", active, waiting)
	}
}

func assertActiveAdmission(t *testing.T, admission *viewerAdmission, peerID string, want admissionAction) {
	t.Helper()
	if got := admission.Activate(peerID); got != want {
		t.Fatalf("activate %q = %d, want %d", peerID, got, want)
	}
}

func assertWaitingAdmission(t *testing.T, admission *viewerAdmission, peerID string, want admissionAction) {
	t.Helper()
	if got := admission.Wait(peerID); got != want {
		t.Fatalf("wait %q = %d, want %d", peerID, got, want)
	}
}
