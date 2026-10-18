"""Exercise profile search authoring in isolated Chromium without housing or email calls."""
from pathlib import Path

from browser_helpers import isolated_extension
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with isolated_extension() as (context, worker):
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        context.route('https://**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<title>Floor plans</title><div id="FP_Detail_101"><h2 data-selenium-id="FloorPlanName">Fixture Studio</h2><table><tr><td data-selenium-id="Availability_101">Get Notified</td></tr></table></div>'))
        listing = context.new_page()
        listing.goto('https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx')
        page.goto(worker.url.replace('background.js', 'panel.html'))
        expect(page.locator('#extension-version')).to_contain_text('SpotAlert')
        page.get_by_role('tab', name='Settings', exact=True).click()
        expect(page.locator('#email-delivery-title')).to_have_text('Email delivery')
        expect(page.locator('#notification-email')).to_have_count(0)
        expect(page.get_by_role('tab', name='Notifications', exact=True)).to_have_count(0)
        page.set_viewport_size({'width': 360, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Settings overflow the panel'
        page.set_viewport_size({'width': 1280, 'height': 1000})
        page.evaluate('''async () => {
          const send = async message => {
            const result = await chrome.runtime.sendMessage(message);
            if (!result.ok) throw new Error(result.error);
          };
          await send({type:'save-profile',name:'Alex',profile:{firstName:'Alex',lastName:'Example',email:'alex@example.com',phone:'+31612345678',maxRent:'1400',minSize:'30',preferredApartmentType:'studio',moveInFrom:'2026-11-02'}});
          await chrome.storage.local.set({'spotalert.resend.v1':{apiKey:'test-only',enabled:false}});
        }''')
        page.get_by_role('tab', name='My searches', exact=True).click()
        expect(page.locator('.search-card')).to_have_count(0)
        expect(page.locator('#search-profile-filter')).to_be_enabled()
        page.locator('#search-profile-filter').select_option('default')
        page.locator('#new-search').click()
        expect(page.locator('#search-profile-preferences')).to_contain_text('1400')
        expect(page.locator('#search-profile-preferences')).to_contain_text('30 m²')
        expect(page.locator('#search-max-rent')).to_have_count(0)
        expect(page.locator('#search-recipient')).to_contain_text('alex@example.com')
        page.locator('#search-name').fill('Alex Amsterdam')
        page.locator('#search-form').get_by_role('button', name='Save search', exact=True).click()
        expect(page.locator('#search-error')).to_be_visible()
        expect(page.locator('#search-error')).to_contain_text('Choose at least one supported location')
        expect(page.locator('#search-name')).to_have_value('Alex Amsterdam')
        page.locator('input[name="search-location"]').first.check()
        expect(page.locator('#search-account-options')).not_to_be_visible()
        page.locator('#search-auto-apply').check()
        page.locator('.search-advanced > summary').click()
        expect(page.locator('#search-account-options')).to_be_visible()
        page.set_viewport_size({'width': 360, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.locator('#search-editor').evaluate('(node)=>node.scrollWidth <= node.clientWidth')
        ROOT.joinpath('artifacts/extension').mkdir(parents=True, exist_ok=True)
        page.locator('#search-editor').evaluate('(node)=>node.scrollTop=0')
        page.screenshot(path=str(ROOT / 'artifacts/extension/search-editor.png'), full_page=True)
        page.set_viewport_size({'width': 1280, 'height': 1000})
        page.locator('#search-form').get_by_role('button', name='Save search', exact=True).click()
        expect(page.locator('#search-editor')).not_to_be_visible()
        card = page.locator('.search-card')
        expect(card).to_contain_text('Alex Amsterdam')
        expect(card).to_contain_text('Auto-apply')
        expect(card).to_contain_text('Email')
        expect(card).not_to_contain_text('alex@example.com')
        expect(card).to_contain_text('Paused')
        expect(card).to_contain_text('30 m²')
        if not card.locator(".search-more").evaluate("node=>node.open"):
            card.locator(".search-more > summary").click()
        card.get_by_role('button', name='Edit search', exact=True).click()
        expect(page.locator('#search-profile-preferences')).to_contain_text('30 m²')
        page.locator('#search-email').uncheck()
        page.locator('#search-form').get_by_role('button', name='Save search', exact=True).click()
        expect(card).to_contain_text('Auto-apply')
        expect(card).not_to_contain_text('Email:')
        page.get_by_role('tab', name='Applicants', exact=True).click()
        page.locator('.profile-group').filter(has=page.locator('#personal-minSize')).locator('summary').click()
        page.locator('#personal-minSize').fill('32')
        page.locator('#personal-form').get_by_role('button', name='Save profile', exact=True).click()
        page.get_by_role('tab', name='My searches', exact=True).click()
        expect(card).to_contain_text('32 m²')
        page.reload()
        page.get_by_role('tab', name='My searches', exact=True).click()
        expect(card).to_contain_text('Alex Amsterdam')
        card.get_by_role('button', name='Start search', exact=True).click()
        expect(page.locator('#start-search-dialog')).to_be_visible()
        expect(card).to_contain_text('Paused')
        expect(page.locator('#start-auto-apply')).to_be_checked()
        expect(page.locator('#start-email')).not_to_be_checked()
        expect(page.locator('#start-sms')).to_be_disabled()
        expect(page.locator('#start-auto-apply').locator('..').locator('.state-on')).to_be_visible()
        expect(page.locator('#start-email').locator('..').locator('.state-off')).to_be_visible()
        page.locator('#start-auto-apply').uncheck()
        expect(page.locator('#confirm-start-search')).to_be_disabled()
        expect(page.locator('#start-search-readiness')).to_contain_text('Turn on at least one action')
        page.locator('#start-email').check()
        expect(page.locator('#confirm-start-search')).to_be_enabled()
        page.set_viewport_size({'width': 360, 'height': 1000})
        assert page.locator('#start-search-dialog').evaluate('(node)=>node.scrollWidth <= node.clientWidth')
        page.screenshot(path=str(ROOT / 'artifacts/extension/start-search-toggles.png'), full_page=True)
        page.locator('#confirm-start-search').click()
        expect(page.locator('#start-search-dialog')).not_to_be_visible()
        page.wait_for_function("""async () => {
          const state=(await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'];
          return state.monitors[0].checks > 0 && !state.monitors[0].error;
        }""")
        expect(card).to_contain_text('Active')
        card.locator('.search-more > summary').click()
        card.get_by_role('button', name='Pause search', exact=True).click()
        expect(card).to_contain_text('Paused')
        page.set_viewport_size({'width': 360, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Searches overflow the panel'
        ROOT.joinpath('artifacts/extension').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(ROOT / 'artifacts/extension/profile-searches.png'), full_page=True)
        page.evaluate("""async () => {
          const send = async message => {
            const result = await chrome.runtime.sendMessage(message);
            if (!result.ok) throw new Error(result.error);
            return result.result;
          };
          await send({type:'create-profile'});
          await send({type:'save-profile',name:'Bea',profile:{firstName:'Bea',email:'bea@example.com',maxRent:'1600'}});
          const library=await send({type:'profiles'});
          const key='spotalert.monitors.v2';
          let state=(await chrome.storage.local.get(key))[key];
          const location=state.monitors[0].id;
          await send({type:'save-search',search:{name:'Bea Rotterdam',profileId:library.activeId,locationIds:[location],actions:{email:true}}});
          await send({type:'set-search-enabled',id:state.searches[0].id,enabled:true});
          // Isolate seeded match results from the real background page reader.
          await send({type:'cancel-check',id:location});
          state=(await chrome.storage.local.get(key))[key];
          state.monitors[0].error=null; state.monitors[0].errorKind=null; state.monitors[0].lastCheckedAt=Date.now();
          const claimKey=JSON.stringify([state.searches[0].profileId,location,'studio','email']);
          state.searchClaims[claimKey]={id:'prior-email',searchId:'deleted-search',status:'sent',at:Date.now()-3600000,listingName:'Studio with balcony',message:'Accepted by provider for alex@example.com.'};
          state.searches[0].results[location]={at:Date.now(),matches:[{id:'studio',name:'Studio with balcony',text:'Apply Now',beds:'Studio',matched:true,rent:'€1,250',size:'32 m²',pageUrl:state.monitors[0].url},{id:'expensive',name:'Large expensive apartment',text:'Apply Now',rent:'1550',size:'23 m²',beds:'Studio',matched:false,ruleMatched:true,included:false,preferenceReasons:['€150 over budget (€1,400 maximum)','7 m² below minimum (30 m² required)']},{id:'unavailable',name:'Unavailable studio',text:'Get Notified',matched:false,ruleMatched:false}]};
          await chrome.storage.local.set({[key]:state});
        }""")
        expect(page.locator('.search-card')).to_have_count(2)
        alex = page.locator('.search-card').filter(has_text='Alex Amsterdam')
        alex.locator('.view-search-results').click()
        detail = page.locator('#search-detail-body')
        expect(detail).to_contain_text('Studio with balcony')
        detail.locator('.search-exclusions summary').click()
        expect(detail.locator('.search-exclusions')).to_contain_text('€150 over budget')
        expect(detail.locator('.search-exclusions')).to_contain_text('Not currently available')
        detail.locator('.search-duplicates summary').click()
        expect(detail.locator('.search-duplicates')).to_contain_text('Accepted by email provider')
        detail.get_by_role('button', name='Authorize another email', exact=True).click()
        expect(page.locator('#repeat-search-dialog')).to_be_visible()
        expect(page.locator('#repeat-search-details')).to_contain_text('Studio with balcony')
        expect(page.locator('#repeat-search-consent')).not_to_be_checked()
        page.locator('#cancel-repeat-search').click()
        expect(page.locator('#repeat-search-dialog')).not_to_be_visible()
        worker.evaluate("""() => {
          globalThis.testSentEmails=[];
          globalThis.fetch=async (url,options) => {
            if(url!=='https://api.resend.com/emails') throw new Error('Unexpected fixture request');
            globalThis.testSentEmails.push(JSON.parse(options.body));
            return new Response(JSON.stringify({id:'isolated-test-email'}),{status:200,headers:{'Content-Type':'application/json'}});
          };
        }""")
        detail.get_by_role('button', name='Authorize another email', exact=True).click()
        page.locator('#confirm-repeat-search').click()
        expect(page.locator('#repeat-search-dialog')).to_be_visible()
        assert worker.evaluate('globalThis.testSentEmails.length') == 0
        page.locator('#repeat-search-consent').check()
        page.locator('#confirm-repeat-search').click()
        expect(page.locator('#repeat-search-dialog')).not_to_be_visible()
        expect(detail.locator('.search-duplicates')).to_contain_text('Accepted by email provider')
        expect(detail.locator('.search-duplicates')).to_contain_text('Earlier attempts (1)')
        assert worker.evaluate('globalThis.testSentEmails.length') == 1
        assert worker.evaluate('globalThis.testSentEmails[0].to[0]') == 'alex@example.com'
        page.locator('#close-search-detail').click()
        page.set_viewport_size({'width': 1280, 'height': 1000})
        page.screenshot(path=str(ROOT / 'artifacts/extension/profile-searches-desktop.png'), full_page=True)
        bea_id = page.locator('#search-profile-filter option', has_text='Bea').get_attribute('value')
        page.locator('#search-profile-filter').select_option(bea_id)
        expect(page.locator('.search-card')).to_have_count(1)
        expect(page.locator('.search-card')).to_contain_text('Bea Rotterdam')
        page.locator('#new-search').click()
        expect(page.locator('#search-profile')).to_have_value(bea_id)
        page.locator('#search-profile').select_option('default')
        expect(page.locator('#search-recipient')).to_contain_text('alex@example.com')
        expect(page.locator('#search-profile-preferences')).to_contain_text('1400')
        page.locator('#search-profile').select_option(bea_id)
        expect(page.locator('#search-recipient')).to_contain_text('bea@example.com')
        page.keyboard.press('Escape')
        expect(page.locator('#search-editor')).not_to_be_visible()
        expect(page.locator('#new-search')).to_be_focused()
        page.locator('#search-profile-filter').select_option('')
        expect(page.locator('.search-card')).to_have_count(2)
        page.locator('.search-card').filter(has_text='Bea Rotterdam').locator('.search-more summary').click()
        page.locator('.search-card').filter(has_text='Bea Rotterdam').get_by_role('button', name='Delete search', exact=True).click()
        expect(page.locator('.search-card')).to_have_count(1)
        card.locator('.search-more summary').click()
        card.get_by_role('button', name='Delete search', exact=True).click()
        expect(page.locator('.search-card')).to_have_count(0)
        assert not errors, errors
        print('Profile searches browser checks passed')


if __name__ == '__main__':
    main()
