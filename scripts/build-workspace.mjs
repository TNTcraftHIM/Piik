import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function assertCleanRevision(repositoryRoot, expectedRevision) {
  const git = (...args) => execFileSync("git", args, {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const revision = git("rev-parse", "HEAD").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Git did not return a full revision");
  if (expectedRevision && revision !== expectedRevision) {
    throw new Error("Repository revision does not match the package source");
  }
  if (git("status", "--porcelain") !== "") {
    throw new Error("Packaging requires a clean Git checkout");
  }
  return revision;
}

/** A reused build input must survive the caller's output-directory replacement. */
export function assertBuildInputRetained(input, output) {
  const retained = realpathSync(input);
  const target = resolve(output);
  let ancestor = target;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  const replaced = join(realpathSync(ancestor), relative(ancestor, target));
  for (const [parent, child] of [[replaced, retained], [retained, replaced]]) {
    const path = relative(parent, child);
    if (path === "" || (path.split(/[\\/]/)[0] !== ".." && !isAbsolute(path))) {
      throw new Error("Shared Web input overlaps a replaced build directory");
    }
  }
}

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
