"""Fixed-folder native messaging for applicant profiles; no network service."""
import json
import os
import shlex
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from SpotAlert.native_host import extension_id

HOST_NAME = 'com.spotalert.profiles'
FOLDER = Path(__file__).resolve().parent / 'local_profiles'
LIMIT = 512 * 1024


def validate_library(library):
    if not isinstance(library, dict) or not isinstance(library.get('profiles'), list):
        raise ValueError('Invalid profile file')
    profiles = library['profiles']
    if not 1 <= len(profiles) <= 50:
        raise ValueError('Profile file must contain 1–50 profiles')
    ids = set()
    for item in profiles:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not isinstance(item.get('name'), str) or not isinstance(item.get('details'), dict):
            raise ValueError('Invalid profile entry')
        if item['id'] in ids:
            raise ValueError('Duplicate profile identifier')
        ids.add(item['id'])
        if not all(isinstance(value, str) for value in item['details'].values()):
            raise ValueError('Invalid profile details')
    if library.get('activeId') not in ids:
        raise ValueError('Invalid active profile')
    return library


def handle(message, folder=FOLDER):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if folder.is_symlink():
        raise ValueError('Profile folder must not be a symbolic link')
    path = folder / 'profiles.json'
    if path.is_symlink():
        raise ValueError('Profile file must not be a symbolic link')
    command = message.get('command')
    if command == 'read':
        if not path.exists():
            return {'ok': True, 'library': None, 'folder': str(folder)}
        if path.stat().st_size > LIMIT:
            raise ValueError('Profile file is too large')
        return {'ok': True, 'library': validate_library(json.loads(path.read_text())), 'folder': str(folder)}
    if command == 'write':
        library = validate_library(message.get('library'))
        payload = json.dumps(library, indent=2, ensure_ascii=False).encode('utf-8')
        if len(payload) > LIMIT:
            raise ValueError('Profile file is too large')
        descriptor, temporary = tempfile.mkstemp(prefix='.profiles-', dir=folder)
        try:
            with os.fdopen(descriptor, 'wb') as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {'ok': True, 'folder': str(folder)}
    if command == 'open':
        subprocess.run(['open' if sys.platform == 'darwin' else 'xdg-open', str(folder)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {'ok': True, 'folder': str(folder)}
    raise ValueError('Unknown profile command')


def install():
    if sys.platform == 'darwin':
        location = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
    elif sys.platform.startswith('linux'):
        location = Path.home() / '.config/google-chrome/NativeMessagingHosts'
    else:
        raise ValueError('Profile folder helper supports macOS and Linux')
    location.mkdir(parents=True, exist_ok=True)
    launcher = FOLDER.parent / 'profile-native-host'
    launcher.write_text('#!/bin/sh\ncd ' + shlex.quote(str(FOLDER.parent.parent)) + '\nexec ' + shlex.quote(sys.executable) + ' -m SpotAlert.profile_host "$@"\n')
    launcher.chmod(0o700)
    manifest = location / f'{HOST_NAME}.json'
    manifest.write_text(json.dumps({'name': HOST_NAME, 'description': 'SpotAlert local applicant profiles', 'path': str(launcher), 'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension_id()}/']}, indent=2))
    print(f'Installed local profile helper: {manifest}')


def main():
    if '--install' in sys.argv:
        install()
        return
    if len(sys.argv) < 2 or sys.argv[1] != f'chrome-extension://{extension_id()}/':
        return
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return
    length = struct.unpack('=I', header)[0]
    if length > LIMIT:
        return
    try:
        result = handle(json.loads(sys.stdin.buffer.read(length)))
    except Exception:
        result = {'ok': False, 'error': 'Could not access the local profile file. Check the folder and file format.'}
    payload = json.dumps(result).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
