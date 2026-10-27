# Contributing to OurDomain

## Shared release versioning

Versions are explicit in `[project].version`; builds never derive versions from
Git. Install the pinned release tool in the interpreter used by Make:

```sh
python -m pip install "martinpdes-maintenance==0.2.2"
make release-check PYTHON=python
```

The `release` extra declares the same tool. The Makefile calls the installed module directly, and
`[tool.mps-maintenance]` declares the package's release files. Use
`python -m martinpdes_maintenance.cli tag vX.Y.Z --dry-run` to preview changes from a clean,
full checkout. The tool aligns configured metadata, commits, and creates an
annotated tag; it never pushes. Existing Makefile publishing shortcuts retain
their push behavior. Fetch remote tags first. With no release tags, `next` uses
the explicit project version as its starting point.

## Continuous integration and releases

GitHub Actions runs Ruff and Python 3.10–3.13 tests through the shared
MPSActions workflows. Separate jobs run the Node extension behavior suite,
isolated Chromium fixture scripts, and a package build. The wheel check verifies
that all extension source assets are included. CI runs on pull requests and
pushes to `main` or `master`, and on `v*` tags. Dependabot checks Python and
GitHub Actions dependencies quarterly.

The Python package version and Chrome manifest version are independent. A
`vX.Y.Z` tag identifies the Python package version and is checked against its
release metadata. Update the extension manifest version separately when the
extension changes; it is recorded inside the extension zip. After all checks
pass, tag runs retain the Python distributions and extension zip as GitHub
Actions artifacts for 90 days. These artifacts are not automatically published
to PyPI, a GitHub Release, or the Chrome Web Store. Download them from the tag's
Actions run for review or distribution.

Run `make check` locally; for browser-facing changes, install Playwright
Chromium (`python -m playwright install chromium`) and run
`make extension-browser-test`. The browser fixtures use temporary profiles and
block unmocked network traffic.
