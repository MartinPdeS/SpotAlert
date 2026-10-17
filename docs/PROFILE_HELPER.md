# Optional local applicant-profile storage

The Chrome extension is the primary SpotAlert app. Monitoring, saved profiles,
applications, and email delivery work without Python. This optional helper mirrors
applicants to a private JSON file on macOS/Linux; it does not monitor websites.

From the checkout, create the Python environment described in [Python setup](PYTHON.md),
then install the helper once:

```bash
.venv/bin/python -m SpotAlert.profile_host --install
```

Reload the extension at `chrome://extensions`. The helper migrates Chrome's saved
applicants to `SpotAlert/local_profiles/profiles.json`, mirrors profile saves, and
restores that file on extension startup. **Settings → Advanced → See profile
folder** opens the folder. The generated native launcher and profile folder are
ignored by Git. If the checkout or virtual environment moves, rerun the installer.

The JSON contains personal details and passwords in plain text, with owner-only
file permissions. Keep backups private. Removing the extension or clearing Chrome
storage leaves this folder intact. Without the helper, profiles stay in Chrome's
local extension storage. The extension's `nativeMessaging` permission is used for
this helper; the old Python monitoring bridge is separate and unused by the app.
