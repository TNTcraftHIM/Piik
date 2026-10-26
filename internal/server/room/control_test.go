package room

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func controlMembers(t *testing.T, store *Store) (CreatedRoom, ConnectedParticipant, ConnectedParticipant) {
	t.Helper()
	created := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	host := mustConnect(t, store, hostInput(created.RoomID, created.HostToken))
	viewer := mustConnect(t, store, viewerInput(created.RoomID, "member-session", created.ViewerGrant))
	return created, host, viewer
}

func TestPresentationPermissionNeverGrantsRoomOwnership(t *testing.T) {
	store := newStore(t, Options{})
	created, host, viewer := controlMembers(t, store)
	connected, _ := store.GetConnectedHost(created.RoomID)
	_, err := store.ClaimPresenter(created.RoomID, viewer.PeerID, "member-session")
	expectCode(t, err, CodeRoomAccessDenied)
	if err := store.SetSharingPermission(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimPresenter(created.RoomID, viewer.PeerID, "member-session"); err != nil {
		t.Fatal(err)
	}
	if !store.IsRoomOwner(created.RoomID, host.PeerID, connected.SessionID) {
		t.Fatal("presentation changed ownership")
	}
	if store.IsRoomOwner(created.RoomID, viewer.PeerID, "member-session") {
		t.Fatal("publisher acquired ownership")
	}
	expectCode(t, store.SetSharingPermission(created.RoomID, viewer.PeerID, "member-session", host.PeerID, true), CodeInvalidToken)
	if err := store.SetSharingPermission(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID, false); err != nil {
		t.Fatal(err)
	}
	_, err = store.ClaimPresenter(created.RoomID, viewer.PeerID, "member-session")
	expectCode(t, err, CodeRoomAccessDenied)
}

func TestMemberCredentialFollowsMediaRoleWithoutGrantingManagement(t *testing.T) {
	store := newStore(t, Options{})
	created, host, viewer := controlMembers(t, store)
	connected, _ := store.GetConnectedHost(created.RoomID)
	token, err := store.IssueMemberToken(created.RoomID, viewer.PeerID, "member-session")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetSharingPermission(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimPresenter(created.RoomID, viewer.PeerID, "member-session"); err != nil {
		t.Fatal(err)
	}
	resumed, err := store.ConnectMember(created.RoomID, token, "viewer-member-session", "resumed")
	if err != nil || resumed.Role != protocol.RoleHost || resumed.PeerID != viewer.PeerID {
		t.Fatalf("resume = %+v, %v", resumed, err)
	}
	if store.IsRoomOwner(created.RoomID, viewer.PeerID, "resumed") {
		t.Fatal("member credential acquired management")
	}
	_, err = store.HostManagedRoom(created.RoomID, token)
	expectCode(t, err, CodeInvalidToken)
	_, err = store.ConnectMember(created.RoomID, token, "another-client", "other")
	expectCode(t, err, CodeInvalidToken)
	owner := mustConnect(t, store, hostInput(created.RoomID, created.HostToken))
	if owner.Role != protocol.RoleViewer || owner.PeerID != host.PeerID {
		t.Fatal("owner reconnect took over the picture")
	}
}

func TestOwnershipTransferRetainsPictureAndInvalidatesOldCredential(t *testing.T) {
	path := databasePath(t)
	store := stableStore(t, path, Options{})
	created, host, viewer := controlMembers(t, store)
	connected, _ := store.GetConnectedHost(created.RoomID)
	offer, err := store.PrepareOwnershipTransfer(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.HostManagedRoom(created.RoomID, created.HostToken); err != nil {
		t.Fatal("preparation revoked current authority", err)
	}
	if err := store.CommitOwnershipTransfer(offer); err != nil {
		t.Fatal(err)
	}
	root, _ := store.GetConnectedHost(created.RoomID)
	if root != connected {
		t.Fatal("ownership transfer changed the picture root")
	}
	if !store.IsRoomOwner(created.RoomID, viewer.PeerID, "member-session") {
		t.Fatal("recipient did not become owner")
	}
	_, err = store.HostManagedRoom(created.RoomID, created.HostToken)
	expectCode(t, err, CodeInvalidToken)
	if _, err := store.HostManagedRoom(created.RoomID, offer.Token); err != nil {
		t.Fatal(err)
	}
	expectCode(t, store.CommitOwnershipTransfer(offer), CodeInvalidToken)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restored := stableStore(t, path, Options{})
	if _, err := restored.HostManagedRoom(created.RoomID, offer.Token); err != nil {
		t.Fatal("new authority not persisted", err)
	}
	_, err = restored.HostManagedRoom(created.RoomID, created.HostToken)
	expectCode(t, err, CodeInvalidToken)
	if ok, err := restored.ViewerGrantMayEnter(created.RoomID, created.ViewerGrant); err != nil || !ok {
		t.Fatal("invitation changed during transfer")
	}
}

func TestOwnershipTransferRejectsReplacedRecipient(t *testing.T) {
	store := newStore(t, Options{})
	created, host, viewer := controlMembers(t, store)
	connected, _ := store.GetConnectedHost(created.RoomID)
	offer, err := store.PrepareOwnershipTransfer(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	input := viewerInput(created.RoomID, "member-session", created.ViewerGrant)
	input.SessionID = "replacement"
	mustConnect(t, store, input)
	expectCode(t, store.CommitOwnershipTransfer(offer), CodeInvalidToken)
	if _, err := store.HostManagedRoom(created.RoomID, created.HostToken); err != nil {
		t.Fatal("failed transfer revoked owner", err)
	}
}

func TestFailedOwnershipPersistencePreservesCurrentAuthority(t *testing.T) {
	store := stableStore(t, databasePath(t), Options{})
	created, host, viewer := controlMembers(t, store)
	connected, _ := store.GetConnectedHost(created.RoomID)
	offer, err := store.PrepareOwnershipTransfer(created.RoomID, host.PeerID, connected.SessionID, viewer.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	store.database.closeHandles()
	if err := store.CommitOwnershipTransfer(offer); err == nil {
		t.Fatal("closed database accepted transfer")
	}
	if !store.IsRoomOwner(created.RoomID, host.PeerID, connected.SessionID) {
		t.Fatal("failed persistence changed live owner")
	}
	if _, err := store.HostManagedRoom(created.RoomID, created.HostToken); err != nil {
		t.Fatal(err)
	}
}
