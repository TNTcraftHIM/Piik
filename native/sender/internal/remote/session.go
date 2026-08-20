package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/media"
	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	maxHostEdges          = 2
	maxRemoteResponse     = 64 << 10
	remoteRequestTimeout  = 10 * time.Second
	signalWriteTimeout    = 5 * time.Second
	siteAccessTTL         = 12 * time.Hour
	nativeHostClaimTTL    = 5 * time.Minute
	privateViewerGrantTTL = 7 * 24 * time.Hour
	privateViewerPolicy   = "private-link"
)

var (
	roomCodePattern        = regexp.MustCompile(`^[1-9][0-9]{0,11}$`)
	hostTokenPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
	viewerGrantPattern     = regexp.MustCompile(`^g1\.([1-9][0-9]{0,11})\.([1-9][0-9]{0,12})\.[A-Za-z0-9_-]{43}$`)
	admissionCookiePattern = regexp.MustCompile(`^v1\.[1-9][0-9]{0,12}\.[A-Za-z0-9_-]{43}$`)
)

type Event struct {
	Kind           string              `json:"kind"`
	Message        string              `json:"message,omitempty"`
	ActiveViewers  int                 `json:"activeViewers,omitempty"`
	WaitingViewers int                 `json:"waitingViewers,omitempty"`
	Media          *media.Metrics      `json:"media,omitempty"`
	Audio          *media.AudioMetrics `json:"audio,omitempty"`
	Peers          []PeerDiagnostics   `json:"peers,omitempty"`
}

type StartOptions struct {
	BaseURL               *url.URL
	SiteAccessPassword     string
	Codec                 media.Codec
	EnableAudio           bool
	OnEvent               func(Event)
}

type Room struct {
	ID        string `json:"roomId"`
	InviteURL string `json:"inviteUrl"`
}

type Session struct {
	ctx             context.Context
	cancel          context.CancelFunc
	signalCtx       context.Context
	cancelSignal    context.CancelFunc
	baseURL         *url.URL
	httpClient      *http.Client
	room            Room
	hostToken       string
	clientID        string
	shareGeneration string
	onEvent         func(Event)

	mu               sync.Mutex
	writeMu          sync.Mutex
	conn             *websocket.Conn
	ice              iceConfig
	peers            map[string]*peer
	admission        *viewerAdmission
	fanout           *media.Fanout
	audioFanout      *media.AudioFanout
	codec            media.Codec
	peerAPI          *webrtc.API
	codecPreferences []webrtc.RTPCodecParameters
	closeOnce        sync.Once
	fatalOnce        sync.Once
	terminalOnce     sync.Once
	readDone         chan struct{}
	terminalResult   chan error
	readerStarted    atomic.Bool
	closing          atomic.Bool
}

type createRoomResponse struct {
	RoomID               string          `json:"roomId"`
	HostToken            string          `json:"hostToken"`
	InviteURL            string          `json:"inviteUrl"`
	ViewerPolicy         string          `json:"viewerPolicy"`
	ViewerGrantExpiresAt json.RawMessage `json:"viewerGrantExpiresAt"`
	ExpiresAt            json.RawMessage `json:"expiresAt"`
}

type siteAccessStatus struct {
	Required      *bool `json:"required"`
	Authenticated *bool `json:"authenticated"`
}

type createRoomRequest struct {
	ViewerPolicy        string `json:"viewerPolicy"`
	HostClaimTTLSeconds int    `json:"hostClaimTtlSeconds"`
}

type iceServer struct {
	URLs json.RawMessage `json:"urls"`
}

type iceConfig struct {
	IceServers []iceServer `json:"iceServers"`
}

