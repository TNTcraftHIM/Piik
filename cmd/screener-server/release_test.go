package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	deployedRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	latestRevision   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	latestReleaseURL = "https://github.com/TNTcraftHIM/Screener/releases/tag/" + latestRevision
	latestRelease    = `{"tag_name":"` + latestRevision + `","html_url":"` + latestReleaseURL + `"}`
)

func TestParseReleaseMetadataAcceptsOnlyTheStrictReleaseIdentity(t *testing.T) {
	tagged := func(page string) string {
		return `{"tag_name":"` + latestRevision + `","html_url":"` + page + `"}`
	}
	testCases := []struct {
		name     string
		payload  string
		revision string
		url      string
	}{
		{"published release", latestRelease, latestRevision, latestReleaseURL},
		{
			"uppercase tag normalizes",
			`{"tag_name":"` + strings.ToUpper(latestRevision) + `","html_url":"` + latestReleaseURL + `"}`,
			latestRevision, latestReleaseURL,
		},
		{"short tag", `{"tag_name":"short","html_url":"` + latestReleaseURL + `"}`, "", ""},
		{"other host", tagged("https://evil.example"), "", ""},
		{
			"userinfo",
			tagged("https://user@github.com/TNTcraftHIM/Screener/releases/tag/" + latestRevision),
			"", "",
		},
		{
			"port",
			tagged("https://github.com:8443/TNTcraftHIM/Screener/releases/tag/" + latestRevision),
			"", "",
		},
		{
			"plaintext page",
			tagged("http://github.com/TNTcraftHIM/Screener/releases/tag/" + latestRevision),
			"", "",
		},
		{"query", tagged(latestReleaseURL + "?asset=1"), "", ""},
		{"fragment", tagged(latestReleaseURL + "#assets"), "", ""},
		{
			"encoded path separator",
			tagged("https://github.com/TNTcraftHIM%2FScreener/releases/tag/" + latestRevision),
			"", "",
		},
		{
			"page tag disagrees with the release tag",
			tagged("https://github.com/TNTcraftHIM/Screener/releases/tag/" + deployedRevision),
			"", "",
		},
		{
			"draft",
			`{"tag_name":"` + latestRevision + `","html_url":"` + latestReleaseURL + `","draft":true}`,
			"", "",
		},
		{
			"prerelease",
			`{"tag_name":"` + latestRevision + `","html_url":"` + latestReleaseURL + `","prerelease":true}`,
			"", "",
		},
		{"missing page", `{"tag_name":"` + latestRevision + `"}`, "", ""},
		{"array payload", `[]`, "", ""},
		{"not an object", `"released"`, "", ""},
		{"not json", `nonsense`, "", ""},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			revision, releaseURL, ok := parseReleaseMetadata([]byte(testCase.payload))
			if ok != (testCase.revision != "") || revision != testCase.revision ||
				releaseURL != testCase.url {
				t.Fatalf("parseReleaseMetadata(%s) = %q, %q, %t; want %q, %q",
					testCase.payload, revision, releaseURL, ok, testCase.revision, testCase.url)
			}
		})
	}
}

func TestCheckReleaseReportsTheDeployedComparison(t *testing.T) {
	testCases := []struct {
		name            string
		current         string
		status          int
		body            string
		wantStatus      string
		wantCurrent     string
		wantLatest      string
		wantReleaseURL  string
		wantRequestSent bool
	}{
		{
			name: "newer release", current: deployedRevision, status: http.StatusOK,
			body: latestRelease, wantStatus: "update-available", wantCurrent: deployedRevision,
			wantLatest: latestRevision, wantReleaseURL: latestReleaseURL, wantRequestSent: true,
		},
		{
			name: "same release", current: latestRevision, status: http.StatusOK,
			body: latestRelease, wantStatus: "up-to-date", wantCurrent: latestRevision,
			wantLatest: latestRevision, wantReleaseURL: latestReleaseURL, wantRequestSent: true,
		},
		{
			name: "endpoint unavailable", current: deployedRevision,
			status: http.StatusServiceUnavailable, body: "offline",
			wantStatus: "unavailable", wantCurrent: deployedRevision, wantRequestSent: true,
		},
		{
			name: "unusable metadata", current: deployedRevision, status: http.StatusOK,
			body: `{"tag_name":"v1","html_url":"https://evil.example"}`,
			// The published page failed validation, so no update is claimed.
			wantStatus: "unavailable", wantCurrent: deployedRevision, wantRequestSent: true,
		},
		{
			name: "deployed revision is not a release", current: "development",
			status: http.StatusOK, body: latestRelease,
			// No request at all: the check cannot compare an unknown deployment.
			wantStatus: "unavailable", wantCurrent: "", wantRequestSent: false,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			requested := false
			server := httptest.NewServer(http.HandlerFunc(
				func(writer http.ResponseWriter, request *http.Request) {
					requested = true
					if got := request.Header.Get("Accept"); got != "application/vnd.github+json" {
						t.Errorf("Accept = %q", got)
					}
					if got := request.Header.Get("X-GitHub-Api-Version"); got != "2022-11-28" {
						t.Errorf("X-GitHub-Api-Version = %q", got)
					}
					if got := request.Header.Get("User-Agent"); got != "Screener-release-check" {
						t.Errorf("User-Agent = %q", got)
					}
					writer.WriteHeader(testCase.status)
					_, _ = writer.Write([]byte(testCase.body))
				}))
			defer server.Close()

			result := checkRelease(t.Context(), testCase.current, server.URL, "")
			if requested != testCase.wantRequestSent {
				t.Fatalf("endpoint requested = %t; want %t", requested, testCase.wantRequestSent)
			}
			assertResult(t, result, testCase.wantStatus, testCase.wantCurrent,
				testCase.wantLatest, testCase.wantReleaseURL)
		})
	}
}

