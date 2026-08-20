package app

import (
	"net/http/httptest"
	"testing"
)

func TestNormalizeRemoteBaseAllowsHTTPSAndLoopbackHTTPOnly(t *testing.T) {
	valid := []string{
		"https://share.example.test",
		"http://127.0.0.1:3000",
		"http://[::1]:3000",
		"http://localhost:3000",
	}
	for _, value := range valid {
		if _, err := normalizeRemoteBase(value); err != nil {
			t.Fatalf("valid remote base %q: %v", value, err)
		}
	}
	invalid := []string{
		"http://share.example.test",
		"https://user@example.test",
		"https://example.test/path",
		"https://example.test/?query=1",
		"https://example.test/#fragment",
	}
	for _, value := range invalid {
		if _, err := normalizeRemoteBase(value); err == nil {
			t.Fatalf("invalid remote base %q was accepted", value)
		}
	}
}

func TestExactRequestRequiresBothHostAndOrigin(t *testing.T) {
	request := httptest.NewRequest("GET", "http://127.0.0.1:9000/media", nil)
	request.Host = "127.0.0.1:9000"
	request.Header.Set("Origin", "http://127.0.0.1:9000")
	if !exactRequest(request, "127.0.0.1:9000", "http://127.0.0.1:9000") {
		t.Fatal("exact loopback request was rejected")
	}
	request.Header.Set("Origin", "http://localhost:9000")
	if exactRequest(request, "127.0.0.1:9000", "http://127.0.0.1:9000") {
		t.Fatal("alternate loopback origin was accepted")
	}
	request.Header.Set("Origin", "http://127.0.0.1:9000")
	request.Host = "localhost:9000"
	if exactRequest(request, "127.0.0.1:9000", "http://127.0.0.1:9000") {
		t.Fatal("alternate Host was accepted")
	}
}

func TestProcessTokenComparisonIsExact(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef0123456789abcdef"
	if !tokenMatches(token, token) {
		t.Fatal("equal token did not match")
	}
	if tokenMatches(token+"x", token) || tokenMatches(token[:len(token)-1]+"x", token) {
		t.Fatal("different token matched")
	}
}