func Start(parent context.Context, options StartOptions) (*Session, Room, error) {
	if options.BaseURL == nil {
		return nil, Room{}, errors.New("remote server URL is required")
	}
	codec := options.Codec
	if codec == "" {
		codec = media.CodecVP8
	}
	if _, ok := media.ParseCodec(string(codec)); !ok {
		return nil, Room{}, fmt.Errorf("unsupported native codec %q", codec)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, Room{}, fmt.Errorf("create in-memory cookie jar: %w", err)
	}
	httpClient := &http.Client{
		Jar:     jar,
		Timeout: remoteRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if err = authenticateHTTP(parent, httpClient, options.BaseURL, options.SiteAccessPassword); err != nil {
		return nil, Room{}, err
	}
	created, err := createRoom(parent, httpClient, options.BaseURL)
	if err != nil {
		return nil, Room{}, err
	}
	clientID, err := opaqueID()
	if err != nil {
		return nil, Room{}, fmt.Errorf("create sender identity: %w", err)
	}
	shareGeneration, err := opaqueID()
	if err != nil {
		return nil, Room{}, fmt.Errorf("create sharing generation: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	signalCtx, cancelSignal := context.WithCancel(context.WithoutCancel(parent))
	session := &Session{
		ctx:             ctx,
		cancel:          cancel,
		signalCtx:       signalCtx,
		cancelSignal:    cancelSignal,
		baseURL:         options.BaseURL,
		httpClient:      httpClient,
		room:            Room{ID: created.RoomID, InviteURL: created.InviteURL},
		hostToken:       created.HostToken,
		clientID:        clientID,
		shareGeneration: shareGeneration,
		codec:           codec,
		onEvent:         options.OnEvent,
		peers:           make(map[string]*peer),
		readDone:        make(chan struct{}),
		terminalResult:  make(chan error, 1),
	}
	session.fanout, err = media.NewFanoutWithCodec(codec,
		func() { session.emit(Event{Kind: "request-keyframe"}) },
		func(fatalErr error) { session.fail(fatalErr) },
	)
	if err != nil {
		cancel()
		return nil, Room{}, err
	}
	if options.EnableAudio {
		session.audioFanout, err = media.NewAudioFanout(func(fatalErr error) { session.fail(fatalErr) })
		if err != nil {
			session.close()
			return nil, Room{}, err
		}
	}
	session.peerAPI, session.codecPreferences, err = newPeerAPI(codec)
	if err != nil {
		session.close()
		return nil, Room{}, err
	}
	if err = session.connectWithRetry(parent); err != nil {
		session.close()
		return nil, Room{}, err
	}
	session.readerStarted.Store(true)
	go session.readLoop()
	go session.diagnosticsLoop()
	go session.closeWhenCanceled()
	return session, session.room, nil
}

func (session *Session) connectWithRetry(parent context.Context) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(parent, remoteRequestTimeout)
		err = session.connect(ctx)
		cancel()
		if err == nil {
			return nil
		}
		session.resetSignalingConnection()
		if parent.Err() != nil {
			break
		}
	}
	return err
}

func (session *Session) resetSignalingConnection() {
	session.mu.Lock()
	conn := session.conn
	session.conn = nil
	session.mu.Unlock()
	if conn != nil {
		conn.CloseNow()
	}
}

func (session *Session) WriteMedia(packet media.Packet) error {
	switch packet.Kind {
	case media.KindVideo:
		frame, err := packet.VideoFrame()
		if err == nil {
			err = session.fanout.Push(frame)
		}
		if err != nil {
			session.fail(fmt.Errorf("write encoded video: %w", err))
			return err
		}
		return nil
	case media.KindOpus:
		if session.audioFanout == nil {
			return errors.New("encoded audio was not enabled for this session")
		}
		if err := session.audioFanout.Push(packet); err != nil {
			session.fail(fmt.Errorf("write encoded audio: %w", err))
			return err
		}
		return nil
	default:
		return errors.New("local sender supplied an unsupported encoded media kind")
	}
}

func (session *Session) Codec() media.Codec {
	return session.codec
}

func (session *Session) AudioEnabled() bool { return session.audioFanout != nil }

func (session *Session) Stop() {
	session.close()
}

func (session *Session) Close() {
	session.close()
}

func (session *Session) Fail(err error) {
	session.fail(err)
}

func (session *Session) connect(ctx context.Context) error {
	signalURL := *session.baseURL
	if signalURL.Scheme == "https" {
		signalURL.Scheme = "wss"
	} else {
		signalURL.Scheme = "ws"
	}
	signalURL.Path = "/signal"
	header := http.Header{}
	header.Set("Origin", remoteOrigin(session.baseURL))
	conn, response, err := websocket.Dial(ctx, signalURL.String(), &websocket.DialOptions{
		HTTPClient: session.httpClient,
		HTTPHeader: header,
	})
	if err != nil {
		if response != nil {
			return fmt.Errorf("connect signaling: HTTP %d", response.StatusCode)
		}
		return errors.New("connect signaling failed")
	}
	conn.SetReadLimit(64 << 10)
	authenticate := authenticateMessage{
		Type:            "authenticate",
		Protocol:        signalingProtocol,
		RoomID:          session.room.ID,
		Role:            "host",
		Token:           session.hostToken,
		ClientID:        session.clientID,
		ShareGeneration: session.shareGeneration,
	}
	writeContext, cancel := context.WithTimeout(ctx, signalWriteTimeout)
	err = writeWebSocketJSON(writeContext, conn, authenticate)
	cancel()
	if err != nil {
		conn.CloseNow()
		return errors.New("authenticate signaling failed")
	}
	session.mu.Lock()
	session.conn = conn
	session.mu.Unlock()
	message, err := readServerMessage(ctx, conn)
	if err != nil {
		return errors.New("read signaling authentication failed")
	}
	if message.Type != "authenticated" || message.Role != "host" {
		return errors.New("signaling returned an invalid host authentication response")
	}
	if message.ViewerPolicy != privateViewerPolicy {
		return errors.New("signaling returned an unexpected room access policy")
	}
	session.mu.Lock()
	session.ice = message.IceConfig
	session.admission = newViewerAdmission(message.MaxViewers)
	session.mu.Unlock()
	// viewerPeerIds is a reconciliation roster and can include offline grace
	// members. Only ordered peer-joined messages allocate native media edges.
	session.emitViewerCounts()
	session.emit(Event{Kind: "remote-ready"})
	return nil
}

func (session *Session) readLoop() {
	defer close(session.readDone)
	conn := session.connection()
	for {
		message, err := readServerMessage(session.signalCtx, conn)
		if err != nil {
			if !session.closing.Load() {
				go session.fail(errors.New("remote signaling disconnected"))
			}
			return
		}
		if session.closing.Load() {
			switch message.Type {
			case "room-closed":
				if message.Reason == "host-ended" {
					session.completeTerminal(nil)
				} else {
					session.completeTerminal(errors.New("remote signaling returned an unexpected room closure"))
				}
				return
			default:
				continue
			}
		}
		if err = session.handle(message); err != nil {
			// The sole reader must remain available for the room-closed ACK while
			// the asynchronous fatal path performs the bounded terminal write.
			go session.fail(err)
		}
	}
}

func (session *Session) closeWhenCanceled() {
	select {
	case <-session.ctx.Done():
		session.close()
	case <-session.readDone:
	}
}

func (session *Session) completeTerminal(err error) {
	session.terminalOnce.Do(func() {
		session.terminalResult <- err
	})
}

func (session *Session) handle(message serverMessage) error {
	switch message.Type {
	case "peer-joined":
		return session.addViewer(message.PeerID)
	case "peer-left":
		return session.removeViewer(message.PeerID)
	case "signal":
		peer := session.peer(message.FromPeerID)
		if peer == nil {
			return nil
		}
		if err := peer.acceptSignal(message.Payload); err != nil {
			return fmt.Errorf("apply viewer signal: %w", err)
		}
	case "restart-request":
		peer := session.peer(message.FromPeerID)
		if peer == nil || peer.connectionID != message.ConnectionID {
			return nil
		}
		if message.Rebuild {
			return session.rebuildPeer(message.FromPeerID)
		} else if err := peer.restartICE(); err != nil {
			return fmt.Errorf("restart viewer ICE: %w", err)
		}
	case "viewer-quality-evidence":
		// Fixed-HIGH observes no viewer feedback; accepting this current-wire
		// message must not turn it into a room-wide quality controller.
		return nil
	case "error":
		return fmt.Errorf("remote signaling error %s", message.Code)
	case "room-closed":
		return fmt.Errorf("remote room closed: %s", message.Reason)
	}
	return nil
}

func (session *Session) addViewer(peerID string) error {
	session.mu.Lock()
	if session.admission == nil {
		session.mu.Unlock()
		return errors.New("viewer joined before host authentication completed")
	}
	action := session.admission.Join(peerID)
	session.mu.Unlock()
	switch action {
	case admissionDuplicate:
		return nil
	case admissionWait:
		session.emitViewerCounts()
		return nil
	case admissionFull:
		return errors.New("viewer presence exceeded the authenticated room capacity")
	case admissionActivate:
		if err := session.activatePeer(peerID); err != nil {
			session.mu.Lock()
			session.admission.AbortActivation(peerID)
			session.mu.Unlock()
			return err
		}
		session.emitViewerCounts()
		return nil
	default:
		return errors.New("viewer admission returned an invalid action")
	}
}

func (session *Session) activatePeer(peerID string) error {
	session.mu.Lock()
	configuration, err := pionConfiguration(session.ice)
	slot := session.availableSlotLocked()
	session.mu.Unlock()
	if err != nil {
		return err
	}
	if slot == 0 {
		return errors.New("native host edge budget is exhausted")
	}
	created, err := newPeer(session, peerID, slot, configuration)
	if err != nil {
		return err
	}
	session.mu.Lock()
	session.peers[peerID] = created
	session.mu.Unlock()
	if err = created.offer(false); err != nil {
		session.mu.Lock()
		delete(session.peers, peerID)
		session.mu.Unlock()
		created.close()
		return err
	}
	return nil
}

func (session *Session) removeViewer(peerID string) error {
	session.mu.Lock()
	peer := session.peers[peerID]
	delete(session.peers, peerID)
	if session.admission == nil {
		session.mu.Unlock()
		if peer != nil {
			peer.close()
		}
		return nil
	}
	_, promoted := session.admission.Leave(peerID)
	session.mu.Unlock()
	if peer != nil {
		peer.close()
	}
	if promoted != "" {
		if err := session.activatePeer(promoted); err != nil {
			session.mu.Lock()
			session.admission.AbortActivation(promoted)
			session.mu.Unlock()
			return fmt.Errorf("promote waiting viewer: %w", err)
		}
	}
	session.emitViewerCounts()
	return nil
}

func (session *Session) rebuildPeer(peerID string) error {
	session.mu.Lock()
	if session.admission == nil || !session.admission.IsActive(peerID) {
		session.mu.Unlock()
		return nil
	}
	old := session.peers[peerID]
	delete(session.peers, peerID)
	session.mu.Unlock()
	if old != nil {
		old.close()
	}
	if err := session.activatePeer(peerID); err != nil {
		session.mu.Lock()
		session.admission.AbortActivation(peerID)
		session.mu.Unlock()
		return err
	}
	return nil
}

func (session *Session) peer(peerID string) *peer {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.peers[peerID]
}

func (session *Session) connection() *websocket.Conn {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.conn
}

func (session *Session) send(value any) error {
	ctx, cancel := context.WithTimeout(session.signalCtx, signalWriteTimeout)
	defer cancel()
	return session.write(ctx, value, false)
}

func (session *Session) write(ctx context.Context, value any, terminal bool) error {
	session.writeMu.Lock()
	defer session.writeMu.Unlock()
	if session.closing.Load() && !terminal {
		return io.ErrClosedPipe
	}
	conn := session.connection()
	if conn == nil {
		return io.ErrClosedPipe
	}
	return writeWebSocketJSON(ctx, conn, value)
}

func writeWebSocketJSON(ctx context.Context, conn *websocket.Conn, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}

func (session *Session) sendSignal(targetPeerID string, payload any) error {
	return session.send(outboundSignalMessage{
		Type:         "signal",
		TargetPeerID: targetPeerID,
		Payload:      payload,
	})
}

func (session *Session) emit(event Event) {
	if session.onEvent != nil {
		session.onEvent(event)
	}
}

func (session *Session) emitViewerCounts() {
	session.mu.Lock()
	active, waiting := 0, 0
	if session.admission != nil {
		active, waiting = session.admission.Counts()
	}
	session.mu.Unlock()
	session.emit(Event{Kind: "viewer-count", ActiveViewers: active, WaitingViewers: waiting})
}

func (session *Session) diagnosticsLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-session.ctx.Done():
			return
		case now := <-ticker.C:
			session.mu.Lock()
			peers := make([]*peer, 0, len(session.peers))
			for _, activePeer := range session.peers {
				peers = append(peers, activePeer)
			}
			session.mu.Unlock()
			diagnostics := make([]PeerDiagnostics, 0, len(peers))
			for _, activePeer := range peers {
				diagnostics = append(diagnostics, activePeer.snapshot(now))
			}
			sort.Slice(diagnostics, func(left, right int) bool {
				return diagnostics[left].Slot < diagnostics[right].Slot
			})
			metrics := session.fanout.Snapshot()
			var audio *media.AudioMetrics
			if session.audioFanout != nil {
				value := session.audioFanout.Snapshot()
				audio = &value
			}
			session.emit(Event{Kind: "diagnostics", Media: &metrics, Audio: audio, Peers: diagnostics})
		}
	}
}

