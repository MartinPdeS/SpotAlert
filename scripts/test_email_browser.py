"""Verify shared email Settings with explicit profile recipients and a fake provider."""
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(
            profile, channel='chromium', headless=True,
            args=['--disable-features=DisableLoadExtensionCommandLineSwitch',
                  f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
            ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate('''() => {
              chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profiles disabled in isolated tests');};
              globalThis.emailRequests=[];
              globalThis.fetch=async(url,options)=>{
                if(url!=='https://api.resend.com/emails') throw new Error('Unexpected test endpoint');
                if(options.headers.Authorization!=='Bearer re_fake') return {ok:false,status:401,json:async()=>({})};
                emailRequests.push(JSON.parse(options.body));
                return {ok:true,json:async()=>({id:'fake-email'})};
              };
            }''')
            page = context.new_page()
            page.goto(worker.url.replace('background.js', 'panel.html'))
            page.evaluate('''async()=>{
              await chrome.runtime.sendMessage({type:'save-profile',profile:{email:'profile@example.com'},name:'Alex'});
              await chrome.storage.local.set({'spotalert.notification-destinations.v1':{email:'legacy@example.com'}});
            }''')
            page.get_by_role('tab', name='Settings', exact=True).click()
            expect(page.locator('#notification-email')).to_have_count(0)
            expect(page.locator('#email-enabled')).to_have_count(0)
            expect(page.get_by_role('tab', name='Notifications', exact=True)).to_have_count(0)
            for width in [320, 390, 1280]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#email-api-key').fill('re_fake')
            page.locator('#email-sender').fill('sender@example.com')
            page.get_by_role('button', name='Save settings', exact=True).click()
            expect(page.locator('#email-save-status')).to_have_text('Settings saved')
            page.locator('#test-email').click()
            expect(page.locator('#toast')).to_contain_text('Select a recipient profile')
            assert worker.evaluate('emailRequests.length') == 0
            page.locator('#email-test-profile').select_option('default')
            page.locator('#test-email').click()
            expect(page.locator('#toast')).to_contain_text('Test email accepted')
            assert worker.evaluate('emailRequests.length') == 1
            assert worker.evaluate('emailRequests[0].to') == ['profile@example.com']
            assert worker.evaluate('emailRequests[0].from') == 'sender@example.com'
            page.reload()
            page.get_by_role('tab', name='Settings', exact=True).click()
            expect(page.locator('#email-api-key')).to_have_value('re_fake')
            expect(page.locator('#email-sender')).to_have_value('sender@example.com')
            page.locator('#email-test-profile').select_option('default')
            page.locator('#email-api-key').fill('re_wrong')
            page.locator('#test-email').click()
            expect(page.locator('#toast')).to_contain_text('Resend rejected the API key')
            assert worker.evaluate('emailRequests.length') == 1
            ROOT.joinpath('artifacts/extension').mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(ROOT / 'artifacts/extension/email-settings.png'), full_page=True)
            print('Email Settings browser checks passed; no real emails sent.')
        finally:
            context.close()


if __name__ == '__main__':
    main()
