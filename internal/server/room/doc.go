// Package room ports the room authority: src/server/room-store.ts (rooms,
// participants, room codes, viewer credentials, the four-digit code pool) and
// src/server/room-database.ts (the SQLite stable authority). Authority mutations
// write SQLite before memory and return the write error unchanged. Participants
// remain process-only.
//
// # Locking
//
// Store has no mutex. The signaling layer's single global lock guards it, which
// is what Node's single thread did: nothing interleaved except at an await. The
// caller must hold that lock for every method below except the two derive
// methods, which run the password KDF and must NOT be called under the lock.
//
// The TypeScript methods that await the KDF are split into a locked "begin",
// an unlocked derive, and a locked "commit" so that the guards the TypeScript
// re-ran after its await are re-run here after the relock, in the same order.
// The commit takes the derive result as (material, derived error) because the
// TypeScript inspected the gate outcome (busy/cancelled) only after re-reading
// the room: forward both values unchanged and the commit reproduces the order.
//
// POST /api/rooms (createRoom):
//
//	mu.Lock()
//	if err := store.BeginCreateRoom(); err != nil { mu.Unlock(); return err }
//	var material []byte
//	var derived error
//	if password != "" {
//		mu.Unlock()
//		material, derived = store.DeriveViewerPasswordMaterial(password, nil)
//		mu.Lock()
//	}
//	created, err := store.CreateRoom(policy, material, derived, preferredRoomID)
//	mu.Unlock()
//
// replaceRoom and set-viewer-password (the mayStart closure is the TypeScript
// `rooms.get(roomId) === current && verifyDigest(hostToken, ...)`; it runs on
// the derive goroutine, so it takes the lock itself):
//
//	mu.Lock()
//	current, err := store.HostManagedRoom(roomID, hostToken) // may fail INVALID_TOKEN
//	if err != nil { mu.Unlock(); return err }
//	var material []byte
//	var derived error
//	if password != "" {
//		mu.Unlock()
//		material, derived = store.DeriveViewerPasswordMaterial(password, func() bool {
//			mu.Lock()
//			defer mu.Unlock()
//			return store.HostStillOwnsRoom(roomID, hostToken, current)
//		})
//		mu.Lock()
//	}
//	replaced, err := store.ReplaceRoom(roomID, hostToken, policy, material, derived, current)
//	mu.Unlock()
//
// Viewer password login (signaling authenticate). mayConnect is the TypeScript
// closure `!closing && socketStates.get(socket) === state && !state.revoked &&
// !state.authenticated && socket.readyState === OPEN`. It is evaluated twice,
// once on the derive goroutine (gate admission) and once under the lock inside
// the commit, so the caller needs both a locking and a non-locking form of the
// same predicate:
//
//	mu.Lock()
//	salt, expected, ref, err := store.ViewerPasswordChallenge(input.RoomID)
//	mu.Unlock()
//	if err != nil { return err } // not initialized
//	derivedKey, err := store.DeriveViewerPassword(input.Password, salt, func() bool {
//		mu.Lock()
//		defer mu.Unlock()
//		return mayConnectLocked()
//	})
//	mu.Lock()
//	if err != nil { mu.Unlock(); return err } // ROOM_BUSY or INVALID_TOKEN
//	participant, err := store.ConnectViewerWithPassword(
//		input, derivedKey, expected, ref, mayConnectLocked)
//	mu.Unlock()
//
// The room reference handed back by HostManagedRoom and ViewerPasswordChallenge
// is only ever compared for pointer identity, reproducing the TypeScript
// `currentRoom !== room` checks that detect a room replaced while the KDF ran.
// Holding it across the unlock is safe: an abandoned room is dropped from the
// map, never mutated into another room.
//
// Options.Random is called both under the caller's lock and from the derive
// goroutine (the 16-byte salt), so it must be safe for concurrent use;
// crypto/rand is.
package room
