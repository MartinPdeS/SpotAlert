"""Verify background parsing and tab fallback without contacting housing websites."""
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
            worker.evaluate(r"""() => {
              chrome.runtime.sendNativeMessage=async()=>{throw new Error('Isolated test');};
              globalThis.fixtureMode='complete'; globalThis.directCalls=0;
              globalThis.fixtureHtml=(name='Background studio',text='Apply Now')=>`<title>Floor plans</title><div id="FP_Detail_101"><h2 data-selenium-id="FloorPlanName">${name}</h2><table><tr><td data-selenium-id="Rent_101">€1,250</td><td data-selenium-id="Beds_101">Studio</td><td data-selenium-id="Sqft_101">32 m²</td><td data-selenium-id="Availability_101">${text}</td></tr></table></div>`;
              globalThis.fetch=async (url,options)=>{
                globalThis.directCalls++;
                if(globalThis.fixtureMode==='pending') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));
                const mode=globalThis.fixtureMode;
                let html=mode==='verification'?'<title>Just a moment</title><div id="challenge-running">Verify</div>': mode==='partial'?'<title>Floor plans</title><div id="app"></div>':globalThis.fixtureHtml('Background studio',mode==='unavailable'?'Get Notified':'Apply Now');
                if(url.includes('southeast-')) html=html.replace(/<td data-selenium-id="Availability_101">([^<]+)<\/td>/,'<td data-selenium-id="Apply_101"><a data-selenium-id="ApplyNow">$1</a></td>');
                if(url.includes('canvas-world')) html=html.replace('Apply Now','Check availability');
                const response=new Response(html,{status:mode==='blocked'?403:200,headers:{'Content-Type':'text/html'}});
                Object.defineProperty(response,'url',{value:url});return response;
              };
            }""")
            fixture = {'verification': False}

            def portal(route):
                html = '<title>Just a moment</title><div id="challenge-running">Verify</div>' if fixture['verification'] else '<title>Floor plans</title><div id="FP_Detail_101"><h2 data-selenium-id="FloorPlanName">Browser studio</h2><table><tr><td data-selenium-id="Rent_101">€1,250</td><td data-selenium-id="Beds_101">Studio</td><td data-selenium-id="Sqft_101">32 m²</td><td data-selenium-id="Availability_101">Apply Now</td></tr></table></div>'
                route.fulfill(content_type='text/html', body=html)

            context.route('https://**/*', portal)
            panel = context.new_page()
            errors = []
            panel.on('pageerror', lambda error: errors.append(str(error)))
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role('tab', name='Locations', exact=True).click()
            expect(panel.locator('#monitor-count')).to_have_text('3')

            def command(kind):
                return panel.evaluate("""async type=>{
                  const response=await chrome.runtime.sendMessage({type,id:'ourdomain-amsterdam-diemen'});
                  if(!response.ok) throw new Error(response.error);return response.result;
                }""", kind)

            def monitor():
                return panel.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors[0]")

            def reset(mode):
                worker.evaluate('(mode)=>{globalThis.fixtureMode=mode;}', mode)
                panel.evaluate("""async()=>{const key='spotalert.monitors.v2';const s=(await chrome.storage.local.get(key))[key];s.monitors[0].backgroundRetryAt=null;await chrome.storage.local.set({[key]:s});}""")

            command('check')
            first = monitor()
            assert first['readMethod'] == 'background', first
            assert first['available'] is True
            assert first['samples'][0]['name'] == 'Background studio'
            assert first['samples'][0]['id'] == 'floorplan:101'
            assert not [page for page in context.pages if page.url.startswith('https://')]
            expect(panel.locator('.read-method')).to_have_text('Background check')
            worker.evaluate("()=>{globalThis.fixtureMode='unavailable';}")
            command('check')
            assert monitor()['available'] is False, 'Background checks must replace earlier availability'
            assert worker.evaluate('globalThis.directCalls') == 2
            assert not [page for page in context.pages if page.url.startswith('https://')]

            worker.evaluate("()=>{globalThis.fixtureMode='complete';}")
            panel.locator('#check-all-buildings').click()
            expect(panel.locator('#building-check-progress')).to_contain_text('Finished · 3 of 3 checked')
            state = panel.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2']")
            assert all(item['checks'] > 0 and not item['enabled'] for item in state['monitors'])
            assert not [page for page in context.pages if page.url.startswith('https://')]
            before = [item['checks'] for item in state['monitors']]
            southeast = panel.locator('[data-check-picker="desktop"][data-check-building-id="ourdomain-amsterdam-south-east"]')
            southeast.uncheck()
            expect(panel.locator('#building-selection-count')).to_have_text('2 buildings selected')
            assert panel.locator('#location-picker').input_value() == 'ourdomain-amsterdam-diemen'
            panel.locator('.monitor-card').nth(2).click()
            expect(southeast).not_to_be_checked()
            panel.locator('#check-all-buildings').click()
            expect(panel.locator('#building-check-progress')).to_contain_text('Finished · 2 of 2 checked')
            after = panel.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.map(item=>item.checks)")
            assert [end-start for start, end in zip(before, after)] == [1, 0, 1]
            panel.locator('#monitor-selected-buildings').click()
            expect(panel.locator('#monitor-selected-buildings')).to_have_text('Stop monitoring')
            enabled = panel.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.map(item=>item.enabled)")
            assert enabled == [True, False, True]
            panel.locator('#monitor-selected-buildings').click()
            expect(panel.locator('#monitor-selected-buildings')).to_have_text('Start monitoring')
            enabled = panel.evaluate("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors.map(item=>item.enabled)")
            assert enabled == [False, False, False]
            expect(panel.get_by_role('button', name='Check now', exact=True)).to_have_count(1)
            panel.reload()
            panel.get_by_role('tab', name='Locations', exact=True).click()
            expect(southeast).not_to_be_checked()
            expect(panel.locator('#building-selection-count')).to_have_text('2 buildings selected')
            panel.set_viewport_size({'width': 360, 'height': 900})
            panel.locator('#mobile-check-selection > summary').click()
            mobile = panel.locator('[data-check-picker="mobile"][data-check-building-id="ourdomain-amsterdam-south-east"]')
            expect(mobile).not_to_be_checked()
            mobile.check()
            expect(panel.locator('#building-selection-count')).to_have_text('3 buildings selected')
            panel.set_viewport_size({'width': 1280, 'height': 900})
            expect(southeast).to_be_checked()
            checkboxes = panel.locator('#monitors input[type="checkbox"]')
            for index in range(3):
                checkboxes.nth(index).uncheck()
            expect(panel.locator('#check-all-buildings')).to_be_disabled()
            expect(panel.locator('#detail').get_by_role('button', name='Check now', exact=True)).to_have_count(0)
            for index in range(3):
                checkboxes.nth(index).check()
            panel.locator('.monitor-card').first.click()
            expect(panel.locator('.application-diagnostics > summary')).to_have_text('Application activity')
            panel.locator('.application-diagnostics > summary').click()
            expect(panel.locator('.application-diagnostics')).to_contain_text('No application attempt recorded')
            worker.evaluate("()=>{globalThis.fixtureMode='pending';}")
            panel.locator('#check-all-buildings').click()
            expect(panel.locator('#check-all-buildings')).to_be_disabled()
            panel.locator('#cancel-all-checks').click()
            expect(panel.locator('#building-check-progress')).to_contain_text('Cancelled')
            worker.evaluate("()=>{globalThis.fixtureMode='complete';}")

            # Parser rejects incomplete, conflicting, and challenge pages; remote scripts stay inert.
            cases = panel.evaluate("""async()=>{
              const {parseListingHtml}=await import('./listing-parser.js');const {SUPPORTED_SITES}=await import('./sites/index.js');
              const site=SUPPORTED_SITES[0];const parse=html=>parseListingHtml(html,site.url,site.rule,site.reader);
              const row=(id,text)=>`<div id="FP_Detail_${id}"><h2 data-selenium-id="FloorPlanName">Studio</h2><table><tr><td data-selenium-id="Availability_${id}">${text}</td></tr></table></div>`;
              const valid=parse(row(101,'Apply Now')+'<script>globalThis.remoteScriptRan=true;</script><img src="https://never-request.example/image">');
              return {valid,remoteScriptRan:!!globalThis.remoteScriptRan,partial:parse(row(101,'Apply Now')+'<div id="FP_Detail_102"><h2>Missing action</h2></div>'),conflict:parse(row(101,'Apply Now')+row(101,'Get Notified')),challenge:parse('<title>Just a moment</title>'),login:parse('<title>Portal</title><input type=password><p>Sign in to continue</p>'),unknown:parse(row(101,'Loading…'))};
            }""")
            assert cases['valid']['result']['samples'] and not cases['remoteScriptRan']
            assert all(cases[key].get('fallback') for key in ['partial', 'conflict', 'challenge', 'login', 'unknown'])
            browser_tab = context.new_page()
            browser_tab.goto(first['url'])
            parity = panel.evaluate("""async()=>{
              const {parseListingHtml}=await import('./listing-parser.js');const {readPage}=await import('./page.js');
              const {SUPPORTED_SITES}=await import('./sites/index.js');const results=[];
              for(const site of SUPPORTED_SITES){
                const action=site.id.includes('south-east')?'<td data-selenium-id="Apply_101"><a data-selenium-id="ApplyNow">Apply Now</a></td>':`<td data-selenium-id="Availability_101">${site.id.includes('canvas')?'Check availability':'Apply Now'}</td>`;
                const html=`<div id="FP_Detail_101"><h2 data-selenium-id="FloorPlanName">Studio 101</h2><table><tr><td data-selenium-id="Rent_101">€1,250</td><td data-selenium-id="Beds_101">Studio</td><td data-selenium-id="Sqft_101">32 m²</td>${action}</tr></table></div>`;
                const iframe=document.createElement('iframe');iframe.srcdoc=html;
                await new Promise(resolve=>{iframe.onload=resolve;document.body.append(iframe);});
                const browser=readPage(site.rule,0,site.reader,iframe.contentDocument,site.url);
                const background=parseListingHtml(html,site.url,site.rule,site.reader);
                results.push({site:site.id,browser:browser.samples,background:background.result?.samples});iframe.remove();
              }return results;
            }""")
            for result in parity:
                assert result['browser'] == result['background'], result
            reset('partial')
            command('check')
            fallback = monitor()
            assert fallback['readMethod'] == 'browser' and fallback['available'] is True, fallback
            assert fallback['samples'][0]['name'] == 'Browser studio'
            assert 'Direct HTML' in fallback['readFallbackReason']
            assert len([page for page in context.pages if page.url.startswith('https://')]) == 1
            calls = worker.evaluate('globalThis.directCalls')
            command('check')
            assert worker.evaluate('globalThis.directCalls') == calls, 'Cooldown avoids repeated failed direct requests'
            assert monitor()['readMethod'] == 'browser'

            reset('complete')
            command('check')
            assert monitor()['readMethod'] == 'background'
            assert monitor()['backgroundRetryAt'] is None and monitor()['readFallbackReason'] is None
            reset('blocked')
            command('check')
            assert 'HTTP 403' in monitor()['readFallbackReason']
            assert monitor()['error'] is None
            reset('verification')
            fixture['verification'] = True
            command('check')
            failed = monitor()
            assert failed['errorKind'] == 'verification', failed
            assert failed['samples'] == fallback['samples'], 'Failed fallback must retain successful data'
            reset('pending')
            panel.evaluate("""()=>{globalThis.pendingCheck=chrome.runtime.sendMessage({type:'check',id:'ourdomain-amsterdam-diemen'});}""")
            panel.wait_for_function("async()=> (await chrome.storage.local.get('spotalert.monitors.v2'))['spotalert.monitors.v2'].monitors[0].readMethod==='background'")
            command('cancel-check')
            panel.evaluate('()=>globalThis.pendingCheck')
            assert monitor()['phase'] == 'paused'
            assert not errors, errors
            print('Hybrid browser checks passed: tab-free reads, parsing, updated results, fallback, cooldown, verification, and cancellation.')
        finally:
            context.close()


if __name__ == '__main__':
    main()