func (session *Session) availableSlotLocked() int {
	used := [maxHostEdges + 1]bool{}
	for _, activePeer := range session.peers {
		if activePeer.slot > 0 && activePeer.slot <= maxHostEdges {
			used[activePeer.slot] = true
		}
	}
	for slot := 1; slot <= maxHostEdges; slot++ {
		if !used[slot] {
			return slot
		}
	}
	return 0
}

func (session *Session) fail(err error) {
	if err == nil || session.closing.Load() {
		return
	}
	session.fatalOnce.Do(func() {
		session.emit(Event{Kind: "fatal", Message: err.Error()})
		session.close()
	})
}

func (session *Session) close() {
	session.closeOnce.Do(func() {
		session.closing.Store(true)
		if session.connection() != nil {
			terminalContext, cancelTerminal := context.WithTimeout(context.Background(), signalWriteTimeout)
			err := session.write(terminalContext, simpleMessage{Type: "abandon-room"}, true)
			confirmed := false
			if err == nil && session.readerStarted.Load() {
				select {
				case terminalErr := <-session.terminalResult:
					err = terminalErr
					confirmed = terminalErr == nil
				case <-session.readDone:
					select {
					case terminalErr := <-session.terminalResult:
						err = terminalErr
						confirmed = terminalErr == nil
					default:
						err = errors.New("remote signaling closed before room abandonment was acknowledged")
					}
				case <-terminalContext.Done():
					select {
					case terminalErr := <-session.terminalResult:
						err = terminalErr
						confirmed = terminalErr == nil
					default:
						err = terminalContext.Err()
					}
				}
			}
			cancelTerminal()
			if err != nil || !confirmed {
				session.emit(Event{Kind: "warning", Message: "The fresh room could not be removed before shutdown"})
			}
		}
		session.cancel()
		session.cancelSignal()
		session.mu.Lock()
		conn := session.conn
		session.conn = nil
		peers := make([]*peer, 0, len(session.peers))
		for _, peer := range session.peers {
			peers = append(peers, peer)
		}
		session.peers = make(map[string]*peer)
		session.mu.Unlock()
		session.fanout.Close()
		if session.audioFanout != nil {
			session.audioFanout.Close()
		}
		for _, peer := range peers {
			peer.close()
		}
		if conn != nil {
			_ = conn.Close(websocket.StatusNormalClosure, "sender stopped")
		}
	})
}

