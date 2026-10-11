"""Check direct Resend settings with a fake provider; never sends real email."""

from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as playwright:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = playwright.chromium.launch_persistent_context(profile, channel='chromium', headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate('''() => {
                globalThis.emailRequests = [];
                globalThis.fetch = async (url, options) => {
                    if (url !== 'https://api.resend.com/emails') throw new Error('Unexpected endpoint');
                    if (options.headers.Authorization !== 'Bearer re_fake') return {ok:false,status:401,json:async()=>({})};
                    emailRequests.push(JSON.parse(options.body));
                    return {ok:true,status:200,json:async()=>({id:'fake-email'})};
                };
            }''')
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role('tab', name='Notifications').click()
            expect(panel.locator('#notifications-view .notification-card')).to_have_count(5)
            expect(panel.locator('#popup-snooze')).to_have_count(0)
            expect(panel.get_by_role('combobox', name='Snooze alerts for all locations')).to_have_count(0)
            for width in [320, 390, 1280]:
                panel.set_viewport_size({'width': width, 'height': 1000})
                assert panel.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Cards overflow at {width}px'
            panel.set_viewport_size({'width': 1280, 'height': 1000})
            for selector in ['#notification-sites > .notification-card', '#notification-contact-form .notification-card']:
                heights = panel.locator(selector).evaluate_all('cards => cards.map(card => card.getBoundingClientRect().height)')
                assert max(heights) - min(heights) < 1, f'Unequal card heights: {heights}'
            panel.locator('.email-channel details').evaluate('(node) => { node.open = true; }')
            heights = panel.locator('#notification-contact-form .notification-card').evaluate_all('cards => cards.map(card => card.getBoundingClientRect().height)')
            assert max(heights) - min(heights) < 1, f'Expanded settings break alignment: {heights}'
            screenshot_dir = ROOT / 'artifacts/extension'
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            panel.screenshot(path=str(screenshot_dir / 'notifications-aligned-workspace.png'), full_page=True)
            panel.set_viewport_size({'width': 390, 'height': 1000})
            screenshot_dir = ROOT / 'artifacts/extension'
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            panel.screenshot(path=str(screenshot_dir / 'notifications-redesign.png'), full_page=True)
            panel.locator('#notification-email').fill('recipient@gmail.com')
            panel.locator('#email-api-key').fill('re_fake')
            panel.locator('#email-enabled').check()
            panel.get_by_role('button', name='Save settings').click()
            expect(panel.locator('#toast')).to_contain_text('settings saved')
            panel.locator('#test-email').click()
            expect(panel.locator('#toast')).to_contain_text('Test email sent', timeout=30000)
            requests = worker.evaluate('emailRequests')
            assert len(requests) == 1
            assert requests[0]['to'] == ['recipient@gmail.com']
            assert requests[0]['from'] == 'onboarding@resend.dev'
            panel.reload()
            panel.get_by_role('tab', name='Notifications').click()
            expect(panel.locator('#email-enabled')).to_be_checked()
            expect(panel.locator('#email-api-key')).to_have_value('re_fake')
            # Email toggle saves immediately, even without pressing Save settings.
            panel.locator('#email-enabled').uncheck()
            expect(panel.locator('#email-enabled')).to_be_enabled()
            panel.reload()
            panel.get_by_role('tab', name='Notifications').click()
            expect(panel.locator('#email-enabled')).not_to_be_checked()
            panel.locator('#email-enabled').check()
            expect(panel.locator('#email-enabled')).to_be_enabled()
            panel.reload()
            panel.get_by_role('tab', name='Notifications').click()
            expect(panel.locator('#email-enabled')).to_be_checked()

            website_url = 'https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx'
            context.route('https://thisisourdomain.securerc.co.uk/**', lambda route: route.fulfill(body='<html><body><h1>Apartment website</h1></body></html>', content_type='text/html'))
            website = context.new_page()
            website.goto(website_url)
            # An alert from South East must also appear on the Diemen website.
            worker.evaluate("async () => { const key='spotalert.monitors.v2'; const state=(await chrome.storage.local.get(key))[key]; state.monitors[1].alert={id:'website-test',test:true,at:Date.now(),listings:[{name:'Studio South East',rent:'€900'}]}; await chrome.storage.local.set({[key]:state}); }")
            expect(website.locator('#spotalert-availability')).to_have_count(0)
            website.reload()
            expect(website.locator('#spotalert-availability')).to_have_count(0)
            worker.evaluate("async () => { const key='spotalert.monitors.v2'; const state=(await chrome.storage.local.get(key))[key]; state.monitors[1].alert={id:'website-real',test:false,at:Date.now(),listings:[{name:'Studio South East',rent:'€900'}]}; await chrome.storage.local.set({[key]:state}); }")
            expect(website.locator('#spotalert-availability')).to_have_count(1)
            website.reload()
            expect(website.locator('#spotalert-availability')).to_have_count(1)
            website.keyboard.press('Escape')
            expect(website.locator('#spotalert-availability')).to_have_count(0)
            website.reload()
            expect(website.locator('#spotalert-availability')).to_have_count(0)
            panel.reload()
            panel.get_by_role('tab', name='Notifications').click()
            # Global controls update both sites, rather than only the selected one.
            panel.get_by_label('Pop-up alerts for all locations', exact=True).uncheck()
            assert worker.evaluate("async () => { const p=(await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].alertPreferences; return p.popup === false && p.desktop === true; }")
            expect(panel.get_by_label('Desktop alerts for all locations', exact=True)).to_be_checked()
            panel.get_by_label('Desktop alerts for all locations', exact=True).uncheck()
            expect(panel.get_by_label('Pop-up alerts for all locations', exact=True)).not_to_be_checked()
            panel.get_by_label('Pop-up alerts for all locations', exact=True).check()
            panel.locator('#email-api-key').fill('re_wrong')
            panel.get_by_role('button', name='Save settings').click()
            panel.locator('#test-email').click()
            expect(panel.locator('#toast')).to_contain_text('Resend rejected the API key')
            assert worker.evaluate('emailRequests.length') == 1
        finally:
            context.close()
    print('Direct Resend browser check passed: key persists, sender and recipient, successful delivery and rejected key; no real emails sent.')


if __name__ == '__main__':
    main()
