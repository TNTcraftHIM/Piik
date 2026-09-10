import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function fail(message) {
  throw new Error(`Client icon assets are invalid: ${message}`);
}

function readPngEntries(iconPath) {
  const icon = readFileSync(iconPath);
  if (
    icon.length < 6 ||
    icon.readUInt16LE(0) !== 0 ||
    icon.readUInt16LE(2) !== 1
  ) {
    fail("ICO header");
  }
  const count = icon.readUInt16LE(4);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    if (offset + 16 > icon.length) fail("ICO directory");
    const width = icon[offset] || 256;
    const height = icon[offset + 1] || 256;
    const length = icon.readUInt32LE(offset + 8);
    const dataOffset = icon.readUInt32LE(offset + 12);
    const data = icon.subarray(dataOffset, dataOffset + length);
    if (
      data.length !== length ||
      !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      fail(`PNG payload ${width}x${height}`);
    }
    if (width !== height) fail(`non-square source ${width}x${height}`);
    entries.set(width, data);
  }
  return entries;
}

function requireEntry(entries, size) {
  const data = entries.get(size);
  if (!data) fail(`missing ${size}px source`);
  return data;
}

function writeIcns(entries, output) {
  const kinds = [
    [16, "icp4"],
    [32, "icp5"],
    [64, "icp6"],
    [128, "ic07"],
    [256, "ic08"],
  ];
  const chunks = kinds.map(([size, kind]) => {
    const data = requireEntry(entries, size);
    const header = Buffer.alloc(8);
    header.write(kind, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const result = Buffer.alloc(
    8 + chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  result.write("icns", 0, 4, "ascii");
  result.writeUInt32BE(result.length, 4);
  let offset = 8;
  for (const chunk of chunks) {
    chunk.copy(result, offset);
    offset += chunk.length;
  }
  writeFileSync(output, result);
}

function writeLinuxAssets(packageRoot, entries) {
  const iconDirectory = join(
    packageRoot,
    "share",
    "icons",
    "hicolor",
    "256x256",
    "apps",
  );
  const applicationDirectory = join(packageRoot, "share", "applications");
  mkdirSync(iconDirectory, { recursive: true });
  mkdirSync(applicationDirectory, { recursive: true });
  writeFileSync(
    join(iconDirectory, "piik-client.png"),
    requireEntry(entries, 256),
  );
  writeFileSync(
    join(applicationDirectory, "piik-client.desktop"),
    [
      "[Desktop Entry]",
      "Version=1.0",
      "Type=Application",
      "Name=Piik Client",
      "Exec=piik-client",
      "TryExec=piik-client",
      "Icon=piik-client",
      "Terminal=false",
      "Categories=Network;Utility;",
      "StartupNotify=true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeMacAssets(packageRoot, revision, entries) {
  const bundleRoot = join(packageRoot, "Piik Client.app");
  const contents = join(bundleRoot, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeIcns(entries, join(resources, "piik.icns"));
  writeFileSync(
    join(contents, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>CFBundleDevelopmentRegion</key><string>en</string>",
      "<key>CFBundleDisplayName</key><string>Piik Client</string>",
      "<key>CFBundleExecutable</key><string>Launcher</string>",
      "<key>CFBundleIconFile</key><string>piik.icns</string>",
      "<key>CFBundleIdentifier</key><string>tv.piik.client</string>",
      "<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>",
      "<key>CFBundleName</key><string>Piik Client</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      "<key>CFBundleShortVersionString</key><string>1.0</string>",
      "<key>NSScreenCaptureUsageDescription</key><string>Share a screen or application selected by you.</string>",
      "<key>NSAudioCaptureUsageDescription</key><string>Share sound from the selected screen or application.</string>",
      `<key>CFBundleVersion</key><string>${revision}</string>`,
      "</dict></plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  const launcher = join(macos, "Launcher");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      "set -eu",
      'base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'exec "$base/../../../piik-client" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(launcher, 0o755);
}

export function writeClientPlatformAssets({
  packageRoot,
  target,
  revision,
  iconPath,
}) {
  const entries = readPngEntries(iconPath);
  if (target.goos === "linux") writeLinuxAssets(packageRoot, entries);
  if (target.goos === "darwin") writeMacAssets(packageRoot, revision, entries);
  return target.goos === "linux"
    ? "share/applications/piik-client.desktop"
    : target.goos === "darwin"
      ? "Piik Client.app"
      : null;
}
