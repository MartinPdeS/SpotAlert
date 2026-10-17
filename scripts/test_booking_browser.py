"""Test booking recovery through the real worker with isolated synthetic pages."""
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://canvas-world.securerc.co.uk/onlineleasing/test/termsandotheritems.aspx?UnitID=1&FloorPlanID=2'
BASE = '''<form><input id="sMoveInDate" value="19-10-2026"><button type="button" id="btnStart">Start Application</button></form>
<script type="text/plain">$('#sMoveInDate').datepicker({minDate:'19-10-2026',maxDate:'30-10-2026'});var excludedDays=[0,6];</script>
<script>window.jQuery={active:0};sessionStorage.setItem('clicks','0');
function record(){sessionStorage.setItem('clicks',String(Number(sessionStorage.getItem('clicks'))+1));}
function advance(){location.href='oleapplication.aspx?stepname=IntApplicantInfo';}
SCENARIO
</script>'''


def main():
    with TemporaryDirectory(dir='/private/tmp') as profile, sync_playwright() as p:
        extension = ROOT / 'SpotAlert/chrome_extension'
        context = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
            ignore_default_args=['--disable-extensions'])
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            worker.evaluate("()=>{chrome.offscreen.createDocument=undefined;}")  # Exercise browser-reader path.
            worker.evaluate("()=>{chrome.runtime.sendNativeMessage=async()=>{throw new Error('Isolated test');};}")
            panel = context.new_page()
            panel.goto(worker.url.replace('background.js', 'panel.html'))
            panel.get_by_role("tab", name="Locations", exact=True).click()
            scenarios = [
                ('two lost clicks', "btnStart.onclick=()=>{record();if(Number(sessionStorage.getItem('clicks'))===3)advance();};", 3),
                ('slow request', "btnStart.onclick=()=>{record();jQuery.active=1;setTimeout(()=>{jQuery.active=0;advance();},19000);};", 1),
                ('replaced form', "btnStart.disabled=true;jQuery.active=1;setTimeout(()=>{const b=btnStart.cloneNode(true);btnStart.replaceWith(b);b.disabled=false;b.onclick=()=>{record();advance();};jQuery.active=0;},2500);", 1),
                ('late handler', "btnStart.addEventListener('click',record);setTimeout(()=>btnStart.addEventListener('click',advance),9000);", 2),
                ('validation failure', "window.jQuery=()=>({valid:()=>false});jQuery.fn={valid(){}};btnStart.onclick=()=>{record();advance();};", 0),
                ('visible verification', "btnStart.onclick=()=>{record();document.body.insertAdjacentHTML('beforeend','<h1>Verify you are human</h1>');};", 1),
                ('server validation', "btnStart.onclick=()=>{record();document.body.insertAdjacentHTML('beforeend','<div id=\"noticeboxdiv_termsandotheritems\"><div class=\"alert-error\">Booking unavailable</div></div>');};", 1),
            ]
            for name, script, clicks in scenarios:
                context.unroute_all()
                def portal(route):
                    body = BASE.replace('SCENARIO', script) if 'termsandotheritems.aspx' in route.request.url else '<div id="scriptSig"><input id="signatureOption2" type="radio"></div>'
                    route.fulfill(body=body, content_type='text/html')
                context.route('https://**/*', portal)
                panel.evaluate("""async url=>{
                    await chrome.runtime.sendMessage({type:'save-profile',profile:{firstName:'Alex',moveInFrom:'2026-10-19'}});
                    const key='spotalert.monitors.v2', value=(await chrome.storage.local.get(key))[key];
                    const monitor=value.monitors.find(m=>m.id==='canvas-rotterdam-blaak');
                    monitor.url=url;monitor.samples=[{id:'test',matched:true}];
                    await chrome.storage.local.set({[key]:value});
                }""", URL)
                with context.expect_page() as opened:
                    result = panel.evaluate("()=>chrome.runtime.sendMessage({type:'open-listing',id:'canvas-rotterdam-blaak',listingId:'test'})")
                assert result['ok'], (name, result)
                destination = opened.value
                assert int(destination.evaluate("sessionStorage.getItem('clicks')")) == clicks, name
                if name not in ['validation failure', 'visible verification', 'server validation']:
                    expect(destination).to_have_url(__import__('re').compile('oleapplication.aspx'))
                    report = panel.evaluate("async()=> (await chrome.runtime.sendMessage({type:'state'})).result.monitors.find(m=>m.id==='canvas-rotterdam-blaak').application")
                    assert any(event['event'] == 'booking-advanced' for event in report['trace']), report
                else:
                    expect(destination).to_have_url(__import__('re').compile('termsandotheritems.aspx'))
                destination.close()
                print(f'Passed: {name} ({clicks} clicks)', flush=True)
        finally:
            context.close()


if __name__ == '__main__':
    main()
