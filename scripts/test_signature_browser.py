"""Exercise the opt-in Canvas signature action using isolated, synthetic pages."""
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://canvas-world.securerc.co.uk/onlineleasing/test/oleapplication.aspx?stepname=IntApplicantInfo'
FIXTURE = '''<html><body>
<label><input type="checkbox" id="chkAgreement">Agreement</label>
<input type="checkbox" id="chkTandCAgree">
<a id=" ToggleScriptSignatureLin" href="#!" onclick="document.querySelector('#scriptSig').style.display='block';document.querySelector('#usersignatureType').value='1'">Choose a script signature</a>
<div id="scriptSig" style="display:none">
<input type="radio" name="selectedSignature" id="signatureOption2" aria-label="Signature Type 1" onclick="document.querySelector('#usersignatureFont').value='2'">
<input type="radio" name="selectedSignature" id="signatureOption11" aria-label="Signature Type 2" onclick="document.querySelector('#usersignatureFont').value='11'">
</div><input type="hidden" id="usersignatureType"><input type="hidden" id="usersignatureFont">
<button onclick="document.body.dataset.saved='yes'">Save</button>
<button onclick="document.body.dataset.submitted='yes'">Save &amp; Continue</button>
</body></html>'''


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
            ignore_default_args=['--disable-extensions'])
        try:
            context.route('https://**/*', lambda route: route.fulfill(body=FIXTURE, content_type='text/html'))
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profile storage disabled in tests');};}")
            site = context.new_page()
            site.goto(URL)
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role('tab', name='Personal information', exact=True).click()
            expect(panel.locator('.signature-test-card')).to_have_count(1)
            action = panel.locator('#prepare-signature')
            expect(action).to_be_disabled()
            expect(panel.locator('#find-signature-tabs')).to_have_count(0)
            tab_id = worker.evaluate("async()=> (await chrome.tabs.query({url:'https://canvas-world.securerc.co.uk/*'}))[0].id")
            expect(site.locator('#chkAgreement')).not_to_be_checked()
            # The background also rejects messages without explicit opt-in.
            result = panel.evaluate("id=>chrome.runtime.sendMessage({type:'prepare-canvas-signature',tabId:Number(id)})", tab_id)
            assert result['ok'] is False
            panel.locator('#signature-consent').check()
            expect(action).to_be_enabled()
            action.click()
            expect(panel.locator('#signature-test-status')).to_contain_text('Signature Type 1 selected')
            expect(site.locator('#chkAgreement')).to_be_checked()
            expect(site.locator('#signatureOption2')).to_be_checked()
            expect(site.locator('#signatureOption11')).not_to_be_checked()
            expect(site.locator('#chkTandCAgree')).to_be_checked()
            expect(site.locator('#usersignatureFont')).to_have_value('2')
            expect(site.locator('#usersignatureType')).to_have_value('1')
            expect(panel.locator('#signature-consent')).not_to_be_checked()
            expect(action).to_be_disabled()
            assert site.locator('body').get_attribute('data-saved') is None
            assert site.locator('body').get_attribute('data-submitted') is None
            step = panel.evaluate("""async id => {
                const {applicationStep} = await import(chrome.runtime.getURL('application.js'));
                return (await chrome.scripting.executeScript({target:{tabId:Number(id)},world:'MAIN',func:applicationStep,args:[true]}))[0].result;
            }""", tab_id)
            assert step['kind'] == 'signature'
            assert site.locator('body').get_attribute('data-submitted') is None
            # Repeating does not toggle off already selected controls.
            panel.locator('#signature-consent').check()
            action.click()
            expect(panel.locator('#signature-test-status')).to_contain_text('Signature Type 1 selected')
            expect(panel.locator('#signature-consent')).not_to_be_checked()
            expect(site.locator('#chkAgreement')).to_be_checked()
            # Stale tab selections cannot act on later application steps.
            site.goto(URL.replace('IntApplicantInfo', 'ApplicationCharges'))
            panel.locator('#signature-consent').check()
            action.click()
            expect(panel.locator('#signature-test-status')).to_contain_text('Open your Canvas')
            expect(site.locator('#chkAgreement')).not_to_be_checked()
            # Missing, disabled and broken controls fail without consenting.
            for change in [
                "document.querySelector('#signatureOption2').remove()",
                "document.querySelector('#signatureOption2').disabled=true",
                "document.querySelector('#signatureOption2').onclick=null",
                "document.querySelector('#chkAgreement').disabled=true",
            ]:
                site.goto(URL)
                site.evaluate(change)
                panel.locator('#signature-consent').check()
                action.click()
                expect(panel.locator('#signature-test-status')).to_contain_text('website' if 'onclick' in change else 'unavailable')
                expect(site.locator('#chkAgreement')).not_to_be_checked()
                assert site.locator('body').get_attribute('data-submitted') is None
            # Fill application form uses the same open page and both explicit opt-ins.
            site.goto(URL)
            result = panel.evaluate("()=>chrome.runtime.sendMessage({type:'save-profile',profile:{firstName:'Alex',lastName:'Example'}})")
            assert result['ok'] is True
            panel.reload()
            panel.get_by_role('tab', name='Personal information', exact=True).click()
            panel.locator('#signature-consent').check()
            panel.locator('#fill-application').click()
            expect(panel.locator('#signature-test-status')).to_contain_text('Signature Type 1 selected')
            expect(site.locator('#chkAgreement')).to_be_checked()
            expect(site.locator('#signatureOption2')).to_be_checked()
            expect(site.locator('#chkTandCAgree')).to_be_checked()
            assert site.locator('body').get_attribute('data-submitted') is None
            # Apply also carries the explicit selections through the whole run.
            panel.evaluate("""async url => {
                const key='spotalert.monitors.v2';
                const value=(await chrome.storage.local.get(key))[key];
                const monitor=value.monitors.find(m=>m.id==='canvas-rotterdam-blaak');
                monitor.url=url;
                monitor.samples=[{id:'signature-test',matched:true,name:'Test apartment'}];
                await chrome.storage.local.set({[key]:value});
            }""", URL)
            with context.expect_page() as opened:
                result = panel.evaluate("()=>chrome.runtime.sendMessage({type:'open-listing',id:'canvas-rotterdam-blaak',listingId:'signature-test',signatureConsent:true,screening:true})")
            assert result['ok'] is True, result
            destination = opened.value
            expect(destination.locator('#chkAgreement')).to_be_checked()
            expect(destination.locator('#chkTandCAgree')).to_be_checked()
            expect(destination.locator('#signatureOption2')).to_be_checked()
            assert destination.locator('body').get_attribute('data-submitted') is None
        finally:
            context.close()
    print('Canvas signature test passed: explicit opt-in, first signature, repeat, stale tabs, missing/disabled controls, handler failure, no save or submit.')


if __name__ == '__main__':
    main()
