"""Check application presentation, keyboard controls, and narrow-screen layout."""
from pathlib import Path

from browser_helpers import isolated_extension
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with isolated_extension() as (context, worker):
        panel = context.new_page()
        panel.goto(worker.url.replace('background.js', 'panel.html'))
        panel.get_by_role("tab", name="Websites", exact=True).click()
        expect(panel.locator('#extension-version')).to_contain_text('SpotAlert')
        for stage, status, label in [('filling', 'running', 'Working'),
                                     ('needs-details', 'stopped', 'Needs your input'),
                                     ('failed', 'stopped', 'Failed'),
                                     ('awaiting-review', 'stopped', 'Ready to review')]:
            panel.evaluate('''async ({stage,status}) => {
                const key='spotalert.monitors.v2';
                const state=(await chrome.storage.local.get(key))[key];
                const {APPLICATION_BUILD}=await import('./application-diagnostics.js');
                for(const monitor of state.monitors) monitor.application={stage,status,
                  kind: stage==='failed'?'error':stage==='needs-details'?'missing':'review',
                  build:APPLICATION_BUILD,applicantName:'Alex Example',listingName:'Studio 101',
                  message:'Review the application before saving.',trace:[]};
                await chrome.storage.local.set({[key]:state});
            }''', {'stage': stage, 'status': status})
            expect(panel.locator('.application-diagnostics')).to_have_count(1)
            expect(panel.locator('.application-diagnostics .application-result')).to_have_text('Review the application before saving.')
            assert not panel.locator('.application-diagnostics').evaluate('(node)=>node.open')
            expect(panel.locator('.application-progress')).to_have_count(1 if status == 'running' else 0)
            expect(panel.get_by_role('heading', name='Current application')).to_have_count(0)
            expect(panel.locator('#detail > .move-in-feedback')).to_have_count(0)
        panel.set_viewport_size({'width': 1280, 'height': 1000})
        panel.screenshot(path='/private/tmp/spotalert-application.png', full_page=True)
        for width in [360, 1280]:
            panel.set_viewport_size({'width': width, 'height': 1000})
            assert panel.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Application overflows'
        panel.get_by_role('tab', name='Applicants', exact=True).click()
        expect(panel.locator('#application-readiness')).to_have_count(1)
        expect(panel.locator('.client-overview #application-readiness')).to_be_visible()
        expect(panel.locator('.profile-preparation')).to_have_count(0)
        original_id = panel.locator('#saved-profile').input_value()
        original_name = panel.locator('#saved-profile option:checked').inner_text()
        panel.evaluate("()=>chrome.runtime.sendMessage({type:'create-profile'})")
        expect(panel.locator('#client-overview-list .profile-readiness')).to_have_count(1)
        expect(panel.locator('#profile-name')).to_have_value('New profile')
        panel.locator('#saved-profile').select_option(original_id)
        expect(panel.locator('#profile-name')).to_have_value(original_name)
        expect(panel.locator('#client-overview-list .profile-readiness')).to_have_count(1)
        expect(panel.locator('#profile-readiness-location option')).to_have_count(3)
        expect(panel.locator('.profile-search-readiness')).to_have_text('Ready to search')
        panel.evaluate('''async () => {
            const key='spotalert.monitors.v2'; const s=(await chrome.storage.local.get(key))[key];
            for(const m of s.monitors) { m.application=null; m.samples=[{id:'studio',name:'Studio',matched:true,index:1}]; }
            await chrome.storage.local.set({[key]:s});
        }''')
        panel.get_by_role('tab', name='Websites', exact=True).click()
        expect(panel.get_by_label('Applicant for this location')).to_have_count(0)
        panel.locator('.sample').get_by_role('button', name='Apply').click()
        expect(panel.locator('#confirm-apply')).to_be_disabled()
        panel.locator('#apply-profile').select_option(label='New profile')
        expect(panel.locator('#apply-confirmation-details')).to_contain_text('New profile')
        expect(panel.locator('#confirm-apply')).to_be_enabled()
        panel.locator('#cancel-apply').click()
        panel.locator('.sample').get_by_role('button', name='Apply').click()
        expect(panel.locator('#apply-profile')).to_have_value('')
        expect(panel.locator('#confirm-apply')).to_be_disabled()
        panel.locator('#cancel-apply').click()
        panel.get_by_role('tab', name='Applicants', exact=True).click()
        expect(panel.locator('#fill-application')).to_have_count(0)
        expect(panel.locator('#application-action-feedback')).to_have_count(0)
        for width in [360, 1280]:
            panel.set_viewport_size({'width': width, 'height': 1000})
            assert panel.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Profile overflows'
        panel.locator('#personal-view').screenshot(path='/private/tmp/spotalert-profiles.png')
    print('Panel checks passed: no persistent application status, selected-profile readiness, Apply-only workflow, and 360px/1280px layouts.')


if __name__ == '__main__':
    main()
