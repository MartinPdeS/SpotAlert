"""Check expanded profile storage and person-specific Canvas autofill."""
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://canvas-world.securerc.co.uk/onlineleasing/andre-van-der-louwbrug-4-rotterdam-3011-wm/oleapplication.aspx?stepname=intapplicantinfo'


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role('tab', name='Personal information', exact=True).click()
            for summary in panel.locator('.profile-group summary').all():
                if not summary.evaluate('(e)=>e.parentElement.open'):
                    summary.click()
            values = {'firstName':'Alex', 'lastName':'Example', 'email':'alex@example.com', 'phone':'+31612345678', 'dateOfBirth':'1995-03-04', 'address':'Home street 1', 'postalCode':'1234 AB', 'city':'Rotterdam', 'employerAddress':'Work street 2', 'employerPhone':'+31201234567', 'emergencyName':'Sam Example', 'emergencyPhone':'+31687654321', 'emergencyAddress':'Contact street 3', 'emergencyPostalCode':'5678 CD', 'emergencyCity':'Utrecht', 'monthlyHousingCost':'0'}
            for field, value in values.items():
                panel.locator(f'#personal-{field}').fill(value)
            for field, value in {'title':'Mr.', 'noMiddleName':'Yes', 'employmentStatus':'Employed', 'hasPets':'No', 'hasVehicles':'Yes', 'receiveEmail':'No'}.items():
                panel.locator(f'#personal-{field}').select_option(value)
            panel.get_by_role('button', name='Save personal information', exact=True).click()
            expect(panel.locator('#application-readiness')).to_contain_text('details prepared')
            panel.reload()
            expect(panel.locator('#personal-dateOfBirth')).to_have_value('1995-03-04')
            expect(panel.locator('#personal-hasPets')).to_have_value('No')
            fields = ['ProspectFirstName', 'ProspectPhone', 'ProspectDOB999', 'DOBLEASEBUT_REQINFO4', 'Currentaddr999Addr1', 'Currentaddr999ZipCode', 'Currentaddr999City', 'Empaddr999Addr1', 'EmpPhone999', 'EmergencyContactName', 'EmergencyPhone', 'Emergaddr999Addr1', 'Emergaddr999ZipCode', 'Emergaddr999City', 'Currentrentpaid999', 'UnknownPhone', 'ProspectMiddleName']
            fixture = ''.join(f'<input id="{field}">' for field in fields)
            fixture += '<input id="DOBLEASEBUT_REQINFO9" value="01-01-2000"><input id="ProspectDOB" type="date"><input id="EmergencyDOB" value="01-01-1980">'
            fixture += '<input id="ProspectEmail" value="existing@example.com"><input type="checkbox" id="chkMiddleName"><input type="checkbox" id="chkAgreement"><input type="checkbox" id="chkTandCAgree">'
            fixture += '<select id="Status999"><option value=""></option><option>Employed</option></select><select id="Receive1LEASEBUT_REQINFO4"><option value=""></option><option>No</option><option>Yes</option></select>'
            fixture += '<label><input type="radio" name="hasPets" value="1">Yes</label><label><input type="radio" name="hasPets" value="0">No</label><label><input type="radio" name="hasVehicles" value="1">Yes</label><label><input type="radio" name="hasVehicles" value="0">No</label>'
            context.route('https://canvas-world.securerc.co.uk/**', lambda route: route.fulfill(body=fixture, content_type='text/html'))
            form = context.new_page()
            form.goto(URL)
            worker.evaluate("async () => {const tabs=await chrome.tabs.query({});const t=tabs.find(t=>t.url.includes('oleapplication.aspx'));await chrome.tabs.update(t.id,{active:true});}")
            response = panel.evaluate("async () => chrome.runtime.sendMessage({type:'fill-application'})")
            assert response['ok'], response
            result = response['result']
            assert result['count'] > 15, result
            expected = {'ProspectFirstName':'Alex', 'ProspectPhone':'+31612345678', 'ProspectDOB999':'04-03-1995', 'DOBLEASEBUT_REQINFO4':'04-03-1995', 'Currentaddr999Addr1':'Home street 1', 'Currentaddr999ZipCode':'1234 AB', 'Currentaddr999City':'Rotterdam', 'Empaddr999Addr1':'Work street 2', 'EmpPhone999':'+31201234567', 'EmergencyContactName':'Sam Example', 'EmergencyPhone':'+31687654321', 'Emergaddr999Addr1':'Contact street 3', 'Emergaddr999ZipCode':'5678 CD', 'Emergaddr999City':'Utrecht', 'Currentrentpaid999':'0', 'ProspectEmail':'existing@example.com', 'UnknownPhone':'', 'ProspectMiddleName':''}
            for field, value in expected.items():
                expect(form.locator(f'#{field}')).to_have_value(value)
            expect(form.locator('#chkMiddleName')).to_be_checked()
            expect(form.locator('#chkAgreement')).not_to_be_checked()
            expect(form.locator('#chkTandCAgree')).not_to_be_checked()
            expect(form.locator('[name=hasPets][value="0"]')).to_be_checked()
            expect(form.locator('[name=hasVehicles][value="1"]')).to_be_checked()
            expect(form.locator('#Status999')).to_have_value('Employed')
            expect(form.locator('#Receive1LEASEBUT_REQINFO4')).to_have_value('No')
            expect(form.locator('#DOBLEASEBUT_REQINFO9')).to_have_value('04-03-1995')
            expect(form.locator('#ProspectDOB')).to_have_value('1995-03-04')
            expect(form.locator('#EmergencyDOB')).to_have_value('01-01-1980')
            for width in [320, 1280]:
                panel.set_viewport_size({'width':width,'height':900})
                panel.get_by_role('tab', name='Personal information', exact=True).click()
                assert panel.evaluate('document.documentElement.scrollWidth <= innerWidth')
        finally:
            context.close()
    print('Expanded profile browser check passed: persistence, separate people, dates, choices, consent untouched and responsive layout.')


if __name__ == '__main__':
    main()
