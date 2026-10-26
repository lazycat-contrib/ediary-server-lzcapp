#!/usr/bin/env python3
"""Check the distributable file set before an LPK can enter a public Release."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import tarfile

PACKAGE_ID = "cloud.lazycat.app.ediary-server"
MAX_BYTES = 512 * 1024 * 1024
OUTER_FILES = {"package.yml", "manifest.yml", "icon.png", "content.tar"}
CONTENT_FILES = {"bin/ediary-server", "start.sh"}


def verify_contents(path):
    with tarfile.open(path) as package:
        members = package.getmembers()
        if {m.name for m in members} != OUTER_FILES or len(members) != len(OUTER_FILES):
            raise ValueError("LPK must contain only package/manifest metadata, icon and content.tar")
        for member in members:
            if not member.isfile() or not 0 < member.size <= MAX_BYTES:
                raise ValueError("Unexpected LPK entry type or size")
        seen = set()
        total = 0
        with package.extractfile("content.tar") as stream, tarfile.open(fileobj=stream, mode="r|*") as content:
            for member in content:
                if member.isdir() and member.name in {"bin", "bin/"}:
                    continue
                if member.name not in CONTENT_FILES or member.name in seen or not member.isfile():
                    raise ValueError("LPK content must contain only the compiled binary and start.sh; rebuild with the sanitized contentdir")
                seen.add(member.name)
                total += member.size
                if total > MAX_BYTES:
                    raise ValueError("LPK content exceeds the size limit")
                if member.name == "bin/ediary-server":
                    with content.extractfile(member) as binary:
                        header = binary.read(20)
                    if not (header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00" and member.mode & 0o111):
                        raise ValueError("Expected an executable Linux amd64 ELF binary")
        if seen != CONTENT_FILES:
            raise ValueError("LPK is missing a required runtime file")


def prepare():
    version = os.environ["LPK_VERSION"]
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Expected a SemVer artifact version")
    candidates = list(Path("dist/import").rglob("*.lpk"))
    if len(candidates) != 1 or candidates[0].is_symlink() or not candidates[0].is_file():
        raise ValueError("Expected exactly one regular LPK in the selected artifact")
    source = candidates[0]
    if not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError("Unexpected LPK size")
    verify_contents(source)
    name = f"{PACKAGE_ID}-v{version}.lpk"
    destination = Path("dist") / name
    shutil.copyfile(source, destination)
    with destination.open("rb") as copied:
        digest = hashlib.file_digest(copied, "sha256").hexdigest()
    Path("dist/checksums.txt").write_text(f"{digest}  {name}\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"lpk-path={destination}\nsha256={digest}\n")
    print(f"Verified runtime-only LPK: {name}; SHA256 {digest}")


if __name__ == "__main__":
    prepare()
