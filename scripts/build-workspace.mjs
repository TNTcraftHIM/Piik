import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

export function resetBuildWorkspace(repositoryRoot, ...parts) {
  if (parts.length < 2 || parts.some((part) => typeof part !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(part))) {
    throw new Error("Build workspace requires a named descendant of build");
  }
  let directory = realpathSync(repositoryRoot);
  for (const part of ["build", ...parts]) {
    directory = join(directory, part);
    const metadata = lstatSync(directory, { throwIfNoEntry: false });
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        realpathSync(directory) !== directory)) {
      throw new Error("Build workspace must not contain links");
    }
    if (!metadata) mkdirSync(directory, { mode: 0o700 });
  }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
