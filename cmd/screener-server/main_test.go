package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvironmentFileFillsOnlyAbsentVariables(t *testing.T) {
	t.Setenv("SCREENER_TEST_PRESET", "from-the-service")
	path := filepath.Join(t.TempDir(), ".env")
	content := "# Application\n" +
		"SCREENER_TEST_PRESET=from-the-file\n" +
		"export SCREENER_TEST_EXPORTED=exported\n" +
		"  SCREENER_TEST_QUOTED = \"a b#c\" \n" +
		"SCREENER_TEST_SINGLE='  padded  '\n" +
		"SCREENER_TEST_EMPTY=\n" +
		"SCREENER_TEST_MARK=has#hash\n" +
		"\n" +
		"not an assignment\n" +
		"#SCREENER_TEST_COMMENTED=never\r\n" +
		"SCREENER_TEST_LAST=tail"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// Setenv registers the restore, Unsetenv makes the name absent for the run.
	for _, name := range []string{
		"SCREENER_TEST_EXPORTED", "SCREENER_TEST_QUOTED", "SCREENER_TEST_SINGLE",
		"SCREENER_TEST_EMPTY", "SCREENER_TEST_MARK", "SCREENER_TEST_COMMENTED",
		"SCREENER_TEST_LAST",
	} {
		t.Setenv(name, "absent")
		os.Unsetenv(name)
	}

	if err := loadEnvironmentFile(path); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		// A variable the service already supplies is never replaced.
		"SCREENER_TEST_PRESET":   "from-the-service",
		"SCREENER_TEST_EXPORTED": "exported",
		"SCREENER_TEST_QUOTED":   "a b#c",
		"SCREENER_TEST_SINGLE":   "  padded  ",
		"SCREENER_TEST_EMPTY":    "",
		"SCREENER_TEST_MARK":     "has#hash",
		"SCREENER_TEST_LAST":     "tail",
	} {
		if got, present := os.LookupEnv(name); !present || got != want {
			t.Errorf("%s = %q, present %t; want %q", name, got, present, want)
		}
	}
	if value, present := os.LookupEnv("SCREENER_TEST_COMMENTED"); present {
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
