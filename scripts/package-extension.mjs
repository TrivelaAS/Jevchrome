#!/usr/bin/env node

/**
 * bullshtt.ai — Chrome Extension Packager
 * Validates Manifest V3 extension configuration and builds production zip bundle.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const OUTPUT_ZIP = path.join(DIST_DIR, "bullshtt-ai-extension.zip");

console.log("==================================================");
console.log("   💩 bullshtt.ai Extension Packager (MV3)");
console.log("==================================================");

// 1. Validate manifest.json
const manifestPath = path.join(ROOT_DIR, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("❌ Fatal: manifest.json not found at", manifestPath);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`✅ manifest.json loaded: "${manifest.name}" v${manifest.version}`);
} catch (err) {
  console.error("❌ Fatal: manifest.json is invalid JSON:", err.message);
  process.exit(1);
}

// Manifest V3 validation checks
if (manifest.manifest_version !== 3) {
  console.error(`❌ Fatal: Expected manifest_version 3, got: ${manifest.manifest_version}`);
  process.exit(1);
}
if (!manifest.background?.service_worker) {
  console.error("❌ Fatal: Missing background.service_worker in manifest.json");
  process.exit(1);
}
if (!manifest.content_scripts || manifest.content_scripts.length === 0) {
  console.error("❌ Fatal: Missing content_scripts in manifest.json");
  process.exit(1);
}

// 2. Collect files to package
const filesToPackage = [];

function addFileIfPresent(relPath, required = true) {
  const fullPath = path.join(ROOT_DIR, relPath);
  if (fs.existsSync(fullPath)) {
    filesToPackage.push({ relPath, fullPath });
    console.log(`   [+] ${relPath}`);
  } else if (required) {
    console.warn(`   [!] Warning: Required file missing: ${relPath}`);
  }
}

console.log("\n📦 Collecting extension files:");

// Core files
addFileIfPresent("manifest.json", true);
addFileIfPresent("background.js", true);
addFileIfPresent("content.js", true);
addFileIfPresent("popup.html", true);
addFileIfPresent("popup.css", true);
addFileIfPresent("popup.js", true);

// Engine
addFileIfPresent("engine/bs_scorer.js", false);

// Icons
addFileIfPresent("icons/icon16.png", true);
addFileIfPresent("icons/icon48.png", true);
addFileIfPresent("icons/icon128.png", true);

if (filesToPackage.length === 0) {
  console.error("❌ Fatal: No files collected to package.");
  process.exit(1);
}

// 3. Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// 4. Build zip bundle using Python 3 zipfile
console.log(`\n🗜️  Packaging into: ${path.relative(ROOT_DIR, OUTPUT_ZIP)}`);

const pyScript = `
import zipfile, sys, os

zip_path = sys.argv[1]
root_dir = sys.argv[2]
files = sys.argv[3:]

with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for rel_path in files:
        full_path = os.path.join(root_dir, rel_path)
        if os.path.exists(full_path):
            zf.write(full_path, arcname=rel_path)
`;

try {
  const fileArgs = filesToPackage.map((f) => f.relPath);
  execFileSync(
    "python3",
    ["-c", pyScript, OUTPUT_ZIP, ROOT_DIR, ...fileArgs],
    { stdio: "inherit" }
  );
} catch (zipErr) {
  console.error("❌ Failed to create zip package with python3:", zipErr.message);
  process.exit(1);
}

// 5. Verification
if (!fs.existsSync(OUTPUT_ZIP)) {
  console.error("❌ Fatal: Output zip was not created.");
  process.exit(1);
}

const stats = fs.statSync(OUTPUT_ZIP);
const fileBuffer = fs.readFileSync(OUTPUT_ZIP);
const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

console.log("\n==================================================");
console.log(`✅ Chrome Web Store bundle created successfully!`);
console.log(`   Path:    ${OUTPUT_ZIP}`);
console.log(`   Size:    ${(stats.size / 1024).toFixed(2)} KB (${stats.size} bytes)`);
console.log(`   SHA-256: ${sha256}`);
console.log("==================================================");
