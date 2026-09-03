package directpair

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/pion/datachannel"
	"github.com/pion/webrtc/v4"
)

const (
	pairingTimeout    = 30 * time.Second
	streamOpenTimeout = 15 * time.Second
	dialTimeout       = 3 * time.Second
	controlTimeout    = 5 * time.Second
	maxControlBytes   = 1024
	maxStreams        = 64
	copyBufferBytes   = 16 * 1024
)

type HostOptions struct {
	Invitation      string
	TargetAddress   string
	STUNURLs        []string
	IncludeLoopback bool
}

type ViewerOptions struct {
	ListenAddress   string
	IncludeLoopback bool
}

type Host struct {
	session *peerSession
	target  string
	path    string
	ready   chan error
	once    sync.Once
}

type Viewer struct {
	session     *peerSession
	listener    net.Listener
	invitation  chan invitationResult
	control     io.Closer
	controlOnce sync.Once
	mu          sync.Mutex
}

type invitationResult struct {
	path string
	err  error
}

type controlMessage struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Path    string `json:"path"`
}

func NewHost(ctx context.Context, options HostOptions) (*Host, string, error) {
	path, invitationPort, err := invitationPath(options.Invitation)
	if err != nil {
		return nil, "", err
	}
	target, targetPort, err := loopbackAddress(options.TargetAddress, false)
	if err != nil {
		return nil, "", errors.New("Host Local endpoint is invalid")
	}
	if invitationPort != targetPort {
		return nil, "", errors.New("Viewer invitation does not belong to this Local endpoint")
	}
	stunURLs, err := validateSTUNURLs(options.STUNURLs)
	if err != nil {
		return nil, "", err
	}
	session, err := newPeerSession(ctx, stunURLs, options.IncludeLoopback)
	if err != nil {
		return nil, "", err
	}
	host := &Host{
		session: session,
		target:  target,
		path:    path,
		ready:   make(chan error, 1),
	}
	session.connection.OnDataChannel(host.acceptStream)
	control, err := session.connection.CreateDataChannel(controlChannelLabel, nil)
	if err != nil {
		_ = host.Close()
		return nil, "", err
	}
	control.OnOpen(func() { host.openControl(control) })
	offer, err := localDescription(ctx, session.connection, webrtc.SDPTypeOffer)
	if err != nil {
		_ = host.Close()
		return nil, "", err
	}
	code, err := encodeDescription("offer", offer, stunURLs, targetPort)
	if err != nil {
		_ = host.Close()
		return nil, "", err
	}
	return host, code, nil
}

func (host *Host) AcceptAnswer(raw string) error {
	answer, _, _, err := decodeDescription(raw, "answer")
	if err != nil {
		return err
	}
	return host.session.connection.SetRemoteDescription(answer)
}

