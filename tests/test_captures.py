from SpotAlert.captures import CaptureStore


def test_capture_store_creates_unique_timestamped_directories(tmp_path) -> None:
    store = CaptureStore(tmp_path)

    first_capture = store.create("ourdomain/amsterdam")
    second_capture = store.create("ourdomain/amsterdam")

    assert first_capture.directory.exists()
    assert second_capture.directory.exists()
    assert first_capture.directory != second_capture.directory
    assert first_capture.listing_html.name == "listing.html"
    assert first_capture.action_screenshot.name == "action.png"
