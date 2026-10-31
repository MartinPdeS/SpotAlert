"""Check changed-form stops through the real extension runner on isolated pages."""
from browser_helpers import isolated_extension
from playwright.sync_api import expect


def main():
    with isolated_extension() as (context, worker):
        panel = context.new_page()
        panel.goto(worker.url.replace('background.js', 'panel.html'))
        expect(panel.locator('#monitor-count')).to_have_text('3')
        site = panel.evaluate("async()=>{const {SUPPORTED_SITES}=await import('./sites/index.js');return SUPPORTED_SITES[0];}")
        destination_url = site['url'].replace('floorplans.aspx', 'oleapplication.aspx?stepname=intapplicantinfo')
        profile = {'firstName': 'Alex', 'lastName': 'Example'}
        panel.evaluate("async profile=>chrome.runtime.sendMessage({type:'save-profile',profile})", profile)
        panel.evaluate("""async ({id,url})=>{
          const key='spotalert.monitors.v2';
          const state=(await chrome.storage.local.get(key))[key];
          state.monitors.find(item=>item.id===id).samples=[{
            id:'fixture',name:'Synthetic apartment',matched:true,applicationUrl:url
          }];
          await chrome.storage.local.set({[key]:state});
        }""", {'id': site['id'], 'url': destination_url})
        fixtures = {
            'missing-expected-fields': '<input id="renamedFirstName" required><input id="ProspectLastName" required><button>Next</button>',
            'missing-next-action': '<input id="ProspectFirstName" required><input id="ProspectLastName" required><button>Proceed with application</button>',
            'ambiguous-next-action': '<input id="ProspectFirstName" required><input id="ProspectLastName" required><button>Next</button><button>Continue</button>',
        }
        for reason, body in fixtures.items():
            html = body + "<script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.body.dataset.clicked='yes');</script>"
            def serve(route):
                route.fulfill(body=html, content_type='text/html')
            context.route(destination_url, serve)
            with context.expect_page() as opened:
                response = panel.evaluate("async id=>chrome.runtime.sendMessage({type:'open-listing',id,listingId:'fixture'})", site['id'])
            assert response['ok'], response
            assert response['result']['kind'] == 'unfamiliar', response
            page = opened.value
            assert page.locator('body').get_attribute('data-clicked') is None
            assert page.locator('#ProspectLastName').input_value() == '', reason
            application = panel.evaluate("async id=>(await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.find(item=>item.id===id).application", site['id'])
            assert application['filled'] == 0, application
            assert application['trace'][-1]['changeReason'] == reason, application
            assert application['structure']['fields'], application
            report = panel.evaluate("async application=>{const {applicationReport}=await import('./application-diagnostics.js');return applicationReport(application);}", application)
            assert 'Example' not in str(report)
            print(f'{reason}: stopped before autofill; no click; diagnostic reason retained')
            page.close()
        print('Website-change browser checks passed.')


if __name__ == '__main__':
    main()
