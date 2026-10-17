"""Verify location filters, monitoring schedules, profile editing and recovery in Chromium."""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "extension"
URL = "https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx"


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    state = {"a": False, "b": False, "mode": "normal", "reverse": False}

    def html():
        if state["mode"] == "verification":
            return '<title>Just a moment...</title><div id="challenge-running">Verify you are human</div>'
        if state["mode"] == "login":
            return '<title>Sign in</title><input type="password"><h1>Please sign in</h1>'
        rows = []
        for key, number, name, beds, rent in [
            ("a", 101, "Superior Studio A", "Studio", "€ 1.050"),
            ("b", 102, "1 Bedroom B", "1", "€ 1.500"),
        ]:
            action = (
                f'<a href="availableunits.aspx?myFloorPlanId={number}">Apply Now</a>'
                if state[key]
                else f'<button onclick="void(\'myFloorPlanId={number}\')">Get Notified</button>'
            )
            rows.append(f'''<tr data-selenium-id="FProw_{number}">
                <td data-selenium-id="FPlan_{number}">{name}</td>
                <td data-selenium-id="Beds_{number}">{beds}</td>
                <td data-selenium-id="Baths_{number}">1</td>
                <td data-selenium-id="Rent_{number}">{rent}</td>
                <td data-selenium-id="Availability_{number}">{action}</td>
                <td style="display:none"><img id="FP_Image_{number}"></td></tr>''')
        if state["reverse"]:
            rows.reverse()
        return '<title>OurDomain fixture</title><table>' + "".join(rows) + "</table>"

    def route(request):
        if "availableunits.aspx" in request.request.url:
            request.fulfill(content_type="text/html; charset=utf-8", body='''<title>Application</title><h1>Application page</h1><form onsubmit="window.submitted=true;return false">
                <label>First name<input id="given" name="firstName" autocomplete="given-name"></label>
                <label>Last name<input id="surname" name="lastName"></label>
                <label>Email<input id="mail" type="email" autocomplete="email" value="existing@example.com"></label>
                <label>Phone<input id="phone" type="tel" autocomplete="tel"></label>
                <label>Street address<input id="address" autocomplete="street-address"></label>
                <label>Postal code<input id="postal" autocomplete="postal-code"></label>
                <label>City<input id="city" autocomplete="address-level2"></label>
                <label>Confirm email<input id="confirm" type="email"></label>
                <input id="secret" type="password"><input id="hidden-name" type="hidden" name="firstName">
                <input id="readonly" name="lastName" readonly><input id="disabled" name="firstName" disabled>
                <label><input id="consent" type="checkbox">Agree to terms</label><button type="submit">Submit</button>
                </form><script>window.events=0;document.addEventListener("input",()=>window.events++);</script>''' )
        else:
            request.fulfill(content_type="text/html; charset=utf-8", body=html())

    with TemporaryDirectory(prefix="spotalert-features-", dir="/private/tmp") as temporary:
        temporary = Path(temporary)
        extension = temporary / "extension"
        shutil.copytree(ROOT / "SpotAlert/chrome_extension", extension)
        with sync_playwright() as playwright:
            def launch():
                browser_context = playwright.chromium.launch_persistent_context(
                    str(temporary / "profile"), channel="chromium", headless=True,
                    viewport={"width": 1000, "height": 1000},
                    args=["--disable-features=DisableLoadExtensionCommandLineSwitch", f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
                    ignore_default_args=["--disable-extensions"],
                )
                worker = browser_context.service_workers[0] if browser_context.service_workers else browser_context.wait_for_event("serviceworker")
                worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profiles disabled in isolated tests');};}")
                return browser_context

            context = launch()
            errors = []
            try:
                context.route("https://thisisourdomain.securerc.co.uk/**", route)
                context.route("https://southeast-thisisourdomain.securerc.co.uk/**", route)
                listing_page = context.new_page()
                listing_page.goto(URL)
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profile folder disabled in isolated tests');};}")
                extension_id = worker.url.split("/")[2]
                panel = context.new_page()
                panel.on("pageerror", lambda error: errors.append(str(error)))
                panel.goto(f"chrome-extension://{extension_id}/panel.html")
                panel.get_by_role("tab", name="Locations", exact=True).click()

                def dismiss():
                    expect(panel.locator("#availability-popup")).to_have_count(0)

                def check():
                    previous_tab = panel.locator('.app-tabs [aria-selected="true"]').get_attribute("id")
                    panel.get_by_role("tab", name="Locations", exact=True).click()
                    before = int(panel.locator("#check-count").text_content())
                    panel.get_by_role("button", name="↻ Check now", exact=True).click()
                    expect(panel.locator("#check-count")).to_have_text(str(before + 1), timeout=30000)
                    panel.locator(f"#{previous_tab}").click()

                def edit():
                    if not panel.locator(".monitor-options").evaluate("node=>node.open"):
                        panel.locator(".monitor-options > summary").click()
                    panel.get_by_role("button", name="Configure monitor", exact=True).click()
                    expect(panel.locator("#editor")).to_be_visible()
                    if not panel.locator("#floorplan-filters").is_visible():
                        panel.get_by_text("Specific floor plans", exact=True).click()

                def save():
                    panel.get_by_role("button", name="Save monitor", exact=True).click()
                    expect(panel.locator("#editor")).not_to_be_visible()

                panel.get_by_role("button", name="Start general monitoring", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("1", timeout=30000)
                state["a"] = True
                check()
                expect(panel.locator("#availability-popup")).to_have_count(0)
                dismiss()
                state["b"] = True
                check()
                panel.screenshot(path=str(ARTIFACTS / "listing-alert.png"))
                dismiss()
                state["reverse"] = True
                check()
                expect(panel.locator("#availability-popup")).to_have_count(0)
                edit()
                panel.locator('[name="apartment-type"][value="studio"]').check()
                panel.locator('[name="floorplan"][value="floorplan:101"]').check()
                panel.locator("#preview-rule").click()
                expect(panel.locator("#preview-result")).to_contain_text("Available · 1/2 elements matched")
                save()
                panel.get_by_role("button", name="Start general monitoring", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("5", timeout=30000)
                dismiss()
                expect(panel.locator(".sample").filter(has_text="1 Bedroom B")).to_contain_text("Filtered out")
                expect(panel.locator(".sample").first).to_contain_text("Superior Studio A")
                panel.get_by_role("button", name="Available", exact=True).click()
                expect(panel.locator(".sample")).to_have_count(1)
                expect(panel.locator(".sample")).to_contain_text("Superior Studio A")
                panel.get_by_role("button", name="All", exact=True).click()
                edit()
                panel.locator('[name="apartment-type"][value="studio"]').uncheck()
                panel.locator('[name="floorplan"][value="floorplan:101"]').uncheck()
                save()
                panel.get_by_role("button", name="Start general monitoring", exact=True).click()
                expect(panel.locator("#check-count")).to_have_text("6", timeout=30000)
                dismiss()
                state["a"] = False
                check()
                expect(panel.locator("#popup-snooze")).to_have_count(0)
                edit()
                hour = datetime.now(timezone.utc).hour
                start = f"{(hour + 2) % 24:02}:00"
                end = f"{(hour + 3) % 24:02}:00"
                panel.locator("#hours-enabled").check()
                panel.locator("#hours-start").fill(start)
                panel.locator("#hours-end").fill(end)
                panel.locator("#hours-timezone").fill("UTC")
                panel.screenshot(path=str(ARTIFACTS / "monitor-settings.png"))
                save()
                before = int(panel.locator("#check-count").text_content())
                panel.get_by_role("button", name="Start general monitoring", exact=True).click()
                expect(panel.locator(".activity-caption")).to_have_text("Waiting for monitoring hours")
                expect(panel.locator("#check-count")).to_have_text(str(before))
                check()
                dismiss()
                state["mode"] = "verification"
                panel.get_by_role("button", name="↻ Check now", exact=True).click()
                expect(panel.locator(".attention-monitor")).to_contain_text("verification", timeout=30000)
                expect(panel.locator(".attention-monitor")).to_contain_text("OurDomain · Amsterdam Diemen")
                affected_id = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors[0].tabId")
                panel.get_by_role("button", name="Open affected tab ↗", exact=True).click()
                assert worker.evaluate("async id => (await chrome.tabs.get(id)).active", affected_id)
                state["mode"] = "login"
                panel.get_by_role("button", name="↻ Check now", exact=True).click()
                expect(panel.locator(".attention-monitor")).to_contain_text("sign in", timeout=30000)
                state["mode"] = "normal"
                check()
                expect(panel.locator(".attention-monitor")).to_have_count(0)
                edit()
                panel.locator("#rule-selector").fill("[")
                panel.locator("#preview-rule").click()
                expect(panel.locator("#form-error")).to_contain_text("Invalid CSS selector")
                panel.locator("#close-editor").click()
                panel.get_by_role("button", name="Stop general monitoring", exact=True).click()
                expect(panel.locator("#active-count")).to_have_text("0")
                panel.get_by_role("tab", name="Profiles", exact=True).click()
                panel.locator(".profile-group").filter(has_text="Current housing").locator("summary").click()
                for field, value in {"firstName": "Alex", "lastName": "Example", "email": "alex@example.com", "phone": "+31612345678", "address": "Example street 1", "postalCode": "1234 AB", "city": "Amsterdam"}.items():
                    panel.locator(f"#personal-{field}").fill(value)
                panel.get_by_role("button", name="Save profile", exact=True).click()
                expect(panel.locator("#personal-view")).to_be_visible()
                expect(panel.locator("#application-readiness")).to_have_text("Missing details")
                panel.get_by_role("tab", name="Profiles", exact=True).click()
                panel.locator("#personal-firstName").fill("Unsaved name")
                worker.evaluate("async () => { const key = 'spotalert.ui.v1'; await chrome.storage.local.set({[key]: {compact: true}}); }")
                expect(panel.locator("body")).to_have_class("compact")
                expect(panel.locator("#personal-firstName")).to_have_value("Unsaved name")
                panel.locator("#personal-firstName").fill("Alex")
                for width in [320, 390, 1280]:
                    panel.set_viewport_size({"width": width, "height": 1000})
                    assert panel.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Personal tab overflows at {width}px"
                panel.set_viewport_size({"width": 390, "height": 1000})
                panel.screenshot(path=str(ARTIFACTS / "personal-information.png"))
                panel.get_by_role("tab", name="Settings", exact=True).click()
                panel.locator("#advanced-settings > summary").click()
                panel.locator(".debug-section > summary").click()
                expect(panel.locator("#debug-mode")).not_to_be_checked()
                panel.locator("#debug-mode").check()
                expect(panel.locator("#debug-mode")).to_be_enabled()
                panel.get_by_role("tab", name="Locations", exact=True).click()
                check()
                panel.get_by_role("tab", name="Settings", exact=True).click()
                expect(panel.locator(".debug-capture > summary").first).to_contain_text("· form", timeout=30000)
                expect(panel.locator("#debug-count")).to_have_text("1")
                captures = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].debug.captures")
                assert all(capture["snapshot"]["pageKind"] == "form" for capture in captures)
                assert any(field["id"] == "given" for field in captures[0]["snapshot"]["fields"])
                assert "existing@example.com" not in json.dumps(captures)
                assert all("value" not in field for capture in captures for field in capture["snapshot"]["fields"])
                tab_count = len(context.pages)
                check()
                assert len(context.pages) == tab_count, "Debug reopened unchanged links"
                panel.locator(".debug-capture > summary").first.click()
                expect(panel.locator(".debug-output").first).to_contain_text('"fields"')
                panel.screenshot(path=str(ARTIFACTS / "debug-capture.png"), full_page=True)
                with panel.expect_download() as download:
                    panel.locator("#export-debug").click()
                exported = json.loads(Path(download.value.path()).read_text())
                assert len(exported["captures"]) == 1
                assert all("tabId" not in capture for capture in exported["captures"])
                panel.locator("#clear-debug").click()
                expect(panel.locator("#debug-count")).to_have_text("0")
                panel.get_by_role("tab", name="Locations", exact=True).click()
                check()
                panel.get_by_role("tab", name="Settings", exact=True).click()
                expect(panel.locator("#debug-count")).to_have_text("0")
                panel.locator("#debug-mode").uncheck()
                expect(panel.locator("#debug-mode")).to_be_enabled()

                assert not errors, errors
            finally:
                context.close()
            context = launch()
            try:
                panel = context.new_page()
                panel.goto(f"chrome-extension://{extension_id}/panel.html")
                panel.get_by_role("tab", name="Locations", exact=True).click()
                edit()
                expect(panel.locator("#hours-enabled")).to_be_checked()
                expect(panel.locator("#hours-timezone")).to_have_value("UTC")
                panel.locator("#close-editor").click()
                expect(panel.locator("#active-count")).to_have_text("0")
                panel.get_by_role("tab", name="Profiles", exact=True).click()
                expect(panel.locator("#personal-firstName")).to_have_value("Alex")
                expect(panel.locator("#personal-email")).to_have_value("alex@example.com")
                panel.locator(".profile-tools > summary").click()
                panel.get_by_role("button", name="Delete profile", exact=True).click()
                expect(panel.locator("#personal-firstName")).to_have_value("")
                expect(panel.locator("#application-readiness")).to_have_text("Awaiting information")
                panel.get_by_role("tab", name="Locations", exact=True).click()
                panel.get_by_role("tab", name="Profiles", exact=True).click()
                expect(panel.locator("#personal-email")).to_have_value("")
            finally:
                context.close()
    print("Feature browser test passed: location filters, monitoring hours, verification/login recovery, profile editing, debug capture/export, and persistence; no Monitoring alerts.")


if __name__ == "__main__":
    main()