func authenticateHTTP(ctx context.Context, client *http.Client, base *url.URL, password string) error {
	endpoint := base.ResolveReference(&url.URL{Path: "/api/site-access"})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
	if err != nil {
		return errors.New("prepare site access request failed")
	}
	request.Header.Set("Origin", remoteOrigin(base))
	request.Header.Set("Accept", "application/json")
	if password != "" {
		request.Header.Set("Authorization", "Bearer "+password)
	}
	var status siteAccessStatus
	response, err := doJSON(client, request, &status)
	if err != nil {
		return fmt.Errorf("authenticate with the Screener site: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return errors.New("authenticate with the Screener site: unexpected success status")
	}
	if status.Required == nil || status.Authenticated == nil {
		return errors.New("authenticate with the Screener site: response is invalid")
	}
	if !*status.Authenticated {
		return errors.New("the Screener site did not authenticate this sender")
	}
	if err = validateSiteAccessCookie(response, client.Jar, base, *status.Required); err != nil {
		return fmt.Errorf("authenticate with the Screener site: %w", err)
	}
	return nil
}

func createRoom(ctx context.Context, client *http.Client, base *url.URL) (createRoomResponse, error) {
	endpoint := base.ResolveReference(&url.URL{Path: "/api/rooms"})
	payload, err := json.Marshal(createRoomRequest{
		ViewerPolicy:        privateViewerPolicy,
		HostClaimTTLSeconds: int(nativeHostClaimTTL / time.Second),
	})
	if err != nil {
		return createRoomResponse{}, errors.New("prepare room request failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return createRoomResponse{}, errors.New("prepare room request failed")
	}
	request.Header.Set("Origin", remoteOrigin(base))
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	var room createRoomResponse
	response, err := doJSON(client, request, &room)
	if err != nil {
		return createRoomResponse{}, fmt.Errorf("create Screener room: %w", err)
	}
	if response.StatusCode != http.StatusCreated {
		return createRoomResponse{}, errors.New("create Screener room: unexpected success status")
	}
	if err = validateCreatedRoom(room, base, time.Now()); err != nil {
		return createRoomResponse{}, fmt.Errorf("create Screener room: %w", err)
	}
	return room, nil
}

func doJSON(client *http.Client, request *http.Request, target any) (*http.Response, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("request failed")
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxRemoteResponse+1))
	if err != nil {
		return nil, errors.New("response read failed")
	}
	if len(payload) > maxRemoteResponse {
		return nil, errors.New("response is too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	if err = decodeStrict(payload, target); err != nil {
		return nil, errors.New("response is not valid current JSON")
	}
	return response, nil
}

func remoteOrigin(base *url.URL) string {
	return (&url.URL{Scheme: base.Scheme, Host: base.Host}).String()
}

func validateSiteAccessCookie(response *http.Response, jar http.CookieJar, base *url.URL, required bool) error {
	setCookies := response.Header.Values("Set-Cookie")
	if !required {
		if len(setCookies) != 0 {
			return errors.New("unexpected site access cookie")
		}
		return nil
	}
	if len(setCookies) != 1 {
		return errors.New("site access cookie is missing or ambiguous")
	}
	cookies := response.Cookies()
	if len(cookies) != 1 {
		return errors.New("site access cookie is invalid")
	}
	cookie := cookies[0]
	expectedName := "screener-site-access"
	if base.Scheme == "https" {
		expectedName = "__Host-screener-site-access"
	}
	if cookie.Name != expectedName || !admissionCookiePattern.MatchString(cookie.Value) ||
		cookie.Path != "/" || cookie.Domain != "" || cookie.MaxAge != int(siteAccessTTL/time.Second) ||
		!cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Secure != (base.Scheme == "https") ||
		cookie.Quoted || cookie.Partitioned || cookie.RawExpires != "" || !cookie.Expires.IsZero() || len(cookie.Unparsed) != 0 {
		return errors.New("site access cookie is invalid")
	}
	stored := jar.Cookies(base)
	if len(stored) != 1 || stored[0].Name != cookie.Name || stored[0].Value != cookie.Value {
		return errors.New("site access cookie was not retained")
	}
	return nil
}

func validateCreatedRoom(room createRoomResponse, base *url.URL, now time.Time) error {
	if !roomCodePattern.MatchString(room.RoomID) || !hostTokenPattern.MatchString(room.HostToken) ||
		room.ViewerPolicy != privateViewerPolicy ||
		len(room.InviteURL) < 1 || len(room.InviteURL) > 2048 {
		return errors.New("response is invalid")
	}
	viewerGrantExpiresAt, isNull, err := parseResponseTimestamp(room.ViewerGrantExpiresAt)
	if err != nil || isNull || !viewerGrantExpiresAt.After(now) ||
		viewerGrantExpiresAt.After(now.Add(privateViewerGrantTTL)) {
		return errors.New("response is invalid")
	}
	expiresAt, expiresAtIsNull, err := parseResponseTimestamp(room.ExpiresAt)
	if err != nil || expiresAtIsNull || !expiresAt.After(now) || viewerGrantExpiresAt.After(expiresAt) {
		return errors.New("response is invalid")
	}
	invite, err := url.Parse(room.InviteURL)
	if err != nil || invite.User != nil || invite.RawQuery != "" ||
		!strings.EqualFold(invite.Scheme, base.Scheme) || !strings.EqualFold(invite.Host, base.Host) ||
		invite.Path != "/r/"+room.RoomID || !strings.HasPrefix(invite.Fragment, "v=") {
		return errors.New("response is invalid")
	}
	grant := strings.TrimPrefix(invite.Fragment, "v=")
	match := viewerGrantPattern.FindStringSubmatch(grant)
	if len(match) != 3 || match[1] != room.RoomID {
		return errors.New("response is invalid")
	}
	grantExpiresAt, err := strconv.ParseInt(match[2], 10, 64)
	if err != nil || grantExpiresAt != viewerGrantExpiresAt.Unix() {
		return errors.New("response is invalid")
	}
	return nil
}

func parseResponseTimestamp(raw json.RawMessage) (time.Time, bool, error) {
	if len(raw) == 0 {
		return time.Time{}, false, errors.New("response field is missing")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return time.Time{}, true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return time.Time{}, false, errors.New("response timestamp is invalid")
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, false, errors.New("response timestamp is invalid")
	}
	return parsed, false, nil
}

func pionConfiguration(config iceConfig) (webrtc.Configuration, error) {
	servers := make([]webrtc.ICEServer, 0, len(config.IceServers))
	for _, server := range config.IceServers {
		var urls []string
		if err := json.Unmarshal(server.URLs, &urls); err != nil {
			var single string
			if secondErr := json.Unmarshal(server.URLs, &single); secondErr != nil || !validStunURL(single) {
				return webrtc.Configuration{}, errors.New("ICE server URLs are invalid")
			}
			urls = []string{single}
		}
		for index, value := range urls {
			if !validStunURL(value) {
				return webrtc.Configuration{}, errors.New("ICE server URLs are invalid")
			}
			urls[index] = "stun:" + value[len("stun:"):]
		}
		servers = append(servers, webrtc.ICEServer{
			URLs: urls,
		})
	}
	return webrtc.Configuration{ICEServers: servers}, nil
}
