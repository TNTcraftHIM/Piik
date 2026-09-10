package signal

// The per-connection state of src/server/signaling.ts (SocketState,
// accept(), the socket event handlers, send()/sendEncodedToSession(),
// heartbeat()). One reader goroutine and one writer goroutine per
// connection; the writer drains an outbound queue that handlers fill under
// mu, which is what the ws library's own send buffer did (D4).

import (
	"context"
	"time"

	"github.com/coder/websocket"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// authenticatedSession is AuthenticatedSession. Handlers compare it by
// pointer (hazard 1): `state.authenticated !== authenticated` detects a
// re-authentication between dispatch and use. shareGeneration is "" where
// the TS had null; displayName is nil where the TS had null.
type authenticatedSession struct {
	roomID          string
	role            protocol.Role
	peerID          string
	shareGeneration string
	displayName     *string
	viewerPresence  bool
}

// outbound is one queue item: a text frame or the close frame that ends the
// connection.
type outbound struct {
	data   []byte
	close  bool
	code   websocket.StatusCode
	reason string
}

// session is SocketState plus the connection it belongs to. Every field is
// guarded by Server.mu except conn, ctx, cancel, wake and readerDone, which
// are immutable after accept.
type session struct {
	conn *websocket.Conn
	// ctx is cancelled by terminate(); coder/websocket closes the socket
	// when the context of a pending Read or Write expires, which is the
	// `socket.terminate()` of the TS.
	ctx    context.Context
	cancel context.CancelFunc

	sessionID               string
	alive                   bool
	siteAccessAuthenticated bool
	revoked                 bool
	authenticating          bool
	// challenged is `lastSignalingChallengeAtMs !== undefined`.
	challenged                 bool
	lastSignalingChallengeAtMs int64
	authenticated              *authenticatedSession

	// authStop stops the authentication deadline (T3); authGeneration is
	// bumped whenever the TS cleared the timer so a callback that lost the
	// Stop race sees it is stale (D5).
	authStop       func() bool
	authGeneration uint64

	// queue is the ws send buffer; queuedBytes is its bufferedAmount.
	queue       []outbound
	queuedBytes int
	wake        chan struct{}
	// closeQueued is readyState !== OPEN once close() was called: later
	// sends are dropped and later closes are no-ops, as with ws.
	closeQueued bool
	terminated  bool
	readerDone  chan struct{}
}

func newSession(conn *websocket.Conn, siteAccessAuthenticated bool) *session {
	ctx, cancel := context.WithCancel(context.Background())
	return &session{
		conn:                    conn,
		ctx:                     ctx,
		cancel:                  cancel,
		sessionID:               opaqueID(),
		alive:                   true,
		siteAccessAuthenticated: siteAccessAuthenticated,
		wake:                    make(chan struct{}, 1),
		readerDone:              make(chan struct{}),
	}
}

// open is `socket.readyState === WebSocket.OPEN`.
func (sess *session) open() bool {
	return !sess.closeQueued && !sess.terminated
}

func (sess *session) notify() {
	select {
	case sess.wake <- struct{}{}:
	default:
	}
}

// enqueue appends a text frame. mu must be held.
func (sess *session) enqueue(encoded []byte) {
	sess.queue = append(sess.queue, outbound{data: encoded})
	sess.queuedBytes += len(encoded)
	sess.notify()
}

// close is socket.close(code, reason): a no-op unless the socket is open.
// mu must be held.
func (sess *session) close(code websocket.StatusCode, reason string) {
	if !sess.open() {
		return
	}
	sess.closeQueued = true
	sess.queue = append(sess.queue, outbound{close: true, code: code, reason: reason})
	sess.notify()
}

// terminate is socket.terminate(): abrupt, no close frame. Cancelling the
// context closes the socket from inside the library, so nothing touches the
// connection under mu. mu must be held.
func (sess *session) terminate() {
	if sess.terminated {
		return
	}
	sess.terminated = true
	sess.cancel()
}

// clearAuthenticationTimer is clearTimeout(state.authenticationTimer).
func (sess *session) clearAuthenticationTimer() {
	if sess.authStop != nil {
		sess.authStop()
		sess.authStop = nil
	}
	sess.authGeneration++
}

// accept ports accept(): the slot is counted here, the two goroutines start
// here. mu must be held.
func (s *Server) accept(conn *websocket.Conn, siteAccessAuthenticated bool) *session {
	if !s.hasConnectionCapacity() {
		go func() { _ = conn.CloseNow() }()
		return nil
	}
	sess := newSession(conn, siteAccessAuthenticated)
	s.armAuthenticationTimer(sess)
	s.sessions.Set(sess, struct{}{})
	s.sessionsByID[sess.sessionID] = sess
	s.unauthenticatedConnections++
	go s.readLoop(sess)
	go s.writeLoop(sess)
	return sess
}

// armAuthenticationTimer is the setTimeout of accept() (T3). The TS timer
// fired blind; the generation check stands in for clearTimeout.
func (s *Server) armAuthenticationTimer(sess *session) {
	generation := sess.authGeneration
	sess.authStop = s.afterFunc(time.Duration(s.authenticationTimeoutMs)*time.Millisecond, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if sess.authGeneration != generation {
			return
		}
		sess.authStop = nil
		s.sendError(sess, "AUTH_REQUIRED", "Authentication timed out")
		sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication required")
	})
}

