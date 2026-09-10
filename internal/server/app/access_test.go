package app

import (
	"strings"
	"testing"
)

const testAccessPassword = "instance-access-password"

// newTestAccess builds a siteAccessGate over a mutable clock, mirroring the
// `now: () => now` injection used by tests/server-http.test.ts.
func newTestAccess(t *testing.T, options siteAccessOptions) *siteAccessGate {
	t.Helper()
	access, err := newSiteAccess(options)
	if err != nil {
		t.Fatalf("newSiteAccess: %v", err)
	}
	return access
}

// cookiePair is the test helper of the same name: the `name=value` pair of a
// Set-Cookie header, which is what a browser sends back.
func cookiePair(t *testing.T, setCookie string) string {
	t.Helper()
	if setCookie == "" {
		t.Fatal("expected a Set-Cookie value")
	}
	return strings.SplitN(setCookie, ";", 2)[0]
}

// Ports "reports status and issues a stateless 24-hour cookie".
func TestSiteAccessIssuesStatelessDayLongCookie(t *testing.T) {
	now := int64(1_000)
	access := newTestAccess(t, siteAccessOptions{
		Password: testAccessPassword,
		Now:      func() int64 { return now },
	})

	if !access.required() {
		t.Fatal("a configured password must make site access required")
	}
	if access.isAuthenticated("") {
		t.Fatal("a request without a cookie must not be authenticated")
	}
	if access.passwordMatches("wrong-password") {
		t.Fatal("a wrong password must be rejected")
	}
	if !access.passwordMatches(testAccessPassword) {
		t.Fatal("the configured password must be accepted")
	}

	setCookie := access.createCookie()
	if want := "piik-site-access=v1."; !strings.Contains(setCookie, want) {
		t.Fatalf("Set-Cookie %q does not contain %q", setCookie, want)
	}
	for _, attribute := range []string{"Path=/", "Max-Age=86400", "HttpOnly", "SameSite=Strict"} {
		if !strings.Contains(setCookie, attribute) {
			t.Fatalf("Set-Cookie %q is missing %q", setCookie, attribute)
		}
	}
	if strings.Contains(setCookie, "Secure") {
		t.Fatalf("Set-Cookie %q must not be Secure without HTTPS", setCookie)
	}
	if strings.Contains(setCookie, testAccessPassword) {
		t.Fatal("Set-Cookie must never carry the access password")
	}

	if !access.isAuthenticated(cookiePair(t, setCookie)) {
		t.Fatal("the freshly issued cookie must authenticate")
	}
}

// Ports the exact attribute order of createCookie, which app.ts writes verbatim
// into the Set-Cookie header.
func TestSiteAccessCookieAttributeOrder(t *testing.T) {
	insecure := newTestAccess(t, siteAccessOptions{
		Password:   testAccessPassword,
		Now:        func() int64 { return 1_000 },
		TTLSeconds: 12,
	})
	secure := newTestAccess(t, siteAccessOptions{
		Password:   testAccessPassword,
		Secure:     true,
		Now:        func() int64 { return 1_000 },
		TTLSeconds: 12,
	})

	signature := strings.Split(cookiePair(t, insecure.createCookie()), ".")[2]
	if len(signature) != 43 {
		t.Fatalf("signature %q is %d characters, want 43 (base64url, no padding)", signature, len(signature))
	}

	// now = 1000 ms -> floor(1) + 12 = 13 seconds.
	wantValue := "v1.13." + signature
	want := "piik-site-access=" + wantValue +
		"; Path=/; Max-Age=12; HttpOnly; SameSite=Strict"
	if got := insecure.createCookie(); got != want {
		t.Fatalf("CreateCookie() = %q, want %q", got, want)
	}
	wantSecure := "__Host-piik-site-access=" + wantValue +
		"; Path=/; Max-Age=12; HttpOnly; SameSite=Strict; Secure"
	if got := secure.createCookie(); got != wantSecure {
		t.Fatalf("secure CreateCookie() = %q, want %q", got, wantSecure)
	}
}

// Ports "uses a secure __Host- cookie for production HTTPS".
func TestSiteAccessUsesHostPrefixedCookieWhenSecure(t *testing.T) {
	access := newTestAccess(t, siteAccessOptions{
		Password: testAccessPassword,
		Secure:   true,
		Now:      func() int64 { return 1_000 },
	})
	setCookie := access.createCookie()

	for _, attribute := range []string{
		"__Host-piik-site-access=", "Secure", "HttpOnly", "SameSite=Strict", "Path=/",
	} {
		if !strings.Contains(setCookie, attribute) {
			t.Fatalf("Set-Cookie %q is missing %q", setCookie, attribute)
		}
	}
	if strings.Contains(setCookie, "Domain=") {
		t.Fatalf("Set-Cookie %q must not carry a Domain for a __Host- cookie", setCookie)
	}
	if !access.isAuthenticated(cookiePair(t, setCookie)) {
		t.Fatal("the secure cookie must authenticate under its own name")
	}
	// The cookie name is part of the signed identity only through the lookup;
	// an insecure instance never finds a __Host- cookie.
	insecure := newTestAccess(t, siteAccessOptions{
		Password: testAccessPassword,
		Now:      func() int64 { return 1_000 },
	})
	if insecure.isAuthenticated(cookiePair(t, setCookie)) {
		t.Fatal("the insecure instance must not read the __Host- cookie")
	}
}

