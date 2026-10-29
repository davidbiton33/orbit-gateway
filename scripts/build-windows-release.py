#!/usr/bin/env python3
"""Build the minimal public Windows source ZIP from committed, allowlisted files."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
if not VERSION or not all(x.isdigit() for x in VERSION.split(".")) or len(VERSION.split(".")) != 3:
    raise SystemExit("Invalid release version")
if len(sys.argv) > 1 and sys.argv[1] != "v" + VERSION:
    raise SystemExit("Tag must match package.json version")
OUTPUT = ROOT / "release-output"
OUTPUT.mkdir(exist_ok=True)
NAME = f"Orbit-Gateway-Friends-v{VERSION}.zip"
TARGET = OUTPUT / NAME
PREFIXES = ("src/", "public/", "bin/", "config/", "docker/", "legacy-gpt/", "skill/", "examples/", "docs/")
FILES = {
    "package.json", "package-lock.json", "START-WINDOWS.ps1",
    "ENABLE-TAILSCALE.ps1", "DISABLE-TAILSCALE.ps1",
    "README.md", "README_HE.md", "README-START-HE.md",
    "TAILSCALE-REMOTE-HE.md", "INSTALL_HE.md", "LICENSE",
    ".env.example", "SECURITY.md", "CHANGELOG.md",
    "docker-compose.yml", "docker-compose.oracle.yml",
    "README-ORACLE.md", "ORACLE_INSTALL_HE.md", "install-oracle.sh",
    "orbit-oracle.sh", "tailscale-api-oracle.sh",
}
SKIP = (".bak", ".tmp", ".log", ".sqlite", ".db", ".pem", ".key", ".zip")
names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
selected = []
for name in names:
    if not name:
        continue
    clean = name.replace("\\", "/")
    if clean.startswith((".github/", "website/", "tests/", "release-output/", ".staging/")):
        continue
    if clean.startswith("scripts/"):
        continue
    if clean not in FILES and not clean.startswith(PREFIXES):
        continue
    if clean.endswith(SKIP) or any(part.startswith(".env") and part != ".env.example" for part in clean.split("/")):
        continue
    if any(part in ("node_modules", "data", "profiles", "browser-profile", "__pycache__") for part in clean.split("/")):
        continue
    if ".." in pathlib.PurePosixPath(clean).parts:
        raise SystemExit("Unsafe package path: " + clean)
    path = ROOT / clean
    if not path.is_file():
        raise SystemExit("Tracked package file is absent: " + clean)
    selected.append((clean, path))
if len(selected) < 35:
    raise SystemExit("Package unexpectedly incomplete")
if not any(x[0] == "START-WINDOWS.ps1" for x in selected):
    raise SystemExit("Windows start script missing")
if not any(x[0] == "src/adapters/document-export.mjs" for x in selected):
    raise SystemExit("Word/PDF conversion source missing")
with zipfile.ZipFile(TARGET, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, path in sorted(selected):
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 29, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o755 if name.endswith(".sh") else 0o644) << 16
        z.writestr(info, path.read_bytes())
sha = hashlib.sha256(TARGET.read_bytes()).hexdigest()
(OUTPUT / "SHA256SUMS.txt").write_text(f"{sha}  {NAME}\n", encoding="utf-8")
with zipfile.ZipFile(TARGET) as z:
    if z.testzip():
        raise SystemExit("ZIP checksum validation failed")
    contents = z.namelist()
    if any(x.endswith(".env.docker") or x == ".env" for x in contents):
        raise SystemExit("Secrets accidentally included")
print(json.dumps({"version": VERSION, "zip": str(TARGET), "bytes": TARGET.stat().st_size, "files": len(selected), "sha256": sha}))