func TestCheckReleaseFailsClosedWithoutAUsableEndpoint(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			http.Redirect(writer, request, "https://evil.example/releases", http.StatusFound)
		}))
	defer redirect.Close()
	reachable := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(latestRelease))
		}))
	defer reachable.Close()

	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	testCases := []struct {
		name   string
		ctx    context.Context
		apiURL string
	}{
		{"redirected endpoint", t.Context(), redirect.URL},
		{"unsupported scheme", t.Context(), "file:///etc/passwd"},
		{"relative endpoint", t.Context(), "releases/latest"},
		{"cancelled check", cancelled, reachable.URL},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			result := checkRelease(testCase.ctx, deployedRevision, testCase.apiURL, "")
			assertResult(t, result, "unavailable", deployedRevision, "", "")
		})
	}
}

func TestOperatorTokenReachesGitHubOnly(t *testing.T) {
	endpoints := []struct {
		name       string
		url        string
		token      string
		authorized bool
	}{
		{"github api", defaultReleaseAPIURL, "operator-token", true},
		{"github api with padded token", defaultReleaseAPIURL, "  operator-token  ", true},
		{"github api without a token", defaultReleaseAPIURL, "   ", false},
		{"plaintext github api", "http://api.github.com/repos", "operator-token", false},
		{"release host", "https://github.com/repos", "operator-token", false},
		{"local fixture", "http://127.0.0.1:8787/releases/latest", "operator-token", false},
		{"lookalike host", "https://api.github.com.evil.example/x", "operator-token", false},
	}
	for _, endpoint := range endpoints {
		t.Run(endpoint.name, func(t *testing.T) {
			parsed, err := url.Parse(endpoint.url)
			if err != nil {
				t.Fatal(err)
			}
			if got := authorizesGitHub(parsed, endpoint.token); got != endpoint.authorized {
				t.Fatalf("authorizesGitHub(%q) = %t; want %t",
					endpoint.url, got, endpoint.authorized)
			}
		})
	}

	var received http.Header
	fixture := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			received = request.Header.Clone()
			_, _ = writer.Write([]byte(latestRelease))
		}))
	defer fixture.Close()
	checkRelease(t.Context(), deployedRevision, fixture.URL, "fixture-secret")
	if authorization := received.Get("Authorization"); authorization != "" {
		t.Fatalf("fixture endpoint received %q", authorization)
	}
}

func TestCheckDeployedReleasePrintsOneLineAndTheOperatorExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(latestRelease))
		}))
	defer server.Close()

	testCases := []struct {
		name     string
		revision string
		wantCode int
		wantJSON string
	}{
		{
			"update available", deployedRevision + "\n", exitUpdateAvailable,
			`{"status":"update-available","currentRevision":"` + deployedRevision +
				`","latestRevision":"` + latestRevision +
				`","releaseUrl":"` + latestReleaseURL + `"}`,
		},
		{
			"up to date", latestRevision, exitUpToDate,
			`{"status":"up-to-date","currentRevision":"` + latestRevision +
				`","latestRevision":"` + latestRevision +
				`","releaseUrl":"` + latestReleaseURL + `"}`,
		},
		{
			"unreadable deployment", "", exitUpdateUnavailable,
			`{"status":"unavailable","currentRevision":null,` +
				`"latestRevision":null,"releaseUrl":null}`,
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			currentFile := filepath.Join(t.TempDir(), "REVISION")
			if testCase.revision != "" {
				if err := os.WriteFile(currentFile, []byte(testCase.revision), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var out bytes.Buffer
			code := checkDeployedRelease(t.Context(), currentFile, server.URL, &out)
			if code != testCase.wantCode || out.String() != testCase.wantJSON+"\n" {
				t.Fatalf("checkDeployedRelease = %d, %q; want %d, %q",
					code, out.String(), testCase.wantCode, testCase.wantJSON+"\n")
			}
		})
	}
}

// assertResult compares the whole result through its JSON form so a value that
// must be null is distinguished from one that is merely empty.
func assertResult(t *testing.T, result releaseResult, status, current, latest, releaseURL string) {
	t.Helper()
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := json.Marshal(releaseResult{
		Status:          status,
		CurrentRevision: reported(current),
		LatestRevision:  reported(latest),
		ReleaseURL:      reported(releaseURL),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, expected) {
		t.Fatalf("result = %s; want %s", payload, expected)
	}
}

// reported turns the empty test expectation into the JSON null the result uses.
func reported(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// release-update.mjs parseArguments threw the usage string and set
// process.exitCode = 2 when --current-file was absent, so the operator could
// tell a forgotten argument from a check that could not reach GitHub.
func TestCheckDeployedReleaseWithoutACurrentFileIsAUsageError(t *testing.T) {
	var out bytes.Buffer
	code := checkDeployedRelease(context.Background(), "", defaultReleaseAPIURL, &out)
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if out.Len() != 0 {
		t.Fatalf("a usage error wrote %q, want no result line", out.String())
	}
}
