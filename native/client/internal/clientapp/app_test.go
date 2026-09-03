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

func TestLaunchURLCarriesNativeSelectionWithoutChangingOrigin(t *testing.T) {
	value := launchURL("https://share.example/", Options{
		Native:             true,
		NativeWindowTitle:  "My Game",
		NativeAdapterIndex: 2,
		NativeEncoderIndex: 1,
	})
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.Query().Get("screener-native") != "1" ||
		parsed.Query().Get("screener-native-window") != "My Game" ||
		parsed.Query().Get("screener-native-adapter") != "2" ||
		parsed.Query().Get("screener-native-encoder") != "1" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
}

func TestLaunchURLLeavesOrdinaryClientURLUntouched(t *testing.T) {
	const original = "http://localhost:8787/#client-access=secret"
	if actual := launchURL(original, Options{}); actual != original {
		t.Fatalf("ordinary launch URL = %q", actual)
	}
}

func TestPairModesKeepOneAuthority(t *testing.T) {
	config := clientconfig.Config{
		Version:             1,
		LocalAccessPassword: "abcdefghijklmnopqrstuvwxyzABCDEF",
		Site:                "https://example.test",
	}
	selected, err := applyMode(config, Options{PairHost: true})
	if err != nil || selected.Site != config.Site {
		t.Fatalf("pair Host mode = %+v, %v", selected, err)
	}
	if err = validateMode(Options{PairHost: true, SiteSet: true}); err == nil {
		t.Fatal("pair Host accepted a separate Site")
	}
	if err = validateMode(Options{PairViewer: true, Native: true}); err == nil {
		t.Fatal("pair Viewer accepted Host capture")
	}
	if err = validateMode(Options{PairHost: true, PairSTUN: "turn:example.test:3478"}); err == nil {
		t.Fatal("pair Host accepted a non-STUN discovery service")
	}
}

func TestLocalEnvironmentOwnsItsSTUNConfiguration(t *testing.T) {
	t.Setenv("STUN_URLS", "stun:inherited.example:3478")
	environment := localEnvironment(
		8787,
		"192.168.1.2",
		[]string{"192.168.1.2"},
		"abcdefghijklmnopqrstuvwxyzABCDEF",
		[]string{"stun:pair.example:3478"},
	)
	stunEntries := []string{}
	for _, entry := range environment {
		if strings.HasPrefix(entry, "STUN_URLS=") {
			stunEntries = append(stunEntries, entry)
		}
	}
	if len(stunEntries) != 1 || stunEntries[0] != "STUN_URLS=stun:pair.example:3478" {
		t.Fatalf("Local STUN environment = %v", stunEntries)
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
