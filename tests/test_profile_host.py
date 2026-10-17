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


def test_pending_import_is_only_consumed_after_profiles_are_preserved(tmp_path):
    existing = {'id': 'real', 'name': 'Existing applicant', 'details': {'email': 'real@example.com'}}
    added = {'id': 'test-email', 'name': 'Fictional applicant', 'testProfile': True, 'details': {'email': 'test@example.com'}}
    pending = {'activeId': added['id'], 'profiles': [added]}
    (tmp_path / 'pending-import.json').write_text(json.dumps(pending))
    result = handle({'command': 'read'}, tmp_path)
    assert result['library'] is None
    assert result['pendingLibrary'] == pending
    handle({'command': 'write', 'library': {'activeId': 'real', 'profiles': [existing]}}, tmp_path)
    assert (tmp_path / 'pending-import.json').exists(), 'An unrelated save must not drop a queued applicant'
    merged = {'activeId': 'real', 'profiles': [existing, added]}
    handle({'command': 'write', 'library': merged}, tmp_path)
    assert not (tmp_path / 'pending-import.json').exists()
    assert handle({'command': 'read'}, tmp_path)['library'] == merged
