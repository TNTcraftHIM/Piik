package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

const (
	deployedVersion  = "v1.9.0"
	latestVersion    = "v1.10.0"
	deployedRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	latestRevision   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	latestReleaseURL = "https://github.com/TNTcraftHIM/Piik/releases/tag/" + latestVersion
	latestRelease    = `{"tag_name":"` + latestVersion + `","html_url":"` + latestReleaseURL + `","target_commitish":"` + latestRevision + `"}`
)

func TestReleaseNoticeUsesOperatorLogsOnlyForAvailableChoices(t *testing.T) {
	for _, status := range []string{statusUpdateAvailable, statusDifferentBuild, statusOfficialRelease, statusUpToDate, statusUnavailable} {
		t.Run(status, func(t *testing.T) {
			var output bytes.Buffer
			version, releaseURL := latestVersion, latestReleaseURL
			logReleaseNotice(slog.New(slog.NewJSONHandler(&output, nil)), releaseResult{
				Status: status, LatestVersion: &version, ReleaseURL: &releaseURL,
			})
			if status == statusUpToDate || status == statusUnavailable {
				if output.Len() != 0 {
					t.Fatalf("non-actionable check produced a notice: %s", output.String())
				}
				return
			}
			var entry map[string]any
			if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["status"] != status || entry["currentVersion"] != "development" ||
				entry["latestVersion"] != latestVersion || entry["releaseUrl"] != latestReleaseURL || entry["level"] != "INFO" {
				t.Fatalf("release notice lost its version or download action: %v", entry)
			}
			if status == statusDifferentBuild && strings.Contains(entry["msg"].(string), "newer") {
				t.Fatal("SHA inequality was presented as release ordering")
			}
		})
	}
}

func TestParseReleaseMetadataAcceptsOnlyTheStrictReleaseIdentity(t *testing.T) {
	tagged := func(version, page string) string {
		return `{"tag_name":"` + version + `","html_url":"` + page + `"}`
	}
	testCases := []struct {
		name, payload, version, revision, url string
	}{
		{"published release", latestRelease, latestVersion, latestRevision, latestReleaseURL},
		{"uppercase source normalizes", strings.Replace(latestRelease, latestRevision, strings.ToUpper(latestRevision), 1), latestVersion, latestRevision, latestReleaseURL},
		{"branch source is unknown", strings.Replace(latestRelease, latestRevision, "main", 1), latestVersion, "", latestReleaseURL},
		{"missing source is unknown", tagged(latestVersion, latestReleaseURL), latestVersion, "", latestReleaseURL},
		{"short source is unknown", strings.Replace(latestRelease, latestRevision, "bbbbbbb", 1), latestVersion, "", latestReleaseURL},
		{"old SHA tag", tagged(latestRevision, releaseURLPrefix+latestRevision), "", "", ""},
		{"short version", tagged("v1", releaseURLPrefix+"v1"), "", "", ""},
		{"missing v prefix", tagged("1.10.0", releaseURLPrefix+"1.10.0"), "", "", ""},
		{"prerelease version", tagged("v1.10.0-rc.1", releaseURLPrefix+"v1.10.0-rc.1"), "", "", ""},
		{"build suffix", tagged("v1.10.0+build", releaseURLPrefix+"v1.10.0+build"), "", "", ""},
		{"other host", tagged(latestVersion, "https://evil.example"), "", "", ""},
		{"userinfo", tagged(latestVersion, "https://user@github.com/TNTcraftHIM/Piik/releases/tag/"+latestVersion), "", "", ""},
		{"port", tagged(latestVersion, "https://github.com:8443/TNTcraftHIM/Piik/releases/tag/"+latestVersion), "", "", ""},
		{"plaintext page", tagged(latestVersion, "http://github.com/TNTcraftHIM/Piik/releases/tag/"+latestVersion), "", "", ""},
		{"query", tagged(latestVersion, latestReleaseURL+"?asset=1"), "", "", ""},
		{"fragment", tagged(latestVersion, latestReleaseURL+"#assets"), "", "", ""},
		{"encoded path separator", tagged(latestVersion, "https://github.com/TNTcraftHIM%2FPiik/releases/tag/"+latestVersion), "", "", ""},
		{"mismatched page tag", tagged(latestVersion, releaseURLPrefix+deployedVersion), "", "", ""},
		{"draft", strings.TrimSuffix(latestRelease, "}") + `,"draft":true}`, "", "", ""},
		{"prerelease", strings.TrimSuffix(latestRelease, "}") + `,"prerelease":true}`, "", "", ""},
		{"missing page", `{"tag_name":"` + latestVersion + `"}`, "", "", ""},
		{"array payload", `[]`, "", "", ""},
		{"not an object", `"released"`, "", "", ""},
		{"not json", `nonsense`, "", "", ""},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			version, revision, releaseURL, ok := parseReleaseMetadata([]byte(testCase.payload))
			if ok != (testCase.version != "") || version != testCase.version || revision != testCase.revision || releaseURL != testCase.url {
				t.Fatalf("parseReleaseMetadata = %q, %q, %q, %t; want %q, %q, %q",
					version, revision, releaseURL, ok, testCase.version, testCase.revision, testCase.url)
			}
		})
	}
}

