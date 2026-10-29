//go:build android && silip_cloudflared

// Silip's Android adapter for the pinned cloudflared executable. See README.md.
package main

/*
#cgo LDFLAGS: -landroid
#include <android/multinetwork.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>

static int silip_dns_wait(int query, int cancel) {
    struct pollfd fds[2] = {{query, POLLIN, 0}, {cancel, POLLIN, 0}};
    int result;
    do { result = poll(fds, 2, -1); } while (result < 0 && errno == EINTR);
    if (result < 0) return -errno;
    return fds[1].revents ? 0 : 1;
}
*/
import "C"

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

func init() {
	// A/AAAA via libc alone is insufficient: Go's SRV/TXT lookups use its DNS
	// client. Route that client's raw messages through Android's system resolver.
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: dialAndroidDNS}
}

type androidDNSConn struct {
	net.Conn
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	err    error
}

func (c *androidDNSConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil {
		c.mu.Lock()
		if c.err != nil {
			err = c.err
		} else if c.ctx.Err() != nil {
			err = c.ctx.Err()
		}
		c.mu.Unlock()
	}
	return n, err
}

func (c *androidDNSConn) Close() error {
	c.cancel()
	err := c.Conn.Close()
	<-c.done
	return err
}

func dialAndroidDNS(parent context.Context, _, _ string) (net.Conn, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	client, server := net.Pipe()
	c := &androidDNSConn{Conn: client, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(c.done)
		defer server.Close()
		defer cancel()
		stop := context.AfterFunc(ctx, func() { _ = server.Close() })
		defer stop()
		err := relayAndroidDNS(ctx, server)
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		c.mu.Lock()
		c.err = err
		c.mu.Unlock()
	}()
	return c, nil
}

func relayAndroidDNS(ctx context.Context, stream net.Conn) error {
	// net.Pipe is a stream, so stock net.Resolver supplies the DNS TCP length
	// prefix even when its original Dial request says UDP. No DNS parsing here.
	var header [2]byte
	if _, err := io.ReadFull(stream, header[:]); err != nil {
		return err
	}
	query := make([]byte, int(binary.BigEndian.Uint16(header[:])))
	if len(query) == 0 {
		return syscall.EINVAL
	}
	if _, err := io.ReadFull(stream, query); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// NETWORK_UNSPECIFIED preserves the process/default network, including VPN
	// and Android Private DNS. The returned descriptor has exactly one owner.
	fd := C.android_res_nsend(C.NETWORK_UNSPECIFIED, (*C.uint8_t)(unsafe.Pointer(&query[0])), C.size_t(len(query)), 0)
	if fd < 0 {
		return syscall.Errno(-fd)
	}
	answer, err := readAndroidDNS(ctx, fd)
	if err != nil {
		return err
	}
	binary.BigEndian.PutUint16(header[:], uint16(len(answer)))
	if _, err = stream.Write(header[:]); err != nil {
		return err
	}
	_, err = stream.Write(answer)
	return err
}

// readAndroidDNS owns fd on entry. nresult closes it on every return; every
// other path calls cancel (which also closes it). They never run concurrently.
func readAndroidDNS(ctx context.Context, fd C.int) ([]byte, error) {
	defer func() {
		if fd >= 0 {
			C.android_res_cancel(fd)
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	defer w.Close()
	stop := context.AfterFunc(ctx, func() { _, _ = w.Write([]byte{1}) })
	defer stop()
	ready := C.silip_dns_wait(fd, C.int(r.Fd()))
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if ready < 0 {
		return nil, syscall.Errno(-ready)
	}
	answer := make([]byte, 65535)
	var rcode C.int
	n := C.android_res_nresult(fd, &rcode, (*C.uint8_t)(unsafe.Pointer(&answer[0])), C.size_t(len(answer)))
	fd = -1 // nresult consumed ownership, including errors.
	if n < 0 {
		return nil, syscall.Errno(-n)
	}
	return answer[:int(n)], nil
}
