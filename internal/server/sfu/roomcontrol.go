package sfu

// Ported from src/server/sfu-room-control.ts.

import (
	"context"
	"errors"
)

// RoomControl is SfuRoomControl. Every method performs network I/O, so it must
// be called with the signaling server's mutex released.
type RoomControl interface {
	Initialize(ctx context.Context) error
	CreateRoom(ctx context.Context, fence ResourceFence) error
	DeleteRoom(ctx context.Context, fence ResourceFence) error
	DrainSubscription(ctx context.Context, fence SubscriptionFence) error
	HostParticipantExists(ctx context.Context, fence ResourceFence) (bool, error)
}

// LiveKitRoomControlOptions is LiveKitSfuRoomControlOptions minus the injected
// roomService: the tests drive a real Twirp client against httptest.
type LiveKitRoomControlOptions struct {
	APIURL            string
	APIKey            string
	APISecret         string
	MaxViewersPerRoom int
}

// LiveKitRoomControl is LiveKitSfuRoomControl. It holds no state of its own:
// the TypeScript per-room-name operation queue moved to the router, which
// reserves each managed room's turn while the signaling mutex is still held
// and so orders the mutating calls by the decision that made them.
type LiveKitRoomControl struct {
	service         roomService
	maxParticipants int
}

var _ RoomControl = (*LiveKitRoomControl)(nil)

// NewLiveKitRoomControl mirrors the LiveKitSfuRoomControl constructor.
func NewLiveKitRoomControl(options LiveKitRoomControlOptions) (*LiveKitRoomControl, error) {
	if options.APIURL == "" || options.APIKey == "" ||
		len(options.APISecret) < minAPISecretBytes {
		return nil, errors.New("LiveKit RoomService configuration is invalid")
	}
	if err := validateViewerLimit(options.MaxViewersPerRoom); err != nil {
		return nil, err
	}
	return &LiveKitRoomControl{
		service:         newRoomService(options.APIURL, newSigner(options.APIKey, options.APISecret)),
		maxParticipants: options.MaxViewersPerRoom + 1,
	}, nil
}

// Initialize ports initialize(): it deletes in the order listRooms returned.
func (control *LiveKitRoomControl) Initialize(ctx context.Context) error {
	rooms, err := control.service.listRooms(ctx, nil)
	if err != nil {
		return err
	}
	for _, room := range rooms {
		if !IsManagedRoomName(room.Name) {
			return errors.New("Dedicated LiveKit instance contains a foreign room")
		}
	}
	for _, room := range rooms {
		if err := control.deleteRoomByName(ctx, room.Name); err != nil {
			return err
		}
	}
	remaining, err := control.service.listRooms(ctx, nil)
	if err != nil {
		return err
	}
	if len(remaining) != 0 {
		return errors.New("Dedicated LiveKit instance is not empty after startup drain")
	}
	return nil
}

// CreateRoom ports createRoom().
func (control *LiveKitRoomControl) CreateRoom(ctx context.Context, fence ResourceFence) error {
	roomName, err := managedRoomName(fence)
	if err != nil {
		return err
	}
	existing, err := control.service.listRooms(ctx, []string{roomName})
	if err != nil {
		return err
	}
	if len(existing) != 0 {
		return errors.New("Managed LiveKit room already exists")
	}
	if err := control.service.createRoom(ctx, roomName, control.maxParticipants); err != nil {
		return err
	}
	rooms, err := control.service.listRooms(ctx, []string{roomName})
	if err != nil {
		return err
	}
	if len(rooms) != 1 || rooms[0].Name != roomName {
		return errors.New("Managed LiveKit room creation was not confirmed")
	}
	return nil
}

// DeleteRoom ports deleteRoom().
func (control *LiveKitRoomControl) DeleteRoom(ctx context.Context, fence ResourceFence) error {
	roomName, err := managedRoomName(fence)
	if err != nil {
		return err
	}
	if err := control.deleteRoomByName(ctx, roomName); err != nil {
		return err
	}
	rooms, err := control.service.listRooms(ctx, []string{roomName})
	if err != nil {
		return err
	}
	if len(rooms) != 0 {
		return errors.New("Managed LiveKit room deletion was not confirmed")
	}
	return nil
}

// DrainSubscription ports drainSubscription().
func (control *LiveKitRoomControl) DrainSubscription(ctx context.Context, fence SubscriptionFence) error {
	roomName, err := managedRoomName(fence.ResourceFence)
	if err != nil {
		return err
	}
	identity, err := viewerIdentity(fence.ViewerPeerID)
	if err != nil {
		return err
	}
	if err := control.service.removeParticipant(ctx, roomName, identity); err != nil &&
		!isNotFound(err) {
		return err
	}
	exists, err := control.participantExists(ctx, roomName, identity)
	if err != nil {
		return err
	}
	if exists {
		return errors.New("Managed LiveKit participant removal was not confirmed")
	}
	return nil
}

// HostParticipantExists ports hostParticipantExists().
func (control *LiveKitRoomControl) HostParticipantExists(
	ctx context.Context,
	fence ResourceFence,
) (bool, error) {
	roomName, err := managedRoomName(fence)
	if err != nil {
		return false, err
	}
	return control.participantExists(ctx, roomName, "host")
}

// deleteRoomByName ports deleteRoomByName(): a missing room is not an error.
func (control *LiveKitRoomControl) deleteRoomByName(ctx context.Context, roomName string) error {
	if err := control.service.deleteRoom(ctx, roomName); err != nil && !isNotFound(err) {
		return err
	}
	return nil
}

// participantExists ports participantExists(): an absent room reads as absent.
func (control *LiveKitRoomControl) participantExists(
	ctx context.Context,
	roomName string,
	identity string,
) (bool, error) {
	participants, err := control.service.listParticipants(ctx, roomName)
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}
		return false, err
	}
	for _, participant := range participants {
		if participant.Identity == identity {
			return true, nil
		}
	}
	return false, nil
}
