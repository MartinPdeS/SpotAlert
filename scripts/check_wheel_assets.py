"""Check that the built wheel contains every source extension asset."""

import sys
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
extension = root / "SpotAlert" / "chrome_extension"
expected = {
    path.relative_to(root).as_posix()
    for path in extension.rglob("*")
    if path.is_file() and "__pycache__" not in path.parts
}
with ZipFile(sys.argv[1]) as wheel:
    missing = expected - set(wheel.namelist())
if missing:
    raise SystemExit("Wheel is missing extension assets: " + ", ".join(sorted(missing)))
print(f"Wheel contains all {len(expected)} extension assets.")