// readLoop is the "message" handler plus the "close" handler: it reads until
// the connection fails and then runs handleDisconnect exactly once (D6).
func (s *Server) readLoop(sess *session) {
	defer func() {
		defer close(sess.readerDone)
		sess.cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.handleDisconnect(sess)
	}()
	for {
		kind, data, err := sess.conn.Read(sess.ctx)
		if err != nil {
			return
		}
		s.handleIncoming(sess, kind, data)
	}
}

func (s *Server) handleIncoming(sess *session, kind websocket.MessageType, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == websocket.MessageBinary {
		// TS: if (isBinary) rejectInvalidMessage(socket)
		s.rejectInvalidMessage(sess)
	} else {
		s.handleMessage(sess, data)
	}
}

// writeLoop drains the outbound queue. Conn.Write and Conn.Close are only
// ever called here, never under mu (D4).
func (s *Server) writeLoop(sess *session) {
	for {
		s.mu.Lock()
		if len(sess.queue) == 0 {
			s.mu.Unlock()
			select {
			case <-sess.wake:
				continue
			case <-sess.ctx.Done():
				_ = sess.conn.CloseNow()
				return
			}
		}
		item := sess.queue[0]
		sess.queue[0] = outbound{}
		sess.queue = sess.queue[1:]
		s.mu.Unlock()
		if item.close {
			_ = sess.conn.Close(item.code, item.reason)
			return
		}
		err := sess.conn.Write(sess.ctx, websocket.MessageText, item.data)
		s.mu.Lock()
		sess.queuedBytes -= len(item.data)
		s.mu.Unlock()
		if err != nil {
			_ = sess.conn.CloseNow()
			return
		}
	}
}

// ping is the socket.ping() of heartbeat(), fired outside mu. The pong is
// read by readLoop; the timeout bounds the wait, it does not close the
// socket (the next heartbeat tick does, through alive).
func (sess *session) ping(timeout time.Duration) {
	ctx, cancel := context.WithTimeout(sess.ctx, timeout)
	defer cancel()
	_ = sess.conn.Ping(ctx)
}

// heartbeat ports heartbeat() (O11: insertion order). It returns the
// sessions to ping so the caller can do that after releasing mu.
func (s *Server) heartbeat() []*session {
	var pings []*session
	for sess := range s.sessions.All() {
		if !sess.alive {
			sess.terminate()
			continue
		}
		sess.alive = false
		pings = append(pings, sess)
	}
	return pings
}

// send ports send(): drop unless open, terminate above the buffer bound,
// otherwise queue the encoded message.
func (s *Server) send(sess *session, message protocol.ServerMessage) {
	encoded, err := protocol.EncodeServerMessage(message)
	if err != nil {
		// JSON.stringify of a server literal cannot fail; neither can this.
		panic(err)
	}
	s.sendEncoded(sess, encoded)
}

// sendEncoded is the shared body of send() and sendEncodedToSession().
func (s *Server) sendEncoded(sess *session, encoded []byte) {
	if !sess.open() {
		return
	}
	if sess.queuedBytes > maxBufferedSignalBytes {
		sess.terminate()
		return
	}
	sess.enqueue(encoded)
}

// sendToSession ports sendToSession().
func (s *Server) sendToSession(sessionID string, message protocol.ServerMessage) {
	if sess := s.sessionsByID[sessionID]; sess != nil {
		s.send(sess, message)
	}
}

// sendEncodedToSession ports sendEncodedToSession(): the same bytes go to
// every recipient (hazard 10).
func (s *Server) sendEncodedToSession(sessionID string, encoded []byte) {
	if sess := s.sessionsByID[sessionID]; sess != nil {
		s.sendEncoded(sess, encoded)
	}
}

func (s *Server) sendError(sess *session, code, message string) {
	s.send(sess, protocol.ErrorMessage{Type: "error", Code: code, Message: message})
}

// rejectInvalidMessage ports rejectInvalidMessage().
func (s *Server) rejectInvalidMessage(sess *session) {
	s.sendError(sess, "INVALID_MESSAGE", "Message is invalid")
	sess.close(websocket.StatusPolicyViolation, "Invalid message")
}
