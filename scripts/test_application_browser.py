"""Exercise automated RentCafe steps for every supported location."""
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Native profile folder disabled in isolated tests');};}")
            sites = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2']?.monitors?.map(m=>({id:m.id,name:m.name,url:m.url}))||[]")
            while not sites:
                worker.evaluate('new Promise(resolve=>setTimeout(resolve,100))')
                sites = worker.evaluate("async () => (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2']?.monitors?.map(m=>({id:m.id,name:m.name,url:m.url}))||[]")

            def portal(route):
                url = route.request.url
                host = urlparse(url).hostname
                if 'floorplans.aspx' in url:
                    body = '''<div id="FP_Detail_101"><table><td data-selenium-id="Apply_1"><a data-selenium-id="ApplyNow" href="availableunits.aspx?myFloorPlanId=101">Check availability</a></td></table></div>'''
                elif 'availableunits.aspx' in url:
                    body = '''<input type="button" value="Book now" onclick="ApplyNowClick('10','101','1','17-10-2026','termsandotheritems.aspx')"><script>function ApplyNowClick(){location.href='termsandotheritems.aspx?UnitID=10&FloorPlanID=101'}</script>'''
                elif 'termsandotheritems.aspx' in url:
                    step = 'Registration' if host.startswith('southeast-') else 'intapplicantinfo'
                    body = f'''<input id="sMoveInDate" value="17-10-2026"><script type="text/plain">$('#sMoveInDate').datepicker({{minDate:'17-10-2026',maxDate:'30-10-2026'}});var excludedDays=[0,6];</script><button onclick="location.href='oleapplication.aspx?stepname={step}'">Start Application</button>'''
                elif 'stepname=Registration' in url:
                    body = ''.join(f'<input id="{field}" class="required">' for field in ['txtName', 'txtName2', 'txtEmail', 'txtPhone', 'BirthDate']) + '<input id="txtPassword" type="password"><button onclick="document.body.dataset.created=1">Create my account</button>'
                elif 'stepname=intapplicantinfo' in url:
                    body = '<input id="ProspectFirstName" required><input id="ProspectLastName" required>'
                    if host.startswith('canvas'):
                        body += '<label for="NationalityLEASEBUT_REQINFO4">Nationality</label><input id="NationalityLEASEBUT_REQINFO4" required>'
                    body += '<button onclick="window.name=document.querySelector(\'#ProspectFirstName\').value;location.href=\'oleapplication.aspx?stepname=additionalapplicants\'">Next</button>'
                elif 'stepname=additionalapplicants' in url:
                    if host.startswith('canvas'):
                        body = '<label>Proof of income<input type="file"></label><button onclick="document.body.dataset.uploaded=1">Continue</button>'
                    else:
                        body = '<p>No additional applicants</p><button onclick="location.href=\'oleapplication.aspx?stepname=ApplicationCharges\'">Continue</button>'
                else:
                    body = '<h1>Application charges</h1><button onclick="document.body.dataset.paid=1">Pay now</button>'
                route.fulfill(body=body, content_type='text/html')

            context.route('https://*.securerc.co.uk/**', portal)
            profile_data = {'firstName':'Alex', 'lastName':'Example', 'email':'alex@example.com', 'phone':'+31612345678', 'dateOfBirth':'1995-03-04', 'registrationPassword':'TestPassword123!'}
            worker.evaluate("async profile => {const key='spotalert.monitors.v2';const s=(await chrome.storage.local.get(key))[key];for(const m of s.monitors){m.samples=[{id:'floorplan:101',floorplanId:'101',index:1,name:'Test studio',text:'Check availability',matched:true,applicationUrl:m.url.replace('floorplans.aspx','availableunits.aspx?myFloorPlanId=101')}];m.available=true;}await chrome.storage.local.set({[key]:s,'spotalert.application-profile.v1':profile});}", profile_data)
            worker.evaluate("async profile=>{const sam={...profile,firstName:'Sam',email:'sam@example.com'};const k='spotalert.monitors.v2';const s=(await chrome.storage.local.get(k))[k];s.monitors[0].profileId='sam';await chrome.storage.local.set({[k]:s,'spotalert.application-profiles.v1':{activeId:'default',profiles:[{id:'default',name:'Alex',details:profile},{id:'sam',name:'Sam client',details:sam}]}});}", profile_data)
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js','panel.html'))
            for site in sites:
                panel.get_by_role('button', name=site['name'], exact=False).first.click()
                with context.expect_page() as opened:
                    panel.locator('.sample').get_by_role('button', name='Apply').click()
                    expect(panel.locator('#apply-confirmation')).to_be_visible()
                    expect(panel.locator('#apply-confirmation-details')).to_contain_text('Sam client' if site['id'].startswith('ourdomain-amsterdam-diemen') else 'Alex')
                    panel.get_by_role('button', name='Confirm and apply', exact=True).click()
                destination = opened.value
                panel.wait_for_function("async id=>(await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.find(m=>m.id===id).application?.status==='stopped'", arg=site['id'], timeout=45000)
                expect(panel.get_by_role('button', name='Continue application', exact=True)).to_have_count(0)
                if site['id'].startswith('ourdomain-amsterdam-diemen'):
                    expect(destination).to_have_url(__import__('re').compile('ApplicationCharges'))
                    expect(panel.locator('.move-in-feedback')).to_contain_text('19-10-2026')
                    assert destination.evaluate('window.name') == 'Sam'
                    assert destination.locator('body').get_attribute('data-paid') is None
                    expect(panel.locator('.application-progress')).to_have_count(0)
                elif site['id'].startswith('ourdomain-amsterdam-south-east'):
                    expect(destination.locator('#txtName')).to_have_value('Alex')
                    expect(destination.locator('#BirthDate')).to_have_value('04-03-1995')
                    expect(destination.locator('#txtPassword')).to_have_value('TestPassword123!')
                    assert destination.locator('body').get_attribute('data-created') is None
                    expect(panel.locator('.application-progress')).to_have_count(0)
                else:
                    expect(destination.locator('#ProspectFirstName')).to_have_value('Alex')
                    expect(panel.locator('.application-progress')).to_contain_text('Nationality')
                    expect(panel.locator('.application-missing')).to_contain_text('Nationality')
                    destination.locator('#NationalityLEASEBUT_REQINFO4').fill('French')
                    panel.evaluate("async id=>chrome.runtime.sendMessage({type:'continue-application',id})", site['id'])
                    expect(panel.locator('.application-progress')).to_have_count(0)
                    assert destination.locator('body').get_attribute('data-uploaded') is None
                    destination.goto(site['url'].replace('floorplans.aspx', 'oleapplication.aspx?stepname=newstep&token=private-token'))
                    destination.set_content('<label for="custom">Custom question</label><input id="custom" required value="private-answer"><button>Continue</button>')
                    panel.evaluate("async id=>chrome.runtime.sendMessage({type:'continue-application',id})", site['id'])
                    expect(panel.locator('.application-progress')).to_contain_text('This form is unfamiliar', timeout=30000)
                    expect(panel.locator('.application-structure')).to_contain_text('Custom question')
                    with panel.expect_download() as download:
                        panel.get_by_role('button', name='Download form structure', exact=True).click()
                    report = Path(download.value.path()).read_text()
                    assert 'Custom question' in report
                    assert 'private-answer' not in report and 'private-token' not in report

            worker.evaluate("async()=>{await chrome.storage.local.set({'spotalert.resend.v1':{enabled:true,apiKey:'re_fake'},'spotalert.notification-destinations.v1':{email:'alerts@example.com'}});globalThis.fetch=async()=>({ok:false,status:429,json:async()=>({})});chrome.notifications.create=async()=> 'mock';}")
            panel.evaluate("async id=>chrome.runtime.sendMessage({type:'test-alert',id,sound:false})", sites[0]['id'])
            if panel.locator('#availability-popup').is_visible():
                panel.locator('#dismiss-availability').click()
            panel.get_by_role('tab', name='Notifications', exact=True).click()
            expect(panel.locator('.delivery-row').filter(has_text='Email')).to_contain_text('Failed')
            worker.evaluate("()=>{globalThis.fetch=async()=>({ok:true,json:async()=>({id:'mock-sent'})});}")
            panel.locator('.delivery-row').filter(has_text='Email').get_by_role('button', name='Retry', exact=True).click()
            expect(panel.locator('.delivery-row').filter(has_text='Email')).to_contain_text('Sent')
            expect(panel.locator('.delivery-row').filter(has_text='Email')).to_contain_text('2 attempts')
            artifacts = ROOT / 'artifacts/extension'
            artifacts.mkdir(parents=True, exist_ok=True)
            panel.screenshot(path=str(artifacts/'notification-delivery-history.png'), full_page=True)
            probe = context.new_page()
            probe.goto(sites[0]['url'].replace('floorplans.aspx','oleapplication.aspx?stepname=intapplicantinfo'))
            inspect = (ROOT / 'SpotAlert/chrome_extension/application.js').read_text().replace('export function ', 'function ')
            cases = [
                ('agreement', '<label><input type="checkbox" id="chkAgreement">Agree to terms</label><button onclick="document.body.dataset.advanced=1">Next</button>'),
                ('verification', '<h1>Verify you are human</h1><button onclick="document.body.dataset.advanced=1">Next</button>'),
                ('missing', '<label>Email<input required type="email" value="invalid"></label><button onclick="document.body.dataset.advanced=1">Next</button>'),
                ('review', '<button onclick="document.body.dataset.advanced=1">Submit application</button>'),
                ('login', '<input type="password"><button onclick="document.body.dataset.advanced=1">Continue</button>'),
            ]
            for kind, body in cases:
                probe.set_content(body)
                result = probe.evaluate('(()=>{' + inspect + ';return applicationStep(true);})()')
                assert result['kind'] == kind, result
                assert probe.locator('body').get_attribute('data-advanced') is None
            probe.goto(sites[0]['url'].replace('floorplans.aspx','oleapplication.aspx?stepname=newstep&token=private-token'))
            probe.set_content('<label for="custom">Custom question</label><input id="custom" required value="private-answer"><button>Continue</button>')
            result = probe.evaluate('(()=>{' + inspect + ';return applicationStep(true);})()')
            assert result['kind'] == 'unfamiliar', result
            assert result['structure']['fields'][0]['label'] == 'Custom question'
            assert 'private-answer' not in str(result['structure'])
            assert 'private-token' not in str(result['structure'])
            assert worker.evaluate("async()=>!(await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.some(m=>JSON.stringify(m.application).includes('TestPassword'))")
        finally:
            context.close()
    print('Application flow passed for all sites: booking/date, autofill, Next, missing fields, resume, registration/documents/payment stops, and private status.')


if __name__ == '__main__':
    main()
