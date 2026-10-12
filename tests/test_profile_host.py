import json

import pytest

from SpotAlert.profile_host import handle


def test_profile_folder_roundtrip_and_private_permissions(tmp_path):
    library = {'activeId': 'alex', 'profiles': [{'id': 'alex', 'name': 'Alex', 'details': {'firstName': 'Alex', 'registrationPassword': 'TestOnly123!'}}]}
    assert handle({'command': 'read'}, tmp_path)['library'] is None
    handle({'command': 'write', 'library': library}, tmp_path)
    assert handle({'command': 'read'}, tmp_path)['library'] == library
    assert (tmp_path / 'profiles.json').stat().st_mode & 0o777 == 0o600
    assert not list(tmp_path.glob('.profiles-*'))


def test_invalid_write_preserves_saved_profiles(tmp_path):
    library = {'activeId': 'a', 'profiles': [{'id': 'a', 'name': 'A', 'details': {}}]}
    handle({'command': 'write', 'library': library}, tmp_path)
    with pytest.raises(ValueError):
        handle({'command': 'write', 'library': {'profiles': []}}, tmp_path)
    assert json.loads((tmp_path / 'profiles.json').read_text()) == library


def test_profile_host_rejects_symlink_file(tmp_path):
    target = tmp_path / 'private.json'
    target.write_text('{}')
    (tmp_path / 'profiles.json').symlink_to(target)
    with pytest.raises(ValueError):
        handle({'command': 'read'}, tmp_path)
