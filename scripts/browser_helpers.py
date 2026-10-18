"""Isolated extension fixtures and shared browser lifecycle helpers."""
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def select_building_for_actions(panel):
    building = panel.locator('#location-picker').input_value()
    panel.evaluate("""async id => {
      const key='spotalert.ui.v1';
      const preferences=(await chrome.storage.local.get(key))[key] || {};
      await chrome.storage.local.set({[key]:{...preferences,checkBuildingIds:[id]}});
    }""", building)
    expect(panel.locator('#building-selection-count')).to_have_text('1 building selected')


def launch_extension(playwright, profile, extension, *, viewport=None):
    """Launch only an isolated fixture profile, including restart-based suites."""
    context = playwright.chromium.launch_persistent_context(
        str(profile), channel="chromium", headless=True,
        viewport=viewport or {"width": 1280, "height": 1000},
        args=["--disable-features=DisableLoadExtensionCommandLineSwitch",
              "--host-resolver-rules=MAP * ~NOTFOUND",
              f"--disable-extensions-except={extension}",
              f"--load-extension={extension}"],
        ignore_default_args=["--disable-extensions"],
    )
    # Tests must register explicit fixtures; unmatched HTTP requests never go live.
    context.route("http://**/*", lambda route: route.abort())
    context.route("https://**/*", lambda route: route.abort())
    return context


def extension_worker(context, *, browser_reader=True):
    """Disable the native host and optionally force browser-reader fixtures."""
    worker = (context.service_workers[0] if context.service_workers
              else context.wait_for_event("serviceworker"))
    worker.evaluate("""() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (['http:', 'https:'].includes(url.protocol)) {
          throw new Error('External worker fetch requires an explicit test fixture');
        }
        return originalFetch(input, options);
      };
      chrome.runtime.sendNativeMessage=async()=>{
        throw new Error('Native host disabled in isolated tests');
      };
    }""")
    if browser_reader:
        worker.evaluate("()=>{chrome.offscreen.createDocument=undefined;}")
    return worker


@contextmanager
def isolated_extension(*, browser_reader=True, viewport=None):
    """Own temporary profile, browser, worker setup, and cleanup for a fixture suite."""
    with TemporaryDirectory(prefix="spotalert-fixture-") as profile:
        with sync_playwright() as playwright:
            context = launch_extension(
                playwright, profile, ROOT / "SpotAlert/chrome_extension",
                viewport=viewport,
            )
            try:
                yield context, extension_worker(context, browser_reader=browser_reader)
            finally:
                context.close()
