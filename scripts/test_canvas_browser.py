"""Exercise Canvas RentCafe support with an isolated synthetic listing page."""

from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://canvas-world.securerc.co.uk/onlineleasing/andre-van-der-louwbrug-4-rotterdam-3011-wm/floorplans.aspx'


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profile folder disabled in isolated tests');};}")
            fixture = '''<html><title>Canvas Rotterdam Blaak</title><body>
            <div id="FP_Detail_501"><h2 data-selenium-id="FloorPlanName">1 Bedroom Executive</h2><table><tr><td data-selenium-id="Bed_1">1</td><td data-selenium-id="Bath_1">1</td><td data-selenium-id="Rent_1">€ 1.724 -to € 1.733</td><td data-selenium-id="Apply_1"><a data-selenium-id="ApplyNow" href="availableunits.aspx?myFloorPlanId=501">Check availability</a></td></tr></table></div>
            <div id="FP_Detail_502" style="display:none"><h2 data-selenium-id="FloorPlanName">Standard Studio</h2><table><tr><td data-selenium-id="Bed_2">Studio</td><td data-selenium-id="Availability_2"><button>Get Notified</button></td></tr></table></div>
            <div style="display:none"><table><tr><td data-selenium-id="Apply_1"><a data-selenium-id="ApplyNow">Check availability</a></td></tr></table></div></body></html>'''
            units = '''<input type="button" value="Book now" onclick="return ApplyNowClick('450281','501','186511','17-10-2026','termsandotheritems.aspx');">
            <script>function ApplyNowClick(){location.href='termsandotheritems.aspx?UnitID=450281&FloorPlanID=501';}</script>'''
            booking = '''<label for="sMoveInDate">Move-in Date</label><input id="sMoveInDate" value="17-10-2026">
            <script type="text/plain">$('#sMoveInDate').datepicker({minDate: '17-10-2026', maxDate: '30-10-2026'}); var excludedDays = [0,6];</script>
            <button onclick="document.body.dataset.submitted='yes'">Start Application</button>'''
            def portal(route):
                body = booking if 'termsandotheritems.aspx' in route.request.url else units if 'availableunits.aspx' in route.request.url else fixture
                if 'termsandotheritems.aspx' in route.request.url:
                    from urllib.parse import parse_qs, urlparse
                    date = parse_qs(urlparse(route.request.url).query).get('MoveInDate', ['17-10-2026'])[0]
                    body = body.replace('value="17-10-2026"', f'value="{date}"')
                    body += '''<script>document.querySelector('#sMoveInDate').addEventListener('change',event=>{const url=new URL(location.href);url.searchParams.set('MoveInDate',event.target.value);location.href=url.href;});</script>'''
                    body += '''<script>
                    const start=document.querySelector('button');start.removeAttribute('onclick');
                    window.jQuery={active:1,_data:()=>({})};
                    setTimeout(()=>{const replacement=start.cloneNode(true);start.replaceWith(replacement);
                    replacement.addEventListener('click',()=>{location.href='oleapplication.aspx?stepname=intapplicantinfo';});
                    window.jQuery.active=0;window.jQuery._data=()=>({click:[{}]});},2500);
                    </script>'''
                if 'oleapplication.aspx' in route.request.url:
                    body = '<input id="ProspectFirstName"><input id="ProspectLastName"><input id="ProspectEmail" value="existing@example.com"><input id="Currentaddr999Addr1"><input id="EmergencyPhone"><input type="checkbox" id="chkAgreement"><button onclick="document.body.dataset.submitted=1">Submit</button>'
                route.fulfill(body=body, content_type='text/html')
            context.route('https://canvas-world.securerc.co.uk/**', portal)
            site = context.new_page()
            site.goto(URL)
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role("tab", name="Locations", exact=True).click()
            expect(panel.locator('#monitor-count')).to_have_text('3')
            panel.get_by_role('button', name='Canvas · Rotterdam Blaak', exact=False).click()
            panel.get_by_role('button', name='↻ Check now', exact=True).click()
            expect(panel.locator('#availability-listings')).to_contain_text('1 Bedroom Executive', timeout=30000)
            panel.locator('#dismiss-availability').click()
            expect(panel.locator('.sample')).to_have_count(2)
            expect(panel.locator('.sample').filter(has_text='1 Bedroom Executive')).to_contain_text('Available')
            expect(panel.locator('.sample').filter(has_text='Standard Studio')).to_contain_text('Not available')
            panel.evaluate("async () => chrome.runtime.sendMessage({type:'save-profile',profile:{moveInFrom:'2026-10-24',firstName:'Alex',lastName:'Example',address:'Home street 1',emergencyPhone:'+31687654321'}})")
            with context.expect_page() as opened:
                panel.locator('.sample').filter(has_text='1 Bedroom Executive').get_by_role('button', name='Apply').click()
                panel.locator('#confirm-apply').click()
            destination = opened.value
            expect(destination).to_have_url(__import__('re').compile('termsandotheritems.aspx'), timeout=30000)
            expect(destination.locator('#sMoveInDate')).to_have_value('26-10-2026', timeout=30000)
            expect(destination).to_have_url(__import__('re').compile('oleapplication.aspx'), timeout=30000)
            expect(destination.locator('#ProspectFirstName')).to_have_value('Alex', timeout=15000)
            expect(destination.locator('#Currentaddr999Addr1')).to_have_value('Home street 1')
            expect(destination.locator('#EmergencyPhone')).to_have_value('+31687654321')
            expect(destination.locator('#ProspectEmail')).to_have_value('existing@example.com')
            expect(destination.locator('#chkAgreement')).not_to_be_checked()
            assert destination.locator('body').get_attribute('data-submitted') is None
            panel.evaluate("async () => chrome.runtime.sendMessage({type:'clear-profile'})")
            with context.expect_page() as earliest:
                panel.locator('.sample').filter(has_text='1 Bedroom Executive').get_by_role('button', name='Apply').click()
                panel.locator('#confirm-apply').click()
            expect(earliest.value.locator('#sMoveInDate')).to_have_value('19-10-2026', timeout=30000)
            expect(earliest.value).to_have_url(__import__('re').compile('oleapplication.aspx'), timeout=30000)
            expect(earliest.value.locator('#ProspectFirstName')).to_have_value('')
            assert earliest.value.locator('body').get_attribute('data-submitted') is None
            expect(site).to_have_url(URL)
            assert worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.filter(m=>m.id.startsWith('ourdomain')).every(m=>m.checks===0)")
        finally:
            context.close()
    print('Canvas browser check passed: catalog, collapsed plans, duplicate controls, names, rent, availability and application links; OurDomain unchanged.')


if __name__ == '__main__':
    main()
