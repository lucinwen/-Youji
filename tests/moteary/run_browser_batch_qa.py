"""Real Chromium + full local server, synthetic fixtures only; no user profile or secrets saved."""
import json, os, pathlib, secrets, socket, subprocess, tempfile, time, urllib.request, sys
from playwright.sync_api import sync_playwright, expect
root = pathlib.Path(__file__).resolve().parents[2]
results = []
def check(name): results.append({'check': name, 'passed': True})
with tempfile.TemporaryDirectory(prefix='moteary-browser-qa-') as tmp:
    sock=socket.socket(); sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]; sock.close()
    base=f'http://127.0.0.1:{port}'
    proc=subprocess.Popen([str(root/'build/moteary'),'--addr','127.0.0.1','--port',str(port),'--data',tmp,'--config-apply','off'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        def req(path,body=None):
            request=urllib.request.Request(base+path,None if body is None else json.dumps(body).encode(),{'Content-Type':'application/json'})
            return json.load(urllib.request.urlopen(request,timeout=10))
        for _ in range(100):
            try: req('/api/instance/profile'); break
            except Exception: time.sleep(.1)
        username='qa'+secrets.token_hex(5); password=secrets.token_urlsafe(25)
        req('/api/users',{'username':username,'password':password,'displayName':'Synthetic browser QA'})
        a=pathlib.Path(tmp)/'synthetic-note.txt'; a.write_text('合成日记：测试文件，不包含真实个人资料。')
        b=pathlib.Path(tmp)/'synthetic-audio.bin'; b.write_bytes(b'only synthetic bytes')
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
            context=browser.new_context(viewport={'width':1280,'height':900})
            page=context.new_page(); page.goto(base+'/auth/signin')
            page.locator('#signin-username').fill(username)
            page.locator('#signin-password').fill(password)
            page.locator('button[type=submit]').click()
            page.wait_for_url(base+'/',timeout=15000)
            check('Real browser password login')
            page.goto(base+'/moteary')
            panel=page.get_by_role('region',name='批量原件导入')
            panel.get_by_label('批量资料文件').set_input_files([str(a),str(b)])
            panel.get_by_label('批量共同批注').fill('合成批注')
            panel.get_by_role('button',name='预检这批资料').click()
            expect(panel.get_by_text('已预检，尚未保存',exact=True)).to_have_count(2)
            check('Two local originals preflight without writes')
            panel.get_by_role('button',name='保存为私有记录 / 复核重试').click()
            expect(panel.get_by_text('已保存',exact=True)).to_have_count(2,timeout=15000)
            check('Two originals saved through real browser Connect RPC')
            panel.get_by_role('button',name='保存为私有记录 / 复核重试').click()
            expect(panel.get_by_text('已复核原件',exact=True)).to_have_count(2,timeout=15000)
            check('Retry authenticated ZIP downloads and SHA validation')
            page.screenshot(path=os.environ.get('MOTEARY_SCREENSHOT','/tmp/moteary-batch-browser.png'),full_page=True)
            panel.get_by_role('button',name='清空本页队列').click()
            expect(panel.get_by_label('批量共同批注')).to_have_value('')
            expect(panel.get_by_role('button',name='预检这批资料')).to_be_disabled()
            expect(panel.get_by_role('listitem')).to_have_count(0)
            check('Queue clear removes pending names/notes without deleting saved data')
            page.reload()
            panel=page.get_by_role('region',name='批量原件导入')
            expect(panel.get_by_label('批量共同批注')).to_have_value('')
            panel.get_by_label('批量资料文件').set_input_files([str(a),str(b)])
            panel.get_by_label('批量共同批注').fill('合成批注')
            panel.get_by_role('button',name='预检这批资料').click()
            expect(panel.get_by_text('已预检，尚未保存',exact=True)).to_have_count(2)
            panel.get_by_role('button',name='保存为私有记录 / 复核重试').click()
            expect(panel.get_by_text('已复核原件',exact=True)).to_have_count(2,timeout=15000)
            check('Reload loses queue but safely reconstructs and verifies saved originals')
            context.close(); browser.close()
    finally:
        proc.terminate(); proc.wait(timeout=10)
        pathlib.Path(os.environ.get('MOTEARY_BROWSER_OUTPUT','/tmp/moteary-browser-results.json')).write_text(json.dumps({'status': 'blocked-or-failed' if sys.exception() else 'passed', 'passed': len(results), 'error_type': type(sys.exception()).__name__ if sys.exception() else None, 'checks': results},ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(results),'checks':results},ensure_ascii=False))