func (host *Host) WaitReady(ctx context.Context) error {
	timer := time.NewTimer(pairingTimeout)
	defer timer.Stop()
	select {
	case err := <-host.ready:
		return err
	case err := <-host.session.failed:
		return err
	case <-timer.C:
		return errors.New("direct Client pairing timed out")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (host *Host) Close() error {
	return host.session.Close()
}

func (host *Host) Done() <-chan struct{} {
	return host.session.done
}

func (host *Host) openControl(channel *webrtc.DataChannel) {
	raw, err := channel.DetachWithDeadline()
	if err == nil {
		payload, marshalErr := json.Marshal(controlMessage{
			Version: protocolVersion,
			Type:    "invitation",
			Path:    host.path,
		})
		if marshalErr != nil {
			err = marshalErr
		} else {
			_ = raw.SetWriteDeadline(time.Now().Add(controlTimeout))
			_, err = raw.Write(payload)
			_ = raw.SetWriteDeadline(time.Time{})
			if err == nil {
				host.session.keep(raw)
			} else {
				_ = raw.Close()
			}
		}
	}
	host.once.Do(func() { host.ready <- err })
}

func (host *Host) acceptStream(channel *webrtc.DataChannel) {
	if channel.Label() != streamChannelLabel {
		_ = channel.Close()
		return
	}
	slot := host.session.reserveStream()
	if slot == nil {
		_ = channel.Close()
		return
	}
	channel.OnClose(slot.Release)
	channel.OnOpen(func() {
		raw, err := channel.DetachWithDeadline()
		if err != nil {
			slot.Release()
			return
		}
		dialer := net.Dialer{Timeout: dialTimeout}
		local, err := dialer.DialContext(host.session.ctx, "tcp4", host.target)
		if err != nil {
			_ = raw.Close()
			slot.Release()
			return
		}
		host.session.bridge(local, raw, slot)
	})
}

func NewViewer(
	ctx context.Context,
	offerCode string,
	options ViewerOptions,
) (*Viewer, string, error) {
	offer, stunURLs, port, err := decodeDescription(offerCode, "offer")
	if err != nil {
		return nil, "", err
	}
	listenAddress := options.ListenAddress
	if listenAddress == "" {
		listenAddress = net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	}
	listenAddress, _, err = loopbackAddress(listenAddress, options.IncludeLoopback)
	if err != nil {
		return nil, "", errors.New("Viewer Local endpoint is invalid")
	}
	listener, err := net.Listen("tcp4", listenAddress)
	if err != nil {
		return nil, "", errors.New("Viewer Local endpoint is unavailable")
	}
	session, err := newPeerSession(ctx, stunURLs, options.IncludeLoopback)
	if err != nil {
		_ = listener.Close()
		return nil, "", err
	}
	viewer := &Viewer{
		session:    session,
		listener:   listener,
		invitation: make(chan invitationResult, 1),
	}
	session.connection.OnDataChannel(viewer.acceptControl)
	if err = session.connection.SetRemoteDescription(offer); err != nil {
		_ = viewer.Close()
		return nil, "", err
	}
	answer, err := localDescription(ctx, session.connection, webrtc.SDPTypeAnswer)
	if err != nil {
		_ = viewer.Close()
		return nil, "", err
	}
	code, err := encodeDescription("answer", answer, nil, 0)
	if err != nil {
		_ = viewer.Close()
		return nil, "", err
	}
	go viewer.serve()
	return viewer, code, nil
}

func (viewer *Viewer) WaitInvitation(ctx context.Context) (string, error) {
	timer := time.NewTimer(pairingTimeout)
	defer timer.Stop()
	select {
	case result := <-viewer.invitation:
		if result.err != nil {
			return "", result.err
		}
		_, port, err := net.SplitHostPort(viewer.listener.Addr().String())
		if err != nil {
			return "", errors.New("Viewer Local endpoint is invalid")
		}
		return "http://localhost:" + port + result.path, nil
	case err := <-viewer.session.failed:
		return "", err
	case <-timer.C:
		return "", errors.New("direct Client pairing timed out")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (viewer *Viewer) ListenAddress() string {
	return viewer.listener.Addr().String()
}

func (viewer *Viewer) Failed() <-chan error {
	return viewer.session.failed
}

func (viewer *Viewer) Close() error {
	viewer.mu.Lock()
	control := viewer.control
	viewer.control = nil
	viewer.mu.Unlock()
	if control != nil {
		_ = control.Close()
	}
	_ = viewer.listener.Close()
	return viewer.session.Close()
}

func (viewer *Viewer) acceptControl(channel *webrtc.DataChannel) {
	if channel.Label() != controlChannelLabel {
		_ = channel.Close()
		return
	}
	accepted := false
	viewer.controlOnce.Do(func() { accepted = true })
	if !accepted {
		_ = channel.Close()
		return
	}
	channel.OnOpen(func() {
		raw, err := channel.DetachWithDeadline()
		if err != nil {
			viewer.invitation <- invitationResult{err: err}
			return
		}
		_ = raw.SetReadDeadline(time.Now().Add(controlTimeout))
		buffer := make([]byte, maxControlBytes)
		count, readErr := raw.Read(buffer)
		_ = raw.SetReadDeadline(time.Time{})
		path, decodeErr := decodeControl(buffer[:count], readErr)
		if decodeErr != nil {
			_ = raw.Close()
			viewer.invitation <- invitationResult{err: decodeErr}
			return
		}
		viewer.mu.Lock()
		viewer.control = raw
		viewer.mu.Unlock()
		viewer.invitation <- invitationResult{path: path}
	})
}

func (viewer *Viewer) serve() {
	for {
		connection, err := viewer.listener.Accept()
		if err != nil {
			return
		}
		slot := viewer.session.reserveStream()
		if slot == nil {
			_ = connection.Close()
			continue
		}
		go viewer.openStream(connection, slot)
	}
}

func (viewer *Viewer) openStream(local net.Conn, slot *streamSlot) {
	channel, err := viewer.session.connection.CreateDataChannel(streamChannelLabel, nil)
	if err != nil {
		_ = local.Close()
		slot.Release()
		return
	}
	channel.OnClose(slot.Release)
	opened := make(chan datachannel.ReadWriteCloserDeadliner, 1)
	channel.OnOpen(func() {
		raw, detachErr := channel.DetachWithDeadline()
		if detachErr != nil {
			_ = channel.Close()
			return
		}
		opened <- raw
	})
	timer := time.NewTimer(streamOpenTimeout)
	defer timer.Stop()
	select {
	case raw := <-opened:
		viewer.session.bridge(local, raw, slot)
	case <-timer.C:
		_ = local.Close()
		_ = channel.Close()
		slot.Release()
	case <-viewer.session.ctx.Done():
		_ = local.Close()
		_ = channel.Close()
		slot.Release()
	}
}

func decodeControl(payload []byte, readErr error) (string, error) {
	if readErr != nil || len(payload) == 0 || len(payload) >= maxControlBytes {
		return "", errors.New("pairing control message is invalid")
	}
	var message controlMessage
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&message) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		message.Version != protocolVersion || message.Type != "invitation" ||
		!invitationPattern.MatchString(message.Path) {
		return "", errors.New("pairing control message is invalid")
	}
	return message.Path, nil
}

func loopbackAddress(raw string, allowZero bool) (string, int, error) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return "", 0, err
	}
	ip := net.ParseIP(host)
	portNumber, portErr := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || portErr != nil ||
		portNumber < 0 || portNumber > 65_535 || (!allowZero && portNumber == 0) {
		return "", 0, errors.New("endpoint must use a loopback address")
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(portNumber)), portNumber, nil
}

func localDescription(
	ctx context.Context,
	connection *webrtc.PeerConnection,
	descriptionType webrtc.SDPType,
) (webrtc.SessionDescription, error) {
	gathered := webrtc.GatheringCompletePromise(connection)
	var description webrtc.SessionDescription
	var err error
	if descriptionType == webrtc.SDPTypeOffer {
		description, err = connection.CreateOffer(nil)
	} else {
		description, err = connection.CreateAnswer(nil)
	}
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = connection.SetLocalDescription(description); err != nil {
		return webrtc.SessionDescription{}, err
	}
	timer := time.NewTimer(pairingTimeout)
	defer timer.Stop()
	select {
	case <-gathered:
		if connection.LocalDescription() == nil {
			return webrtc.SessionDescription{}, errors.New("pairing description is unavailable")
		}
		return *connection.LocalDescription(), nil
	case <-timer.C:
		return webrtc.SessionDescription{}, errors.New("pairing address discovery timed out")
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	}
}

func newPeerSession(
	parent context.Context,
	stunURLs []string,
	includeLoopback bool,
) (*peerSession, error) {
	if parent == nil {
		parent = context.Background()
	}
	settings := webrtc.SettingEngine{}
	settings.DetachDataChannels()
	settings.EnableDataChannelBlockWrite(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(includeLoopback)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	configuration := webrtc.Configuration{}
	if len(stunURLs) > 0 {
		configuration.ICEServers = []webrtc.ICEServer{{URLs: stunURLs}}
	}
	connection, err := api.NewPeerConnection(configuration)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	session := &peerSession{
		ctx:        ctx,
		cancel:     cancel,
		connection: connection,
		failed:     make(chan error, 1),
		done:       make(chan struct{}),
		streams:    make(map[*bridge]struct{}),
		slots:      make(chan struct{}, maxStreams),
		kept:       make(map[io.Closer]struct{}),
	}
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed ||
			(state == webrtc.PeerConnectionStateClosed && session.ctx.Err() == nil) {
			session.reportFailure(errors.New("direct Client pairing failed"))
		}
	})
	go func() {
		<-ctx.Done()
		_ = session.Close()
	}()
	return session, nil
}

