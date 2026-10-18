"""Exercise Canvas empty-result recovery without contacting a housing website."""
from pathlib import Path

from browser_helpers import isolated_extension, select_building_for_actions
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with isolated_extension() as (context, worker):
        fixture = {"verification": False, "delay": False}
        def portal(route):
            body = '<title>Just a moment</title><div id="challenge-running">Verify you are human</div>' if fixture["verification"] else '<title>Canvas floor plans</title><div id="FP_Detail_101"><h2 data-selenium-id="FloorPlanName">Studio with balcony</h2><table><tr><td data-selenium-id="Availability_101">Check availability</td></tr></table></div>'
            if fixture["delay"] and not fixture["verification"]:
                listing = body.replace("Studio with balcony", "Late studio")
                body = "<title>Canvas floor plans</title><script>setTimeout(()=>{document.body.innerHTML=" + repr(listing) + ";},750)</script>"
            route.fulfill(content_type="text/html", body=body)
        context.route("https://canvas-world.securerc.co.uk/**", portal)
        panel = context.new_page()
        errors = []
        panel.on("pageerror", lambda error: errors.append(str(error)))
        panel.goto(worker.url.replace("background.js", "panel.html"))
        panel.get_by_role("tab", name="Websites", exact=True).click()
        expect(panel.locator("#monitor-count")).to_have_text("3")
        canvas_url = panel.evaluate("async()=> (await import('./sites/index.js')).SUPPORTED_SITES.find(site=>site.id==='canvas-rotterdam-blaak').url")
        site = context.new_page()
        site.goto(canvas_url)
        panel.locator(".monitor-card").filter(has_text="Canvas").click()
        worker.evaluate("""() => {
          const execute=chrome.scripting.executeScript.bind(chrome.scripting);
          globalThis.missingReads=1;
          globalThis.asyncReads=0;
          chrome.scripting.executeScript=async options=>{
            if(options.func.name==='readPage' && options.func.constructor.name==='AsyncFunction') {
              globalThis.asyncReads++; return [{frameId:0,result:null}];
            }
            if(options.func.name==='readPage' && globalThis.missingReads>0) {
              globalThis.missingReads--; return [{frameId:0}];
            }
            return execute(options);
          };
        }""")
        select_building_for_actions(panel)
        panel.get_by_role("button", name="Check now", exact=True).click()
        expect(panel.locator(".sample-name")).to_have_text("Studio with balcony", timeout=20000)
        expect(panel.locator(".error-box, .attention-monitor")).to_have_count(0)
        fixture["delay"] = True
        select_building_for_actions(panel)
        panel.get_by_role("button", name="Check now", exact=True).click()
        expect(panel.locator("#check-count")).to_have_text("2", timeout=20000)
        expect(panel.locator(".sample-name")).to_have_text("Late studio")
        assert worker.evaluate("globalThis.asyncReads") == 0
        fixture["delay"] = False
        worker.evaluate("()=>{globalThis.missingReads=10;}")
        select_building_for_actions(panel)
        panel.get_by_role("button", name="Check now", exact=True).click()
        expect(panel.locator(".attention-monitor")).to_contain_text("no page data after retrying", timeout=20000)
        expect(panel.locator(".attention-monitor")).not_to_contain_text("site access permissions")
        expect(panel.locator(".sample-name")).to_have_text("Late studio")
        fixture["verification"] = True
        worker.evaluate("()=>{globalThis.missingReads=1;}")
        select_building_for_actions(panel)
        panel.get_by_role("button", name="Check now", exact=True).click()
        expect(panel.locator(".attention-monitor")).to_contain_text("verification prompt", timeout=20000)
        assert not errors, errors
        print("Canvas read recovery passed: synchronous reads, late listings, empty-result retry, verification detection, and preserved results.")


if __name__ == "__main__":
    main()
