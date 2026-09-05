package clientapp

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Screener/native/client/internal/clientconfig"
)

func TestPackagePathsValidateAnExplicitPackage(t *testing.T) {
	nodePath, appDirectory := packageFixture(t)
	actualNode, actualApp, err := packagePaths(nodePath, appDirectory)
	if err != nil || actualNode != nodePath || actualApp != appDirectory {
		t.Fatalf("packagePaths = %q, %q, %v", actualNode, actualApp, err)
	}
}

func TestPackagePathsRequireTheExactPackagedRevision(t *testing.T) {
	nodePath, appDirectory := packageFixture(t)
	if err := os.WriteFile(filepath.Join(appDirectory, "REVISION"), []byte("different"), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := BuildRevision
	BuildRevision = "expected"
	t.Cleanup(func() { BuildRevision = previous })
	if _, _, err := packagePaths(nodePath, appDirectory); err == nil {
		t.Fatal("mismatched package revision was accepted")
	}
	if err := os.WriteFile(filepath.Join(appDirectory, "REVISION"), []byte("expected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := packagePaths(nodePath, appDirectory); err != nil {
		t.Fatal(err)
	}
}

func TestClientLaunchURLMarksThePageWithoutChangingOrigin(t *testing.T) {
	value := clientLaunchURL("https://share.example/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.RawQuery != "" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("screener-client") != "1" {
		t.Fatalf("Client launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestMissingCaptureKeepsViewerControlAvailable(t *testing.T) {
	native := discoverNativeMedia(t.Context(), "missing-capture-process")
	if native.capabilities.Video || native.capabilities.HardwareH264 {
		t.Fatalf("missing native capture = %+v", native)
	}
	control := native.controlFactory()()
	if control == nil {
		t.Fatal("missing capture disabled the native Viewer control")
	}
	_ = control.Close()
}

func TestLaunchURLPreservesLocalAccessInsideThePrivateFragment(t *testing.T) {
	value := clientLaunchURL("http://localhost:8787/#client-access=secret")
	parsed, err := url.Parse(value)
	if err != nil || parsed.RawQuery != "" {
		t.Fatalf("local native launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "secret" ||
		fragment.Get("screener-client") != "1" {
		t.Fatalf("local native launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLaunchURLEncodesAndClearsOptionalLocalAccess(t *testing.T) {
	value := clientLaunchURLWithLocalAccess(
		"http://localhost:8787/#retained=yes&client-access=old",
		"a+b&c?d=e",
	)
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "a+b&c?d=e" ||
		fragment.Get("screener-client") != "1" || fragment.Get("retained") != "yes" {
		t.Fatalf("encoded local launch fragment = %q, %v", parsed.Fragment, err)
	}

	open := clientLaunchURLWithLocalAccess("http://localhost:8787/#client-access=old", "")
	parsed, err = url.Parse(open)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err = url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "" || fragment.Get("screener-client") != "1" {
		t.Fatalf("open local launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLinkModeKeepsOneLocalAuthority(t *testing.T) {
	config := clientconfig.Config{
		Version:             1,
		LocalAccessPassword: "abcdefghijklmnopqrstuvwxyzABCDEF",
		Site:                "https://example.test",
	}
	selected, err := applyMode(config, Options{Link: true})
	if err != nil || selected.Site != config.Site {
		t.Fatalf("link mode = %+v, %v", selected, err)
	}
	if err = validateMode(Options{Link: true, SiteSet: true}); err == nil {
		t.Fatal("link mode accepted a separate Site")
	}
	if err = validateMode(Options{Link: true, Local: true}); err == nil {
		t.Fatal("link mode accepted a second Local selector")
	}
}

func TestLocalEnvironmentOwnsItsSTUNConfiguration(t *testing.T) {
	t.Setenv("STUN_URLS", "stun:inherited.example:3478")
	environment := localEnvironment(
		8787,
		"192.168.1.2",
		[]string{"192.168.1.2"},
		"abcdefghijklmnopqrstuvwxyzABCDEF",
		[]string{"stun:public.example:3478"},
		[]string{"stun:survey-a.example:3478", "stun:survey-b.example:3478"},
		"https://small-bright-room.trycloudflare.com",
	)
	stunEntries := []string{}
	surveyEntries := []string{}
	publicEntries := []string{}
	for _, entry := range environment {
		if strings.HasPrefix(entry, "STUN_URLS=") {
			stunEntries = append(stunEntries, entry)
		}
		if strings.HasPrefix(entry, "SCREENER_CLIENT_NAT_PREDICTION_STUN_URLS=") {
			surveyEntries = append(surveyEntries, entry)
		}
		if strings.HasPrefix(entry, "SCREENER_CLIENT_PUBLIC_ORIGIN=") {
			publicEntries = append(publicEntries, entry)
		}
	}
	if len(stunEntries) != 1 || stunEntries[0] != "STUN_URLS=stun:public.example:3478" {
		t.Fatalf("Local STUN environment = %v", stunEntries)
	}
	if len(surveyEntries) != 1 ||
		surveyEntries[0] != "SCREENER_CLIENT_NAT_PREDICTION_STUN_URLS=stun:survey-a.example:3478,stun:survey-b.example:3478" {
		t.Fatalf("Local NAT survey environment = %v", surveyEntries)
	}
	if len(publicEntries) != 1 ||
		publicEntries[0] != "SCREENER_CLIENT_PUBLIC_ORIGIN=https://small-bright-room.trycloudflare.com" {
		t.Fatalf("Local public environment = %v", publicEntries)
	}
}

func packageFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	nodeName := "node"
	if runtime.GOOS == "windows" {
		nodeName += ".exe"
	}
	nodePath := filepath.Join(root, nodeName)
	appDirectory := filepath.Join(root, "app")
	entry := filepath.Join(appDirectory, "dist", "server", "server", "local-index.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{nodePath: "node", entry: "entry"} {
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return nodePath, appDirectory
}