type peerSession struct {
	ctx        context.Context
	cancel     context.CancelFunc
	connection *webrtc.PeerConnection
	failed     chan error
	done       chan struct{}
	slots      chan struct{}
	closeOnce  sync.Once
	wait       sync.WaitGroup

	mu      sync.Mutex
	streams map[*bridge]struct{}
	kept    map[io.Closer]struct{}
}

func (session *peerSession) reserveStream() *streamSlot {
	select {
	case session.slots <- struct{}{}:
		return &streamSlot{session: session}
	default:
		return nil
	}
}

type streamSlot struct {
	session *peerSession
	once    sync.Once
}

func (slot *streamSlot) Release() {
	slot.once.Do(func() { <-slot.session.slots })
}

func (session *peerSession) keep(closer io.Closer) {
	session.mu.Lock()
	if session.ctx.Err() != nil {
		session.mu.Unlock()
		_ = closer.Close()
		return
	}
	session.kept[closer] = struct{}{}
	session.mu.Unlock()
}

func (session *peerSession) bridge(
	local net.Conn,
	remote datachannel.ReadWriteCloserDeadliner,
	slot *streamSlot,
) {
	item := &bridge{local: local, remote: remote}
	session.mu.Lock()
	if session.ctx.Err() != nil {
		session.mu.Unlock()
		item.Close()
		slot.Release()
		return
	}
	session.streams[item] = struct{}{}
	session.wait.Add(1)
	session.mu.Unlock()
	go func() {
		defer session.wait.Done()
		item.Run()
		session.mu.Lock()
		delete(session.streams, item)
		session.mu.Unlock()
		slot.Release()
	}()
}

