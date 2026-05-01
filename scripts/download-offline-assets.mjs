import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const languages = ["tr", "en", "de", "fr", "es", "ar"];
const argosDir = join(root, "assets", "translate", "argos");
const whisperPath = join(root, "assets", "models", "whisper", "ggml-large-v3-turbo-q8_0.bin");
const ffmpegMacZip = join(root, "assets", "ffmpeg", "macos", "ffmpeg.zip");
const ffmpegWinZip = join(root, "assets", "ffmpeg", "windows", "ffmpeg.zip");
const ffmpegMacBinary = join(root, "assets", "ffmpeg", "macos", "ffmpeg");
const ffmpegWinBinary = join(root, "assets", "ffmpeg", "windows", "ffmpeg.exe");
const deepFilterModelPath = join(root, "assets", "deepfilter", "models", "DeepFilterNet3_onnx.tar.gz");
const deepFilterMacArmPath = join(root, "assets", "deepfilter", "macos-aarch64", "deep-filter");
const deepFilterMacX64Path = join(root, "assets", "deepfilter", "macos-x64", "deep-filter");
const deepFilterWinX64Path = join(root, "assets", "deepfilter", "windows-x64", "deep-filter.exe");
const manifestPath = join(root, "assets", "manifest.json");

const downloads = [
  {
    label: "Whisper local subtitle engine",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
    path: whisperPath
  },
  {
    label: "FFmpeg macOS",
    url: "https://evermeet.cx/ffmpeg/getrelease/zip",
    path: ffmpegMacZip,
    skipIfExists: ffmpegMacBinary
  },
  {
    label: "FFmpeg Windows",
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    path: ffmpegWinZip,
    skipIfExists: ffmpegWinBinary
  },
  {
    label: "DeepFilterNet3 model",
    url: "https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/models/DeepFilterNet3_onnx.tar.gz",
    path: deepFilterModelPath
  },
  {
    label: "DeepFilterNet macOS ARM",
    url: "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-apple-darwin",
    path: deepFilterMacArmPath
  },
  {
    label: "DeepFilterNet macOS Intel",
    url: "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-apple-darwin",
    path: deepFilterMacX64Path
  },
  {
    label: "DeepFilterNet Windows x64",
    url: "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe",
    path: deepFilterWinX64Path
  }
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function download(url, path, label) {
  ensureDir(dirname(path));
  if (existsSync(path) && statSync(path).size > 0) {
    console.log(`skip ${label}: ${path}`);
    return;
  }

  const tmp = `${path}.download`;
  console.log(`download ${label}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(tmp));
  renameSync(tmp, path);
}

async function downloadArgosPackages() {
  ensureDir(argosDir);
  const response = await fetch("https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json");
  if (!response.ok) throw new Error(`Argos index failed: ${response.status}`);
  const index = await response.json();
  const selected = [];
  const missing = [];

  for (const from of languages) {
    for (const to of languages) {
      if (from === to) continue;
      const item = index.find((candidate) => candidate.from_code === from && candidate.to_code === to);
      if (!item) {
        missing.push(`${from}_${to}`);
        continue;
      }
      const url = item.links.find((link) => link.startsWith("https://"));
      if (!url) {
        missing.push(`${from}_${to}`);
        continue;
      }
      selected.push({ code: item.code, url, version: item.package_version });
    }
  }

  for (const item of selected) {
    const path = join(argosDir, `${item.code}-${item.version.replaceAll(".", "_")}.argosmodel`);
    await download(item.url, path, item.code);
  }

  writeFileSync(
    join(argosDir, "bundle-report.json"),
    JSON.stringify({ languages, selected, missing }, null, 2)
  );
  console.log(`Argos selected: ${selected.length}, missing direct pairs: ${missing.length}`);
  if (missing.length) console.log(`missing: ${missing.join(", ")}`);
}

function findFile(dir, matcher) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, matcher);
      if (found) return found;
    } else if (matcher(path)) {
      return path;
    }
  }
  return null;
}

function extractFfmpeg() {
  if (existsSync(ffmpegMacZip)) {
    const macDir = dirname(ffmpegMacZip);
    execFileSync("unzip", ["-o", ffmpegMacZip, "-d", macDir], { stdio: "inherit" });
    const binary = findFile(macDir, (path) => basename(path) === "ffmpeg" && !path.endsWith(".zip"));
    if (binary && binary !== join(macDir, "ffmpeg")) renameSync(binary, join(macDir, "ffmpeg"));
    execFileSync("chmod", ["+x", join(macDir, "ffmpeg")], { stdio: "inherit" });
    rmSync(ffmpegMacZip, { force: true });
  }

  if (existsSync(ffmpegWinZip)) {
    const winDir = dirname(ffmpegWinZip);
    execFileSync("unzip", ["-o", ffmpegWinZip, "-d", winDir], { stdio: "inherit" });
    const binary = findFile(winDir, (path) => basename(path).toLowerCase() === "ffmpeg.exe");
    if (binary && binary !== join(winDir, "ffmpeg.exe")) renameSync(binary, join(winDir, "ffmpeg.exe"));
    rmSync(ffmpegWinZip, { force: true });
  }
}

function chmodDeepFilter() {
  for (const binary of [deepFilterMacArmPath, deepFilterMacX64Path]) {
    if (existsSync(binary)) execFileSync("chmod", ["+x", binary], { stdio: "inherit" });
  }
}

function updateManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const item of manifest.assets) {
    const path = join(root, item.path);
    if (existsSync(path) && statSync(path).isFile()) {
      item.sha256 = sha256(path);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const item of downloads) {
  if (item.skipIfExists && existsSync(item.skipIfExists) && statSync(item.skipIfExists).size > 0) {
    console.log(`skip ${item.label}: ${item.skipIfExists}`);
    continue;
  }
  await download(item.url, item.path, item.label);
}

await downloadArgosPackages();
extractFfmpeg();
chmodDeepFilter();
updateManifest();
console.log("offline assets ready");
