package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvironmentFileFillsOnlyAbsentVariables(t *testing.T) {
	t.Setenv("PIIK_TEST_PRESET", "from-the-service")
	path := filepath.Join(t.TempDir(), ".env")
	content := "# Application\n" +
		"PIIK_TEST_PRESET=from-the-file\n" +
		"export PIIK_TEST_EXPORTED=exported\n" +
		"  PIIK_TEST_QUOTED = \"a b#c\" \n" +
		"PIIK_TEST_SINGLE='  padded  '\n" +
		"PIIK_TEST_EMPTY=\n" +
		"PIIK_TEST_MARK=has#hash\n" +
		"\n" +
		"not an assignment\n" +
		"#PIIK_TEST_COMMENTED=never\r\n" +
		"PIIK_TEST_LAST=tail"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// Setenv registers the restore, Unsetenv makes the name absent for the run.
	for _, name := range []string{
		"PIIK_TEST_EXPORTED", "PIIK_TEST_QUOTED", "PIIK_TEST_SINGLE",
		"PIIK_TEST_EMPTY", "PIIK_TEST_MARK", "PIIK_TEST_COMMENTED",
		"PIIK_TEST_LAST",
	} {
		t.Setenv(name, "absent")
		os.Unsetenv(name)
	}

	if err := loadEnvironmentFile(path); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		// A variable the service already supplies is never replaced.
		"PIIK_TEST_PRESET":   "from-the-service",
		"PIIK_TEST_EXPORTED": "exported",
		"PIIK_TEST_QUOTED":   "a b#c",
		"PIIK_TEST_SINGLE":   "  padded  ",
		"PIIK_TEST_EMPTY":    "",
		"PIIK_TEST_MARK":     "has#hash",
		"PIIK_TEST_LAST":     "tail",
	} {
		if got, present := os.LookupEnv(name); !present || got != want {
			t.Errorf("%s = %q, present %t; want %q", name, got, present, want)
		}
	}
	if value, present := os.LookupEnv("PIIK_TEST_COMMENTED"); present {
		t.Errorf("commented assignment was applied as %q", value)
	}
}

func TestLoadEnvironmentFileIgnoresOnlyAMissingFile(t *testing.T) {
	directory := t.TempDir()
	if err := loadEnvironmentFile(filepath.Join(directory, ".env")); err != nil {
		t.Fatalf("a missing environment file must not stop startup: %v", err)
	}
	// A directory in place of the file is a read failure, not an absent file.
	if err := loadEnvironmentFile(directory); err == nil {
		t.Fatal("an unreadable environment file was ignored")
	}
}

func TestServerDiagnosticSelection(t *testing.T) {
	for value, want := range map[string]bool{
		"server": true, "route": true, "client, route": true,
		"": false, "client": false, "all": false, "server-secret": false,
	} {
		if got := serverDebugEnabled(value); got != want {
			t.Fatalf("serverDebugEnabled(%q) = %v, want %v", value, got, want)
		}
	}
	t.Setenv("PIIK_LOG_DIR", "")
	t.Setenv("LOGS_DIRECTORY", "")
	if got := serverLogDirectory(); got != "logs" {
		t.Fatalf("default directory = %q", got)
	}
	t.Setenv("LOGS_DIRECTORY", "service-logs"+string(os.PathListSeparator)+"other-logs")
	if got := serverLogDirectory(); got != "service-logs" {
		t.Fatalf("systemd directory = %q", got)
	}
	t.Setenv("PIIK_LOG_DIR", "explicit-logs")
	if got := serverLogDirectory(); got != "explicit-logs" {
		t.Fatalf("explicit directory = %q", got)
	}
}
