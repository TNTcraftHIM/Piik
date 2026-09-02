package clientapp

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
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
