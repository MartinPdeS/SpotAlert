"""Exercise the standalone extension in an isolated Chromium profile.

Run with .venv/bin/python scripts/test_extension_browser.py.
No real browser profile or rental website is accessed.
"""

import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from types import SimpleNamespace

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "extension"


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    fixture_state = SimpleNamespace(available=False)
    url = "https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx"
    with TemporaryDirectory(prefix="spotalert-browser-", dir="/private/tmp") as temp:
        temp = Path(temp)
        extension = temp / "extension"
        shutil.copytree(ROOT / "SpotAlert/chrome_extension", extension)
        with sync_playwright() as playwright:
            def launch():
                return playwright.chromium.launch_persistent_context(
                    str(temp / "profile"), channel="chromium", headless=True,
                    viewport={"width": 390, "height": 1000},
                    args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
                    ignore_default_args=["--disable-extensions"],
                )

            context = launch()
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                extension_id = worker.url.split("/")[2]
                context.route(
                    "https://thisisourdomain.securerc.co.uk/**",
                    lambda route: route.fulfill(
                        content_type="text/html; charset=utf-8",
                        body=f'<title>OurDomain fixture</title><table><tr><td>Studio A</td><td data-selenium-id="Availability_1">{"<a href=availableunits.aspx?myFloorPlanId=101>Apply Now</a>" if fixture_state.available else "<button>Get Notified</button>"}</td></tr><tr><td>Studio B</td><td data-selenium-id="Availability_2">Get Notified</td></tr></table>',
                    ),
                )
                adapter_page = context.new_page()
                adapter_page.goto("https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx")
                adapter_page.bring_to_front()
                panel = context.new_page()
                errors = []
                panel.on("pageerror", lambda error: errors.append(str(error)))
                panel.goto(f"chrome-extension://{extension_id}/panel.html")
                expect(panel.locator("#monitor-count")).to_have_text("2")
                expect(panel.locator("#discovery-title")).to_have_count(0)
                expect(panel.locator("#add-monitor")).to_have_count(0)
                panel.get_by_role("button", name="Configure monitor", exact=True).click()
                expect(panel.locator("#monitor-url")).to_have_attribute("readonly", "")
                expect(panel.locator("#monitor-url")).to_have_value(url)
                expect(panel.locator("#rule-expected")).to_have_value("Get Notified")
                panel.locator("#interval").select_option("30")
                panel.locator("#notify").check()
                panel.locator("#preview-rule").click()
                expect(panel.locator("#preview-result")).to_contain_text("Not available · 0/2 elements matched")
                panel.get_by_role("button", name="Save monitor", exact=True).click()
                expect(panel.locator("#editor")).not_to_be_visible()
                expect(panel.locator("#monitor-count")).to_have_text("2")
                panel.get_by_role("button", name="▶ Start watching", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("1", timeout=30000)
                expect(panel.locator(".monitor-card.watching")).to_have_count(1)
                expect(panel.locator(".activity-caption")).to_have_text("Watching for availability")
                expect(panel.locator(".sample")).to_have_count(2)
                fixture_state.available = True
                panel.get_by_role("button", name="↻ Check now", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("2", timeout=30000)
                expect(panel.locator("#available-count")).to_have_text("1")
                expect(panel.locator("#apartment-count")).to_have_text("≥1")
                expect(panel.locator("#apartment-count-note")).to_be_visible()
                expect(panel.locator(".sample.matched")).to_have_count(1)
                expect(panel.locator("#availability-popup")).to_be_visible()
                expect(panel.locator("#availability-site")).to_have_text("OurDomain · Amsterdam Diemen")
                expect(panel.locator("#availability-listings")).to_contain_text("Apply Now")
                panel.screenshot(path=str(ARTIFACTS / "availability-popup.png"))
                panel.locator("#open-availability").click()
                expect(panel.locator("#availability-popup")).not_to_be_visible()
                assert adapter_page.url == url
                panel.locator("#refresh-interval").select_option("60")
                expect(panel.locator(".rule-meta")).to_contain_text("Every 1m")
                expect(panel.locator("#active-count")).to_have_text("1")
                expect(panel.locator("#check-count")).to_have_text("2")
                expect(panel.locator(".sample")).to_have_count(2)
                panel.locator("#refresh-interval").select_option("30")
                expect(panel.locator(".rule-meta")).to_contain_text("Every 30s")
                panel.screenshot(path=str(ARTIFACTS / "side-panel.png"), full_page=True)
                panel.set_viewport_size({"width": 1280, "height": 1000})
                panel.screenshot(path=str(ARTIFACTS / "workspace.png"), full_page=True)
                # Browsing another tab must leave the supported monitor selected.
                unrelated = context.new_page()
                unrelated.goto("about:blank")
                unrelated.bring_to_front()
                expect(panel.locator(".detail-title h2")).to_have_text("OurDomain · Amsterdam Diemen")
                panel.get_by_role("button", name="Configure monitor", exact=True).click()
                panel.locator("#rule-selector").fill("[")
                panel.locator("#preview-rule").click()
                expect(panel.locator("#form-error")).to_contain_text("Invalid CSS selector")
                expect(panel.locator("#form-error")).to_contain_text("OurDomain · Amsterdam Diemen (thisisourdomain.securerc.co.uk)")
                panel.locator("#close-editor").click()
                panel.get_by_role("button", name="Stop all", exact=True).click()
                expect(panel.locator("#stop-all")).to_be_disabled()
                expect(panel.locator("#active-count")).to_have_text("0")
                panel.get_by_role("button", name="▶ Start watching", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("3", timeout=30000)
                # A real Chrome alarm wakes the monitoring engine, without the panel scheduling checks.
                monitor_id = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors[0].id")
                worker.evaluate("id => chrome.alarms.create('spotalert:' + id, {when: Date.now() + 1000})", monitor_id)
                expect(panel.locator("#check-count")).to_have_text("4", timeout=45000)
                expect(panel.locator("#availability-popup")).not_to_be_visible()
                # The second catalog entry uses its own URL, tab, and persisted settings.
                context.route(
                    "https://southeast-thisisourdomain.securerc.co.uk/**",
                    lambda route: route.fulfill(content_type="text/html; charset=utf-8", body='<div id="FP_Detail_1101760"><h2 data-selenium-id="FloorPlanName">2 Bedroom Superior</h2><table><tr><td data-selenium-id="Rent_1">€ 2.207 - € 2.468</td><td data-selenium-id="Bed_1">2</td></tr><tr><td data-selenium-id="Apply_1"><button data-selenium-id="ApplyNow">Get Notified</button></td></tr><tr style="display:none"><td data-selenium-id="Apply_1"><button data-selenium-id="ApplyNow"></button></td></tr></table></div>'),
                )
                south_east_page = context.new_page()
                south_east_page.goto("https://southeast-thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-south-east/floorplans.aspx")
                panel.get_by_role("button", name="OurDomain · Amsterdam South East", exact=False).click()
                panel.get_by_role("button", name="Configure monitor", exact=True).click()
                expect(panel.locator("#monitor-url")).to_have_value("https://southeast-thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-south-east/floorplans.aspx")
                panel.locator("#preview-rule").click()
                expect(panel.locator("#preview-result")).to_contain_text("Not available · 0/1 elements matched")
                panel.locator("#close-editor").click()
                panel.get_by_role("button", name="↻ Check now", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("5", timeout=30000)
                expect(panel.locator(".sample")).to_have_count(1)
                expect(panel.locator(".sample-name")).to_have_text("2 Bedroom Superior")
                expect(panel.locator(".sample-type")).to_have_text("2 bedrooms")
                expect(panel.locator(".sample")).not_to_contain_text("false")
                expect(panel.locator(".listing-details")).to_contain_text("€ 2.207 - € 2.468")
                expect(panel.locator(".listing-details")).to_contain_text("Bedrooms2")
                expect(panel.locator("#active-count")).to_have_text("1")
                expect(panel.locator(".sample")).not_to_contain_text("Get Notified")
                expect(panel.locator(".technical-details")).not_to_have_attribute("open", "")
                panel.locator(".technical-details > summary").click()
                expect(panel.locator(".rule-code")).to_be_visible()
                panel.locator(".technical-details > summary").click()
                panel.get_by_role("button", name="Studios", exact=True).click()
                expect(panel.locator(".sample")).to_have_count(0)
                expect(panel.locator("#detail")).to_contain_text("No floor plans match this view")
                panel.get_by_role("button", name="2 bedrooms", exact=True).click()
                expect(panel.locator(".sample")).to_have_count(1)
                panel.get_by_role("button", name="All", exact=True).click()
                panel.locator("#compact-view").check()
                expect(panel.locator("body")).to_have_class("compact")
                worker.evaluate("async () => { const key='spotalert.monitors.v2';const data=(await chrome.storage.local.get(key))[key];data.monitors[1].lastCheckedAt=Date.now()-1000000;await chrome.storage.local.set({[key]:data}); }")
                expect(panel.locator(".telemetry .freshness")).to_contain_text("Stale")
                expect(panel.locator(".monitor-card").nth(1).locator(".freshness")).to_contain_text("Stale")
                for width in [320, 390, 1280]:
                    panel.set_viewport_size({"width": width, "height": 1000})
                    assert panel.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"Overflow at {width}px"
                    if width == 320:
                        panel.screenshot(path=str(ARTIFACTS / "room-type-side-panel.png"), full_page=True)
                panel.screenshot(path=str(ARTIFACTS / "room-type-ui.png"), full_page=True)
                assert not errors, errors
            finally:
                context.close()
            # Reopening the same isolated profile must preserve results and resume monitors.
            context = launch()
            try:
                panel = context.new_page()
                panel.goto(f"chrome-extension://{extension_id}/panel.html")
                expect(panel.locator("#monitor-count")).to_have_text("2")
                expect(panel.locator("#compact-view")).to_be_checked()
                expect(panel.locator("body")).to_have_class("compact")
                expect(panel.locator("#active-count")).to_have_text("1")
                expect(panel.locator("#check-count")).to_have_text("5")
                panel.get_by_role("button", name="Ⅱ Pause monitoring", exact=True).click()
                expect(panel.locator("#active-count")).to_have_text("0")
                expect(panel.locator(".activity-caption")).to_have_text("Monitoring paused")
                expect(panel.locator(".monitor-card.watching")).to_have_count(0)
                panel.locator("#refresh-interval").select_option("5")
                expect(panel.locator(".rule-meta")).to_contain_text("Every 5s")
                context.route("https://thisisourdomain.securerc.co.uk/**", lambda route: route.fulfill(content_type="text/html; charset=utf-8", body='<table><tr><td data-selenium-id="Availability_1">Get Notified</td></tr></table>'))
                # Prepare the fixture before starting and close the panel during the timer wait.
                target = context.new_page()
                target.goto(url)
                panel.get_by_role("button", name="▶ Start watching", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("6", timeout=30000)
                panel.close()
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                deadline = monotonic() + 15
                while monotonic() < deadline:
                    checks = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors[0].checks")
                    if checks >= 6:
                        break
                    sleep(0.2)
                assert checks >= 6, "Five-second refresh did not run with the panel closed"
                panel = context.new_page()
                panel.goto(f"chrome-extension://{extension_id}/panel.html")
                panel.get_by_role("button", name="Ⅱ Pause monitoring", exact=True).click()
                expect(panel.locator("#active-count")).to_have_text("0")
            finally:
                context.close()
    print("Browser integration passed: supported websites, preview, refresh, matching, independent tabs, errors, real alarms, restart, pause, five-second refresh with panel closed.")
    print(f"Screenshots: {ARTIFACTS}")


if __name__ == "__main__":
    main()