func TestCheckReleaseReportsTheDeployedComparison(t *testing.T) {
	branchRelease := strings.Replace(latestRelease, latestRevision, "main", 1)
	testCases := []struct {
		name, version, revision, body, wantStatus, wantLatest string
	}{
		{"newer numeric version", deployedVersion, deployedRevision, latestRelease, statusUpdateAvailable, latestRevision},
		{"newer version of same source", deployedVersion, latestRevision, latestRelease, statusUpdateAvailable, latestRevision},
		{"older version", "v2.0.0", deployedRevision, latestRelease, statusUpToDate, latestRevision},
		{"same version and source", latestVersion, latestRevision, latestRelease, statusUpToDate, latestRevision},
		{"same version with different source", latestVersion, deployedRevision, latestRelease, statusDifferentBuild, latestRevision},
		{"development has an official choice", "development", deployedRevision, latestRelease, statusOfficialRelease, latestRevision},
		{"development has same source", "development", latestRevision, latestRelease, statusUpToDate, latestRevision},
		{"other unversioned build", "custom-build", deployedRevision, latestRelease, statusOfficialRelease, latestRevision},
		{"local prerelease", "v1.10.0-rc.1", deployedRevision, latestRelease, statusUpdateAvailable, latestRevision},
		{"newer version without known remote source", deployedVersion, deployedRevision, branchRelease, statusUpdateAvailable, ""},
		{"same version without known remote source", latestVersion, deployedRevision, branchRelease, statusUpToDate, ""},
		{"development without known remote source", "development", deployedRevision, branchRelease, statusUnavailable, ""},
		{"newer version without known local source", deployedVersion, "", latestRelease, statusUpdateAvailable, latestRevision},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Accept") != "application/vnd.github+json" ||
					request.Header.Get("X-GitHub-Api-Version") != "2022-11-28" || request.Header.Get("User-Agent") != "Piik-release-check" {
					t.Error("release request headers changed")
				}
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer server.Close()
			result := checkRelease(t.Context(), testCase.version, testCase.revision, server.URL, "", "")
			assertResult(t, result, testCase.wantStatus, testCase.version, latestVersion, testCase.revision, testCase.wantLatest, latestReleaseURL)
		})
	}
}