// Ports "renews an authenticated cookie across successive idle deadlines".
func TestSiteAccessRenewsAcrossSuccessiveIdleDeadlines(t *testing.T) {
	now := int64(1_000)
	access := newTestAccess(t, siteAccessOptions{
		Password:   testAccessPassword,
		Now:        func() int64 { return now },
		TTLSeconds: 12,
	})

	originalCookie := cookiePair(t, access.createCookie())

	now = 7_000
	if !access.isAuthenticated(originalCookie) {
		t.Fatal("the original cookie must still be valid at 7s")
	}
	firstRenewedCookie := cookiePair(t, access.createCookie())
	if firstRenewedCookie == originalCookie {
		t.Fatal("a renewal at a later second must produce a different cookie")
	}

	now = 13_000
	if access.isAuthenticated(originalCookie) {
		t.Fatal("the original cookie must expire 12s after it was issued")
	}
	if !access.isAuthenticated(firstRenewedCookie) {
		t.Fatal("the first renewal must still be valid at 13s")
	}
	secondRenewedCookie := cookiePair(t, access.createCookie())
	if secondRenewedCookie == firstRenewedCookie {
		t.Fatal("the second renewal must differ from the first")
	}

	now = 20_000
	if access.isAuthenticated(firstRenewedCookie) {
		t.Fatal("the first renewal must expire 12s after it was issued")
	}
	if !access.isAuthenticated(secondRenewedCookie) {
		t.Fatal("the second renewal must still be valid at 20s")
	}
}

// Ports "rejects an expired or modified cookie" plus the parsing rules the HTTP
// scenarios only reach indirectly.
func TestSiteAccessRejectsExpiredOrTamperedCookies(t *testing.T) {
	now := int64(1_000)
	access := newTestAccess(t, siteAccessOptions{
		Password:   testAccessPassword,
		Now:        func() int64 { return now },
		TTLSeconds: 1,
	})
	cookie := cookiePair(t, access.createCookie())
	value := strings.SplitN(cookie, "=", 2)[1]
	segments := strings.Split(value, ".")

	if access.isAuthenticated(cookie + "x") {
		t.Fatal("an appended character must invalidate the signature")
	}

	other := newTestAccess(t, siteAccessOptions{
		Password:   "another-access-password",
		Now:        func() int64 { return now },
		TTLSeconds: 1,
	})
	if other.isAuthenticated(cookie) {
		t.Fatal("a cookie signed with a different password must be rejected")
	}

	// Expiry is compared against floor(now / 1000): 2000 ms is second 2 and the
	// cookie expires at second 2, so `expiresAt <= now` rejects it.
	now = 2_000
	if access.isAuthenticated(cookie) {
		t.Fatal("an expired cookie must be rejected")
	}
	now = 1_000

	name := strings.SplitN(cookie, "=", 2)[0]
	for _, testCase := range []struct {
		name   string
		cookie string
	}{
		{"no cookie header", ""},
		{"different cookie name", "other=" + value},
		{"empty value", name + "="},
		{"no equals sign", name},
		{"wrong version", name + "=v2." + segments[1] + "." + segments[2]},
		{"missing version", name + "=" + segments[1] + "." + segments[2]},
		{"extra segment", name + "=" + value + ".extra"},
		{"non-digit expiry", name + "=v1.1e3." + segments[2]},
		{"signed expiry", name + "=v1.+42." + segments[2]},
		{"empty expiry", name + "=v1.." + segments[2]},
		{"short signature", name + "=v1." + segments[1] + "." + segments[2][:42]},
		{"long signature", name + "=v1." + segments[1] + "." + segments[2] + "A"},
		{"padded signature", name + "=v1." + segments[1] + "." + segments[2][:42] + "="},
		{"unsafe expiry", name + "=v1.9007199254740992." + segments[2]},
	} {
		if access.isAuthenticated(testCase.cookie) {
			t.Errorf("%s: %q must not authenticate", testCase.name, testCase.cookie)
		}
	}

	// Surrounding cookies and whitespace are tolerated, as the TS reader is.
	for _, header := range []string{
		"a=1; " + cookie + "; b=2",
		"a=1;" + cookie,
		" " + name + " = " + value + " ",
	} {
		if !access.isAuthenticated(header) {
			t.Errorf("Cookie header %q must authenticate", header)
		}
	}
}

// Ports "is immediately authenticated when the access password is empty".
func TestSiteAccessWithoutPassword(t *testing.T) {
	access := newTestAccess(t, siteAccessOptions{Now: func() int64 { return 1_000 }})

	if access.required() {
		t.Fatal("an empty password must not require site access")
	}
	if !access.isAuthenticated("") {
		t.Fatal("every request must be authenticated without a password")
	}
	if !access.isAuthenticated("piik-site-access=nonsense") {
		t.Fatal("a bogus cookie must not matter without a password")
	}
	if !access.passwordMatches("") || !access.passwordMatches("anything") {
		t.Fatal("passwordMatches must be true without a password")
	}
	if got := access.createCookie(); got != "" {
		t.Fatalf("CreateCookie() = %q, want \"\" (TS returned undefined)", got)
	}
}

func TestNewSiteAccessTTLValidation(t *testing.T) {
	if _, err := newSiteAccess(siteAccessOptions{Password: testAccessPassword, TTLSeconds: -1}); err == nil {
		t.Fatal("a negative TTL must be rejected")
	}
	access := newTestAccess(t, siteAccessOptions{
		Password: testAccessPassword,
		Now:      func() int64 { return 0 },
	})
	if !strings.Contains(access.createCookie(), "Max-Age=86400") {
		t.Fatal("an unset TTL must default to 24 hours")
	}
}
