package app

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/failure"
	"github.com/TNTcraftHIM/Piik/internal/app/lan"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestLocalHTTPSAndLoopbackShareRoomAuthority(t *testing.T) {
	addresses, err := lan.Addresses()
	if err != nil || len(addresses) == 0 {
		t.Skip("Local App integration needs an active IPv4 interface")
	}
	reservation, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reservation.Addr().(*net.TCPAddr).Port
	defer reservation.Close()
	ctx, cancel := context.WithCancel(t.Context())
	control, err := loopback.Start(ctx, loopback.Options{})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	_ = reservation.Close()
	ready, done := make(chan string, 1), make(chan error, 1)
	go func() {
		done <- runLocal(ctx, Options{Local: true, Port: port, LANAddress: addresses[0],
			DisableBrowser: true, console: newConsole(cancel, true),
			Ready: func(target string) { ready <- target },
		}, appconfig.Config{LocalAccessPassword: "test local passphrase"}, control)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(8 * time.Second):
			t.Error("Local HTTP/TLS service did not retire")
		}
		_ = control.Close()
		for _, address := range []string{"127.0.0.1", addresses[0]} {
			listener, err := net.Listen("tcp4", net.JoinHostPort(address, fmt.Sprint(port)))
			if err != nil {
				t.Errorf("Local listener survived shutdown: %v", err)
			} else {
				_ = listener.Close()
			}
		}
	})
	select {
	case target := <-ready:
		if !strings.HasPrefix(target, fmt.Sprintf("http://127.0.0.1:%d/", port)) {
			t.Fatal("Host lost its stable loopback entry")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Local App did not become ready")
	}
	lanOrigin := fmt.Sprintf("https://%s:%d", addresses[0], port)
	// Only this isolated fixture accepts its unknown certificate to inspect it.
	// All subsequent requests verify that certificate and the selected LAN IP.
	connection, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp4",
		net.JoinHostPort(addresses[0], fmt.Sprint(port)), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	certificate := connection.ConnectionState().PeerCertificates[0]
	_ = connection.Close()
	if certificate.IsCA || certificate.VerifyHostname(addresses[0]) != nil ||
		certificate.CheckSignature(certificate.SignatureAlgorithm, certificate.RawTBSCertificate, certificate.Signature) != nil {
		t.Fatal("Local certificate must be self-signed, scoped to the LAN IP and not a CA")
	}
	t.Logf("Local certificate SHA-256: %X", sha256.Sum256(certificate.Raw))
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
	t.Cleanup(transport.CloseIdleConnections)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Transport: transport, Jar: jar, Timeout: 2 * time.Second}
	request := func(origin, path, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, origin+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = response.Body.Close() })
		return response
	}
	for _, origin := range []string{fmt.Sprintf("http://127.0.0.1:%d", port), lanOrigin} {
		login := request(origin, "/api/site-access", `{"password":"test local passphrase"}`)
		cookies := login.Cookies()
		if login.StatusCode != http.StatusOK || len(cookies) != 1 || cookies[0].Secure != strings.HasPrefix(origin, "https:") {
			t.Fatalf("wrong Local admission cookie at %s: status=%d cookies=%v", origin, login.StatusCode, cookies)
		}
	}
	created := request(fmt.Sprintf("http://127.0.0.1:%d", port), "/api/rooms", `{"codeEntryPolicy":"open"}`)
	var room protocol.CreateRoomResponse
	if err := json.NewDecoder(created.Body).Decode(&room); err != nil || created.StatusCode != http.StatusCreated ||
		!strings.HasPrefix(room.InviteURL, lanOrigin+"/r/") {
		t.Fatalf("Local room did not produce its HTTPS invitation: status=%d err=%v", created.StatusCode, err)
	}
	req, _ := http.NewRequest(http.MethodPost, lanOrigin+"/api/rooms/"+room.RoomID+"/access",
		strings.NewReader(`{"action":"set-code-entry-policy","policy":"private"}`))
	req.Header.Set("Origin", lanOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+room.HostToken)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("TLS entry did not share loopback room authority: %d", response.StatusCode)
	}
}

func TestLocalPortCollisionReleasesTheOtherEntry(t *testing.T) {
	addresses, err := lan.Addresses()
	if err != nil || len(addresses) == 0 {
		t.Skip("Local App integration needs an active IPv4 interface")
	}
	for _, test := range []struct{ network, address string }{
		{"tcp4", "127.0.0.1"}, {"tcp4", addresses[0]}, {"udp4", addresses[0]},
	} {
		t.Run(test.network+"/"+test.address, func(t *testing.T) {
			control, err := loopback.Start(t.Context(), loopback.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer control.Close()
			var occupied io.Closer
			var reservation net.Listener
			var port int
			if test.network == "udp4" {
				// A UDP allocation alone says nothing about the same TCP port.
				// Reserve both Local HTTP addresses until the UDP fixture is ready.
				reservation, err = net.Listen("tcp4", "0.0.0.0:0")
				if err != nil {
					t.Fatal(err)
				}
				defer reservation.Close()
				port = reservation.Addr().(*net.TCPAddr).Port
				socket, err := net.ListenPacket("udp4", net.JoinHostPort(test.address, fmt.Sprint(port)))
				if err != nil {
					t.Fatal(err)
				}
				occupied = socket
			} else {
				socket, err := net.Listen("tcp4", net.JoinHostPort(test.address, "0"))
				if err != nil {
					t.Fatal(err)
				}
				occupied, port = socket, socket.Addr().(*net.TCPAddr).Port
			}
			defer occupied.Close()
			if reservation != nil {
				_ = reservation.Close()
			}
			err = runLocal(t.Context(), Options{Local: true, Port: port, LANAddress: addresses[0],
				DisableBrowser: true, console: newConsole(func() {}, true),
				Ready: func(string) { t.Error("occupied Local service reported readiness") },
			}, appconfig.Config{}, control)
			if !errors.Is(err, failure.LocalPort) {
				t.Fatalf("occupied entry error = %v", err)
			}
			for _, otherAddress := range []string{"127.0.0.1", addresses[0]} {
				if test.network == "tcp4" && otherAddress == test.address {
					continue
				}
				listener, err := net.Listen("tcp4", net.JoinHostPort(otherAddress, fmt.Sprint(port)))
				if err != nil {
					t.Fatalf("failed startup left another entry bound: %v", err)
				}
				_ = listener.Close()
			}
		})
	}
}
