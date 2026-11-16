import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { appPackageTarget } from "../scripts/app-package-targets.mjs";
import { checkAppPackageStatic } from "../scripts/check-app-package.mjs";

vi.mock("node:child_process", () => ({ spawnSync: () => { throw new Error("Static Linux package checks must not execute a process"); } }));
vi.mock("../scripts/process-shutdown.mjs", () => ({
  spawnProcess: () => { throw new Error("Static package checks must not launch the App"); },
  requestShutdown: () => { throw new Error("No App should be running"); },
}));

const revision = "a".repeat(40);
it.each(["valid", "revision", "web", "wasm", "architecture", "notices"] as const)(
  "checks existing package contents without running binaries (%s)", async scenario => {
    const root = mkdtempSync(join(tmpdir(), "piik-package-check-"));
    const write = (path: string, value: string | Buffer) => writeFileSync(join(root, path), value);
    try {
      for (const path of ["runtime/tunnel", "web/assets", "share/applications", "share/icons/hicolor/256x256/apps"])
        mkdirSync(join(root, path), { recursive: true });
      const executable = Buffer.alloc(64);
      executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); executable.writeUInt16LE(0x3e, 18);
      write("piik-app", executable); write("runtime/tunnel/cloudflared", executable);
      write("REVISION", revision);
      for (const path of ["LICENSE", "THIRD-PARTY-NOTICES.txt", "runtime/tunnel/THIRD-PARTY-NOTICES.txt", "web/third-party-licenses.txt"])
        write(path, "Fixture notices");
      write("web/index.html", '<script src="./assets/index-current.js"></script>');
      write("web/assets/index-current.js", 'const revision="' + revision + '"');
      write("web/assets/adapter.wasm", Buffer.from([0, 0x61, 0x73, 0x6d]));
      write("share/applications/piik-app.desktop", "Icon=piik-app\nTerminal=true\n");
      write("share/icons/hicolor/256x256/apps/piik-app.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
      if (scenario === "revision") write("REVISION", "b".repeat(40));
      if (scenario === "web") write("web/assets/index-current.js", "export{};");
      if (scenario === "wasm") write("web/assets/adapter.wasm", "invalid");
      if (scenario === "architecture") { executable.writeUInt16LE(0xb7, 18); write("piik-app", executable); }
      if (scenario === "notices") write("web/third-party-licenses.txt", "");
      const checking = checkAppPackageStatic(root, appPackageTarget("linux-amd64"), revision);
      if (scenario === "valid") await expect(checking).resolves.toBeUndefined();
      else await expect(checking).rejects.toThrow({ revision: "revision mismatch", web: "same source identity",
        wasm: "Rust/WASM adapter", architecture: "does not match", notices: "license text is missing" }[scenario]);
      expect(readFileSync(join(root, "REVISION"), "ascii")).toBe(scenario === "revision" ? "b".repeat(40) : revision);
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