func TestCheckReleaseFailsClosedWithoutAUsableEndpoint(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "https://evil.example/releases", http.StatusFound)
	}))
	defer redirect.Close()
	reachable := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(latestRelease))
	}))
	defer reachable.Close()
	unavailable := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unavailable.Close()
	malformed := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"tag_name":"v1","html_url":"https://evil.example"}`))
	}))
	defer malformed.Close()
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, testCase := range []struct {
		name, apiURL string
		ctx          context.Context
	}{
		{"redirected endpoint", redirect.URL, t.Context()},
		{"unsupported scheme", "file:///etc/passwd", t.Context()},
		{"relative endpoint", "releases/latest", t.Context()},
		{"cancelled check", reachable.URL, cancelled},
		{"server unavailable", unavailable.URL, t.Context()},
		{"unusable metadata", malformed.URL, t.Context()},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := checkRelease(testCase.ctx, deployedVersion, deployedRevision, testCase.apiURL, "", "")
			assertResult(t, result, statusUnavailable, deployedVersion, "", deployedRevision, "", "")
		})
	}
	result := checkRelease(t.Context(), "development", "unknown", "", "", "")
	assertResult(t, result, statusUnavailable, "development", "", "", "", "")
}

func TestOperatorTokenReachesGitHubOnly(t *testing.T) {
	for _, endpoint := range []struct {
		name, url, token string
		authorized       bool
	}{
		{"github api", defaultReleaseAPIURL, "operator-token", true},
		{"github api with padded token", defaultReleaseAPIURL, "  operator-token  ", true},
		{"github api without a token", defaultReleaseAPIURL, "   ", false},
		{"plaintext github api", "http://api.github.com/repos", "operator-token", false},
		{"release host", "https://github.com/repos", "operator-token", false},
		{"local fixture", "http://127.0.0.1:8787/releases/latest", "operator-token", false},
		{"lookalike host", "https://api.github.com.evil.example/x", "operator-token", false},
	} {
		t.Run(endpoint.name, func(t *testing.T) {
			parsed, err := url.Parse(endpoint.url)
			if err != nil {
				t.Fatal(err)
			}
			if got := authorizesGitHub(parsed, endpoint.token); got != endpoint.authorized {
				t.Fatalf("authorizesGitHub(%q) = %t; want %t", endpoint.url, got, endpoint.authorized)
			}
		})
	}

	var received http.Header
	fixture := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received = request.Header.Clone()
		_, _ = writer.Write([]byte(latestRelease))
	}))
	defer fixture.Close()
	checkRelease(t.Context(), deployedVersion, deployedRevision, fixture.URL, "fixture-secret", "")
	if authorization := received.Get("Authorization"); authorization != "" {
		t.Fatalf("fixture endpoint received %q", authorization)
	}
}

func TestCheckDeployedReleaseUsesTheBinaryIdentityAndOperatorExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(latestRelease))
	}))
	defer server.Close()
	originalVersion, originalRevision := BuildVersion, BuildRevision
	t.Cleanup(func() { BuildVersion, BuildRevision = originalVersion, originalRevision })
	for _, testCase := range []struct {
		name, version, revision, status string
		code                            int
	}{
		{"newer release", deployedVersion, deployedRevision, statusUpdateAvailable, exitUpdateAvailable},
		{"different build", latestVersion, deployedRevision, statusDifferentBuild, exitUpdateAvailable},
		{"official release", "development", deployedRevision, statusOfficialRelease, exitUpdateAvailable},
		{"up to date", latestVersion, latestRevision, statusUpToDate, exitUpToDate},
		{"unknown build", "development", "development", statusUnavailable, exitUpdateUnavailable},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			BuildVersion, BuildRevision = testCase.version, testCase.revision
			var out bytes.Buffer
			code := checkDeployedRelease(t.Context(), server.URL, &out)
			if code != testCase.code || strings.Count(out.String(), "\n") != 1 {
				t.Fatalf("checkDeployedRelease = %d, %q; want code %d and one line", code, out.String(), testCase.code)
			}
			var result releaseResult
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if testCase.status == statusUnavailable {
				assertResult(t, result, testCase.status, testCase.version, "", "", "", "")
			} else {
				assertResult(t, result, testCase.status, testCase.version, latestVersion, testCase.revision, latestRevision, latestReleaseURL)
			}
		})
	}
}

func TestMirrorFallbackUsesOriginalSourceAndCompleteStablePagination(t *testing.T) {
	payload, err := os.ReadFile("../../tests/fixtures/mirror-releases.json")
	if err != nil {
		t.Fatal(err)
	}
	var releases []json.RawMessage
	if err := json.Unmarshal(payload, &releases); err != nil {
		t.Fatal(err)
	}
	for i, raw := range releases {
		_, revision, _, ok := parseMirrorReleaseMetadata(raw)
		if ok != (i < 2) || (ok && revision != latestRevision) {
			t.Fatalf("mirror fixture %d: accepted=%t revision=%s", i, ok, revision)
		}
	}
	primaryAvailable, truncate := false, false
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if primaryAvailable {
			_, _ = w.Write([]byte(latestRelease))
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer primary.Close()
	mirrorCalls := 0
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mirrorCalls++
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-GitHub-Api-Version") != "" ||
			r.Header.Get("Accept") != "application/json" {
			t.Error("mirror received credentials or GitHub headers")
		}
		if r.URL.Query().Get("per_page") != "100" || r.URL.Query().Get("direction") != "desc" {
			t.Error("mirror pagination missing")
		}
		if r.URL.Query().Get("page") == "1" || truncate {
			page := make([]json.RawMessage, 100)
			for i := range page {
				page[i] = releases[0]
			}
			_ = json.NewEncoder(w).Encode(page)
		} else {
			_, _ = w.Write(payload)
		}
	}))
	defer mirror.Close()
	result := checkRelease(t.Context(), deployedVersion, deployedRevision, primary.URL, "operator-secret", mirror.URL)
	assertResult(t, result, statusUpdateAvailable, deployedVersion, latestVersion, deployedRevision, latestRevision, mirrorReleasePrefix+latestVersion)
	if mirrorCalls != 2 {
		t.Fatalf("mirror calls = %d", mirrorCalls)
	}
	result = checkRelease(t.Context(), "v2.0.0", deployedRevision, primary.URL, "", mirror.URL)
	if result.Status != statusUpToDate {
		t.Fatal("a lagging mirror offered a downgrade")
	}
	truncate = true
	result = checkRelease(t.Context(), deployedVersion, deployedRevision, primary.URL, "", mirror.URL)
	if result.Status != statusUnavailable {
		t.Fatal("an incomplete mirror list was accepted")
	}
	primaryAvailable = true
	mirrorCalls = 0
	result = checkRelease(t.Context(), latestVersion, latestRevision, primary.URL, "", mirror.URL)
	if result.Status != statusUpToDate || mirrorCalls != 0 {
		t.Fatal("a usable primary release consulted the mirror")
	}
}

func assertResult(t *testing.T, result releaseResult, status, currentVersion, latestVersion, currentRevision, latestRevision, releaseURL string) {
	t.Helper()
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := json.Marshal(releaseResult{
		Status: status, CurrentVersion: reported(currentVersion), LatestVersion: reported(latestVersion),
		CurrentRevision: reported(currentRevision), LatestRevision: reported(latestRevision), ReleaseURL: reported(releaseURL),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, expected) {
		t.Fatalf("result = %s; want %s", payload, expected)
	}
}

func reported(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