func (session *peerSession) reportFailure(err error) {
	select {
	case session.failed <- err:
	default:
	}
	go func() { _ = session.Close() }()
}

func (session *peerSession) Close() error {
	var closeErr error
	session.closeOnce.Do(func() {
		session.cancel()
		closeErr = session.connection.Close()
		session.mu.Lock()
		streams := make([]*bridge, 0, len(session.streams))
		for item := range session.streams {
			streams = append(streams, item)
		}
		kept := make([]io.Closer, 0, len(session.kept))
		for closer := range session.kept {
			kept = append(kept, closer)
		}
		session.mu.Unlock()
		for _, item := range streams {
			item.Close()
		}
		for _, closer := range kept {
			_ = closer.Close()
		}
		session.wait.Wait()
		close(session.done)
	})
	return closeErr
}

type bridge struct {
	local  net.Conn
	remote datachannel.ReadWriteCloserDeadliner
	once   sync.Once
}

func (item *bridge) Run() {
	done := make(chan struct{}, 2)
	copyOneWay := func(destination io.Writer, source io.Reader) {
		buffer := make([]byte, copyBufferBytes)
		_, _ = io.CopyBuffer(destination, source, buffer)
		done <- struct{}{}
	}
	go copyOneWay(item.remote, item.local)
	go copyOneWay(item.local, item.remote)
	<-done
	item.Close()
	<-done
}

func (item *bridge) Close() {
	item.once.Do(func() {
		_ = item.local.Close()
		_ = item.remote.Close()
	})
}
