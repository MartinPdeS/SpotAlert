"""Verify task navigation, recovery actions, profile editing, and responsive results."""
import json
from pathlib import Path

from browser_helpers import isolated_extension
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts/extension'


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with isolated_extension(viewport={'width': 1280, 'height': 900}) as (context, worker):
        context.route('https://**/*', lambda route: route.fulfill(content_type='text/html', body='<h1>Synthetic apartment</h1>'))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(worker.url.replace('background.js', 'panel.html'))
        expect(page.locator('#monitor-count')).to_have_text('3')
        assert page.get_by_role('tab').all_text_contents() == ['My searches', 'Websites', 'Applicants', 'Clients', 'Settings']
        page.get_by_role('tab', name='Applicants', exact=True).click()
        expect(page.locator('.profile-unified-header')).to_have_count(1)
        page.locator('.profile-tools summary').click()
        page.locator('#create-test-profiles').click()
        expect(page.locator('#test-profile-badge')).to_be_visible()
        expect(page.locator('#saved-profile option')).to_have_count(3)
        for width in [320, 768, 1280]:
            page.set_viewport_size({'width': width, 'height': 900})
            for checked in [True, False]:
                page.locator('#personal-noMiddleName').set_checked(checked)
                checkbox = page.locator('#personal-noMiddleName').bounding_box()
                text = page.locator('.profile-checkbox .field-label').bounding_box()
                group = page.locator('.middle-name-field').bounding_box()
                date = page.locator('[data-profile-field="dateOfBirth"]').bounding_box()
                assert 16 <= checkbox['width'] <= 20, checkbox
                assert text['x'] >= checkbox['x'] + checkbox['width'], (checkbox, text)
                assert text['x'] + text['width'] <= group['x'] + group['width'] + 1, (text, group)
                if width > 480:
                    assert group['x'] + group['width'] < date['x'], (group, date)
                    assert abs(group['y'] - date['y']) < 2, (group, date)
            page.locator('#personal-noMiddleName').check()
            page.locator('.profile-group').first.screenshot(path=str(ARTIFACTS / f'identity-layout-{width}.png'))
        page.set_viewport_size({'width': 1280, 'height': 900})
        birth = page.locator('#personal-dateOfBirth').input_value()
        page.locator('#generate-registration-details').click()
        expect(page.locator('#personal-dateOfBirth')).to_have_value(birth)
        page.get_by_role('button', name='Save profile', exact=True).click()
        expect(page.locator('#profile-save-status')).to_have_text('All changes saved')
        page.locator('#saved-profile').select_option('default')
        expect(page.locator('#test-profile-badge')).not_to_be_visible()
        page.locator('#personal-firstName').fill('Actual')
        page.locator('#personal-middleName').fill('Middle')
        page.locator('#personal-noMiddleName').check()
        expect(page.locator('#personal-middleName')).not_to_be_visible()
        assert page.locator('#personal-middleName').input_value() == ''
        page.get_by_role('button', name='Save profile', exact=True).click()
        expect(page.locator('#profile-save-status')).to_have_text('All changes saved')
        page.locator('.missing-profile-fields summary').click()
        page.locator('.missing-field-links').get_by_role('button', name='Nationality →', exact=True).click()
        expect(page.locator('#personal-nationality')).to_be_focused()
        page.locator('#personal-nationality').fill('Dutch')
        employer = page.locator('#personal-employer')
        employer.evaluate('(node)=>node.closest("details").open=true')
        page.locator('#personal-employmentStatus').select_option('Retired')
        expect(employer).not_to_be_visible()
        page.locator('#personal-employmentStatus').select_option('Employed')
        expect(employer).to_be_visible()
        page.get_by_role('button', name='Save profile', exact=True).click()
        page.locator('#personal-emergencyName').evaluate('(node)=>{node.closest("details").open=true;node.scrollIntoView()}')
        box = page.locator('.profile-action-bar').bounding_box()
        assert box['y'] >= 0 and box['y'] + box['height'] <= 901, box
        page.evaluate('''async () => {
          const key='spotalert.monitors.v2'; const state=(await chrome.storage.local.get(key))[key];
          const library=(await chrome.storage.local.get('spotalert.application-profiles.v1'))['spotalert.application-profiles.v1'];
          const location=state.monitors[0];
          const listing={id:'studio',name:'Studio with balcony',matched:true,index:1,rent:'€1,250',size:'32 m²',apartmentType:'studio',pageUrl:location.url};
          location.samples=[listing]; location.available=true; location.lastCheckedAt=Date.now(); location.checks=1;
          state.monitors[1].error='Complete verification in the website tab.'; state.monitors[1].errorKind='verification';
          state.searches=[{id:'test-search',name:'Test apartments',profileId:library.profiles.find(profile=>profile.testProfile).id,enabled:false,locationIds:[location.id],actions:{email:true,autoApply:false},results:{[location.id]:{at:Date.now(),matches:[listing]}},activity:[{id:'failed-email',monitorId:location.id,listingId:'studio',listingName:'Studio with balcony',channel:'email',status:'failed',at:Date.now(),message:'Sender needs configuration.'}]},
          {id:'real-search',name:'Actual applicant',profileId:'default',enabled:true,locationIds:[location.id],actions:{autoApply:true,email:false},results:{},activity:[]}];
          await chrome.storage.local.set({[key]:state});
        }''')
        page.get_by_role('tab', name='My searches', exact=True).click()
        expect(page.locator('.search-card')).to_have_count(2)
        expect(page.locator('.search-card .search-results')).to_have_count(0)
        expect(page.locator('.search-card .test-profile-badge')).to_have_count(1)
        page.locator('#show-attention').click()
        expect(page.locator('#attention-list')).to_contain_text('Sender needs configuration')
        page.locator('#attention-list').get_by_role('button', name='Complete profile', exact=True).click()
        expect(page.locator('#personal-view')).to_be_visible()
        expect(page.locator('#personal-title')).to_be_focused()
        page.get_by_role('tab', name='My searches', exact=True).click()
        page.locator('#attention-list').get_by_role('button', name='Review email failure', exact=True).click()
        expect(page.locator('#search-detail-dialog')).to_be_visible()
        expect(page.locator('.search-activity')).to_have_attribute('open', '')
        page.locator('#close-search-detail').click()
        card = page.locator('.search-card').filter(has_text='Test apartments')
        card.locator('.view-search-results').click()
        expect(page.locator('#search-detail-body')).to_contain_text('Studio with balcony')
        page.screenshot(path=str(ARTIFACTS / 'workspace-results-1280.png'))
        page.keyboard.press('Escape')
        expect(card.locator('.view-search-results')).to_be_focused()
        card.locator('.view-search-results').click()
        page.locator('#search-detail-body').get_by_role('button', name='Apply ↗', exact=True).click()
        expect(page.locator('#apply-confirmation')).to_be_visible()
        page.locator('#cancel-apply').click()
        if page.locator('#attention-panel').is_visible():
            page.locator('#close-attention').click()
        for width in [320, 360, 1280]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.locator('.app-tabs').evaluate("node => [...node.querySelectorAll('button')].every(button => button.scrollWidth <= button.clientWidth + 1)"), f'Navigation labels clipped at {width}px'
            for tab in ['My searches', 'Websites', 'Applicants', 'Settings', 'Clients']:
                page.get_by_role('tab', name=tab, exact=True).click()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, tab, page.evaluate("[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && e.getBoundingClientRect().width>0).slice(0,12).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right])"))
                if tab == 'Websites':
                    group = page.locator('.building-check-actions')
                    monitoring = group.locator('#monitor-selected-buildings').bounding_box()
                    check = group.locator('#check-all-buildings').bounding_box()
                    assert abs(monitoring['y'] - check['y']) < 2, (width, monitoring, check)
                    assert 0 < check['x'] - monitoring['x'] - monitoring['width'] < 12, (width, monitoring, check)
                    expect(page.locator('.building-control-panel')).not_to_contain_text('profile search')
                    expect(page.locator('.building-control-panel h3')).to_have_count(1)
                    status = page.locator('.building-control-panel .result-status').bounding_box()
                    checked = page.locator('.building-control-panel .freshness').bounding_box()
                    assert abs(status['y'] - checked['y']) < 1, (width, status, checked)
                    assert abs(status['height'] - checked['height']) < 1, (width, status, checked)
                page.evaluate("()=>{window.scrollTo(0,0);document.querySelector('#toast').hidden=true;}")
                page.screenshot(path=str(ARTIFACTS / f'workspace-{tab.lower()}-{width}.png'), full_page=True)
            page.get_by_role('tab', name='Websites', exact=True).click()
            if width < 720:
                expect(page.locator('#location-picker')).to_be_visible()
                expect(page.locator('.watchlist')).not_to_be_visible()
                page.locator('#location-picker').select_option(index=2)
                expect(page.locator('.building-control-heading')).to_contain_text('Canvas')
                page.locator('#location-picker').select_option(index=0)
            expect(page.locator('.sample .listing-rent')).to_contain_text('€1,250')
            expect(page.locator('.sample').get_by_role('link', name='View apartment ↗')).to_be_visible()
        page.get_by_role('tab', name='Settings', exact=True).click()
        page.locator('#advanced-settings summary').first.click()
        expect(page.locator('#extension-version')).to_be_visible()
        expect(page.locator('#export')).to_be_visible()
        expect(page.locator('.profile-folder')).to_be_visible()
        page.screenshot(path=str(ARTIFACTS / 'workspace-advanced-1280.png'), full_page=True)
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.get_by_role('tab', name='Applicants', exact=True).click()
        page.locator('#saved-profile').select_option('spotalert-test-profile-1')
        page.evaluate("()=>{document.querySelectorAll('.profile-group').forEach((group,index)=>group.open=index===0);document.querySelector('.profile-tools').open=false;document.querySelector('#toast').hidden=true;window.scrollTo(0,0);}")
        page.screenshot(path=str(ARTIFACTS / 'clean-profiles-desktop.png'))
        page.get_by_role('tab', name='My searches', exact=True).click()
        page.screenshot(path=str(ARTIFACTS / 'clean-searches-desktop.png'))
        page.get_by_role('tab', name='Websites', exact=True).click()
        page.screenshot(path=str(ARTIFACTS / 'clean-locations-desktop.png'))
        page.set_viewport_size({'width': 320, 'height': 900})
        page.get_by_role('tab', name='Applicants', exact=True).click()
        page.screenshot(path=str(ARTIFACTS / 'clean-profiles-mobile.png'))
        page.get_by_role('tab', name='Websites', exact=True).click()
        page.screenshot(path=str(ARTIFACTS / 'clean-locations-mobile.png'))
        page.get_by_role('tab', name='Websites', exact=True).click()
        page.evaluate("""async () => {
          const key='spotalert.monitors.v2'; const state=(await chrome.storage.local.get(key))[key];
          state.monitors[0].enabled=true;state.monitors[0].searchManaged=true;state.monitors[0].phase='reading';
          await chrome.storage.local.set({[key]:state});
        }""")
        page.locator('#location-picker').select_option(index=0)
        expect(page.get_by_role('button', name='Start monitoring', exact=True)).to_be_visible()
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.locator('#monitors input').nth(1).uncheck()
        page.locator('#monitors input').nth(2).uncheck()
        expect(page.locator('#detail').get_by_role('button', name='Check now', exact=True)).to_have_count(0)
        page.get_by_role('button', name='Start monitoring', exact=True).click()
        expect(page.get_by_role('button', name='Stop monitoring', exact=True)).to_be_visible()
        page.get_by_role('button', name='Stop monitoring', exact=True).click()
        expect(page.get_by_role('button', name='Start monitoring', exact=True)).to_be_visible()
        expect(page.locator('.building-control-panel')).not_to_contain_text('profile search')
        assert page.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].searches.some(search=>search.enabled)")
        page.evaluate("()=>chrome.runtime.sendMessage({type:'cancel-check',id:'ourdomain-amsterdam-diemen'})")
        expect(page.get_by_role('button', name='Check now', exact=True)).to_be_enabled()
        page.locator('.monitor-card').nth(1).click()
        expect(page.get_by_role('button', name='Retry check', exact=True)).to_be_visible()
        expect(page.locator('#detail')).to_contain_text('Availability could not be confirmed')
        expect(page.locator('#detail')).to_contain_text('complete verification')
        page.get_by_role('tab', name='Settings', exact=True).click()
        page.locator('#advanced-settings').evaluate('node => node.open = true')
        page.evaluate("window.dispatchEvent(new ErrorEvent('error', {message:'Diagnostic test token=private-token user@example.com'}))")
        expect(page.locator('#toast')).to_have_attribute('role', 'alert')
        expect(page.locator('#toast').get_by_role('button', name='Copy diagnostics')).to_be_visible()
        page.locator('#toast').get_by_role('button', name='Dismiss').click()
        expect(page.locator('#toast')).to_be_hidden()
        with page.expect_download() as downloaded:
            page.locator('#download-diagnostics').click()
        report = json.loads(Path(downloaded.value.path()).read_text())
        assert report['build'] and report['version']
        assert len(report['locations']) == 3
        assert any(error['operation'] == 'dashboard-script' for error in report['recentErrors'])
        assert 'private-token' not in json.dumps(report)
        assert 'user@example.com' not in json.dumps(report)
        page.evaluate("()=>{chrome.runtime.reload=()=>{globalThis.extensionReloadRequested=true;};}")
        expect(page.locator('#reload-extension')).to_be_visible()
        page.locator('#reload-extension').click()
        assert page.evaluate('globalThis.extensionReloadRequested')
        expect(page.locator('#reload-extension')).to_be_disabled()
        assert not errors, errors
        print('Workspace UI passed: navigation, compact cards, recovery actions, missing-field focus, conditional fields, test badges, sticky save, and 320/360/1280px layouts.')


if __name__ == '__main__':
    main()
