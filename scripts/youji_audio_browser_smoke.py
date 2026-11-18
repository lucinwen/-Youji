#!/usr/bin/env python3
"""Real Chromium/manual-transcript audio acceptance on an isolated local server.

No model or ASR is launched. All accounts and audio are synthetic. Browser sandbox
stays enabled. This script does not provide a socket/sandbox bypass or mock API.
Requires Python Playwright, Chromium and a production Youji binary.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.parse import quote, urlsplit
import urllib.request
import wave


def synthetic_wav():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\0\0' * 16000 * 4)
    return buffer.getvalue()


BLOB_OBSERVER = '''(() => {
  const live = new Set(), revoked = new Set();
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = value => { const url = create(value); live.add(url); return url; };
  URL.revokeObjectURL = url => { revoked.add(url); live.delete(url); return revoke(url); };
  window.__youjiBlobObservation = {live, revoked};
})();'''


def run(args):
    # Imports are inside run so dependency/startup failures can be reported.
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    results, diagnostics, pages = [], [], []
    passwords = [secrets.token_urlsafe(24), secrets.token_urlsafe(24)]
    sensitive = set(passwords)
    auth = {}
    calls = []
    stage = 'dependency setup'
    server = None
    success = False

    def redact(value):
        text = str(value)
        for secret in sensitive:
            text = text.replace(secret, '[REDACTED]')
        text = re.sub(r'(?i)\bBearer\s+[^\s\"\',;]+', 'Bearer [REDACTED]', text)
        text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED JWT]', text)
        return re.sub(r'(?i)((?:authorization|cookie|set-cookie|password|access_token|refresh_token)[\"\']?\s*[:=]\s*)[^\r\n]+', r'\1[REDACTED]', text)

    def passed(check, **evidence):
        results.append({'check': check, 'status': 'passed', **evidence})
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)

    def screenshot(label, page):
        try:
            page.screenshot(path=str(output / f'browser-audio-{label}.png'), full_page=True,
                            mask=[page.locator('input, textarea, [contenteditable=true]')], timeout=5000)
        except Exception as error:
            diagnostics.append({'surface': label, 'screenshot_error': redact(error)})

    try:
        from playwright.sync_api import sync_playwright, expect
        stage = 'temporary data directory'
        with tempfile.TemporaryDirectory(prefix='youji-manual-audio-browser-') as temp:
            root = Path(temp)
            stage = 'loopback listener setup'
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            env = {key: value for key, value in os.environ.items() if not key.startswith(('YOUJI_', 'MEMOS_'))}
            # Explicitly empty even if future startup code reads these names.
            env.update(YOUJI_AUDIO_PYTHON='', YOUJI_AUDIO_WORKER='', YOUJI_AUDIO_MODEL='')
            stage = 'isolated server startup'
            log_path = root / 'server.log'
            with log_path.open('w') as log:
                try:
                    server = subprocess.Popen([str(args.binary.resolve()), '--addr', '127.0.0.1', '--port', str(port),
                                               '--data', str(root / 'data'), '--config-apply', 'off'],
                                              stdout=log, stderr=log, env=env)
                    for _ in range(100):
                        if server.poll() is not None:
                            raise RuntimeError('Temporary server exited before readiness')
                        try:
                            urllib.request.urlopen(origin, timeout=1).close()
                            break
                        except OSError:
                            time.sleep(0.2)
                    else:
                        raise RuntimeError('Temporary server readiness timed out')
                    stage = 'sandboxed Chromium startup'
                    with sync_playwright() as playwright:
                        browser = None
                        try:
                            browser = playwright.chromium.launch(executable_path=args.chromium, chromium_sandbox=True)
                            stage = 'browser acceptance checks'

                            def context(label, mobile=False):
                                ctx = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 1000},
                                                          locale='en-US', is_mobile=mobile, has_touch=mobile)
                                ctx.add_init_script(BLOB_OBSERVER)
                                # Reject browser application requests outside this temporary origin.
                                # No local response is fabricated or replaced.
                                def restrict(route):
                                    target = route.request.url
                                    if target.startswith(('blob:', 'data:')) or urlsplit(target).netloc == urlsplit(origin).netloc:
                                        route.continue_()
                                    else:
                                        diagnostics.append({'surface': label, 'external_request_blocked': urlsplit(target).hostname})
                                        route.abort()
                                ctx.route('**/*', restrict)
                                page = ctx.new_page()
                                page.set_default_timeout(20000)
                                pages.append((label, page))
                                page.on('pageerror', lambda error: diagnostics.append({'surface': label, 'pageerror': redact(error)}))
                                def observe(request):
                                    if urlsplit(request.url).netloc != urlsplit(origin).netloc:
                                        return
                                    token = request.headers.get('authorization')
                                    if token:
                                        auth[label] = token
                                        sensitive.add(token)
                                        sensitive.add(token.removeprefix('Bearer '))
                                    calls.append({'surface': label, 'method': request.method, 'path': urlsplit(request.url).path})
                                page.on('request', observe)
                                return ctx, page

                            def click(locator):
                                locator.scroll_into_view_if_needed()
                                expect(locator).to_be_visible()
                                expect(locator).to_be_enabled()
                                locator.click()  # Playwright performs hit-target/actionability checks.

                            def signup(page, username, password):
                                page.goto(origin + '/auth/signup')
                                page.locator('#signup-username').fill(username)
                                page.locator('#signup-password').fill(password)
                                click(page.locator('button[type="submit"]'))
                                page.wait_for_url(origin + '/')

                            def signin(page):
                                page.goto(origin + '/auth')
                                page.locator('#signin-username').fill('synthetic_audio_owner')
                                page.locator('#signin-password').fill(passwords[0])
                                click(page.locator('button[type="submit"]'))
                                page.wait_for_url(origin + '/')

                            def workspace(page):
                                page.goto(origin + '/moteary')
                                expect(page.get_by_test_id('moteary-workspace')).to_be_visible()

                            def audio_section(page):
                                summary = page.locator('summary').filter(has_text=re.compile(r'^音频原件与校订稿$'))
                                if summary.count() and not summary.evaluate('s => s.parentElement.open'):
                                    click(summary)
                                section = page.get_by_role('region', name='音频与转写稿', exact=True)
                                expect(section).to_be_visible()
                                return section

                            def choose(page, locator, name, data, mime):
                                locator.scroll_into_view_if_needed()
                                with page.expect_file_chooser() as picker:
                                    click(locator)
                                picker.value.set_files({'name': name, 'buffer': data, 'mimeType': mime})

                            def play(page, locator):
                                expect(locator).to_be_visible()
                                locator.scroll_into_view_if_needed()
                                # Click the native media control's play button. Do not replace play().
                                box = locator.bounding_box()
                                locator.click(position={'x': 22, 'y': box['height'] / 2})
                                handle = locator.element_handle()
                                page.wait_for_function('(audio) => audio.currentTime >= 0.25 && !audio.paused && !audio.error', arg=handle)
                                first = locator.evaluate('audio => audio.currentTime')
                                page.wait_for_function('({audio, first}) => audio.currentTime > first + 0.15 && !audio.error',
                                                       arg={'audio': handle, 'first': first})
                                return handle, locator.get_attribute('src')

                            def released(page, handle, blob):
                                page.wait_for_function('url => window.__youjiBlobObservation.revoked.has(url) && !window.__youjiBlobObservation.live.has(url)', arg=blob)
                                assert handle.evaluate('audio => audio.paused && !audio.getAttribute("src")'), 'Removed audio was not paused and cleared'

                            def no_overflow(page):
                                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal document overflow'

                            wav = synthetic_wav()
                            receipts = []
                            desktop, page = context('desktop')
                            signup(page, 'synthetic_audio_owner', passwords[0])
                            workspace(page)
                            phone_context, phone = context('mobile', mobile=True)
                            signin(phone)
                            workspace(phone)
                            expect(phone.get_by_test_id('moteary-source-record')).to_have_count(0)

                            for label, current, expected_count in [('desktop', page, 1), ('mobile', phone, 2)]:
                                if label == 'mobile':
                                    current.reload()
                                    expect(current.get_by_test_id('moteary-source-record')).to_have_count(1)
                                    passed('independent same-account context sees desktop save after refresh')
                                section = audio_section(current)
                                name = f'synthetic-{label}-four-seconds.wav'
                                needle = f'YoujiManualAudio{label.capitalize()}Needle'
                                choose(current, section.get_by_label('音频原件', exact=True), name, wav, 'audio/wav')
                                before = len(calls)
                                click(section.get_by_role('button', name='试听所选本机音频', exact=True))
                                local = section.get_by_label('所选本机音频播放器', exact=True)
                                handle, blob = play(current, local)
                                click(section.get_by_role('button', name='关闭本机试听', exact=True))
                                expect(local).to_have_count(0)
                                released(current, handle, blob)
                                assert not any(c['method'] == 'POST' and ('Attachment' in c['path'] or '/audio/' in c['path']) for c in calls[before:]), 'Local preview sent material'
                                passed(f'{label} native local playback advances and close revokes blob without upload')
                                manual = f'{needle} 合成人工校订稿，仅供界面验收。原音频是四秒静音，不声称自动转写。'
                                choose(current, section.get_by_label('导入 UTF-8 转写稿', exact=True), 'synthetic-manual.txt', manual.encode(), 'text/plain')
                                expect(section.get_by_label('人工校订稿', exact=True)).to_have_value(manual)
                                with current.expect_download() as draft_download:
                                    click(section.get_by_role('button', name='下载校订草稿 JSON', exact=True))
                                draft_bytes = Path(draft_download.value.path()).read_bytes()
                                assert json.loads(draft_bytes)['edited'] == manual
                                current.reload()
                                section = audio_section(current)
                                choose(current, section.get_by_label('音频原件', exact=True), name, wav, 'audio/wav')
                                expect(section.get_by_label('人工校订稿', exact=True)).to_have_value('')
                                before_restore = len(calls)
                                choose(current, section.get_by_label('恢复校订草稿 JSON', exact=True), 'synthetic-draft.json', draft_bytes, 'application/json')
                                expect(section.get_by_label('人工校订稿', exact=True)).to_have_value(manual)
                                expect(section.get_by_role('checkbox')).not_to_be_checked()
                                assert not any(c['method'] == 'POST' for c in calls[before_restore:]), 'Draft restore wrote data'
                                passed(f'{label} explicit draft download reload and same-audio restore without save')
                                save = section.get_by_role('button', name='保存音频与校订稿', exact=True)
                                expect(save).to_be_disabled()
                                click(section.get_by_role('checkbox'))
                                click(save)
                                expect(section.get_by_text('原件和稿件已保存到同一条仅自己可见记录。', exact=True)).to_be_visible()
                                with current.expect_download() as download:
                                    click(section.get_by_role('button', name='下载恢复回执', exact=True))
                                receipt = json.loads(Path(download.value.path()).read_text())
                                assert receipt['status'] == 'imported' and receipt['sha256'] == hashlib.sha256(wav).hexdigest()
                                receipts.append(receipt)
                                current.reload()
                                expect(current.get_by_test_id('moteary-source-record')).to_have_count(expected_count)
                                current.get_by_label('资料关键词', exact=True).fill(needle)
                                click(current.get_by_role('button', name='搜索资料', exact=True))
                                expect(current.get_by_test_id('moteary-source-record')).to_have_count(1)
                                expect(current.get_by_label('记录可见范围')).to_have_text(['仅自己可见'])
                                preview = current.get_by_role('region', name=f'音频原件 {name}', exact=True)
                                # Delay real networking only to make GET cancellation observable;
                                # no fabricated API response or mock service is used.
                                cdp = current.context.new_cdp_session(current)
                                live_before = current.evaluate('window.__youjiBlobObservation.live.size')
                                cdp.send('Network.enable')
                                cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 1500, 'downloadThroughput': -1, 'uploadThroughput': -1})
                                click(preview.get_by_role('button', name='校验并试听原件', exact=True))
                                click(preview.get_by_role('button', name='取消读取', exact=True))
                                cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})
                                cdp.detach()
                                current.wait_for_timeout(1600)
                                expect(preview.get_by_label(f'试听 {name}', exact=True)).to_have_count(0)
                                assert current.evaluate('window.__youjiBlobObservation.live.size') == live_before, 'Cancelled download leaked a blob URL'
                                passed(f'{label} cancels delayed real original GET without creating a player', artificial_network_latency_ms=1500)
                                click(preview.get_by_role('button', name='校验并试听原件', exact=True))
                                verified = preview.get_by_label(f'试听 {name}', exact=True)
                                handle, blob = play(current, verified)
                                with current.expect_download() as download:
                                    click(preview.get_by_role('link', name='下载已校验音频原件', exact=True))
                                assert Path(download.value.path()).read_bytes() == wav
                                click(preview.get_by_role('button', name='关闭试听并释放', exact=True))
                                expect(verified).to_have_count(0)
                                released(current, handle, blob)
                                no_overflow(current)
                                screenshot(label, current)
                                passed(f'{label} manual save refresh search and verified original playback/download',
                                       sha256=hashlib.sha256(wav).hexdigest(), viewport='390x844' if label == 'mobile' else '1440x1000')
                                click(current.get_by_role('button', name='清除搜索', exact=True))

                            page.reload()
                            expect(page.get_by_test_id('moteary-source-record')).to_have_count(2)
                            passed('desktop context sees mobile save after refresh')
                            other_context, other = context('second-account')
                            signup(other, 'synthetic_audio_other', passwords[1])
                            workspace(other)
                            expect(other.get_by_test_id('moteary-source-record')).to_have_count(0)
                            other.get_by_label('资料关键词', exact=True).fill('YoujiManualAudio')
                            click(other.get_by_role('button', name='搜索资料', exact=True))
                            expect(other.get_by_test_id('moteary-source-record')).to_have_count(0)
                            assert auth.get('second-account'), 'No authenticated second-account request was observed'
                            anonymous = playwright.request.new_context()
                            try:
                                for receipt in receipts:
                                    archive_url = origin + '/file/' + receipt['attachment'] + '/' + quote(receipt['archive'], safe='')
                                    for client, headers, identity in [(other_context.request, {'Authorization': auth['second-account']}, 'second-account'),
                                                                      (anonymous, {}, 'anonymous')]:
                                        response = client.get(archive_url, headers=headers, max_redirects=0)
                                        assert response.status in (401, 403, 404), (identity, response.status)
                                        passed('private original denied to ' + identity, status=response.status)
                            finally:
                                anonymous.dispose()
                            assert not any(c['path'] == '/api/youji/audio/transcribe' for c in calls), 'Unexpected ASR request'
                            assert not any('pageerror' in d for d in diagnostics), 'Uncaught JavaScript errors; see sanitized diagnostics'
                            passed('no ASR calls and no uncaught errors across all browser contexts')
                            success = True
                        except Exception:
                            for label, target in pages:
                                screenshot(label + '-failure', target)
                            raise
                        finally:
                            if browser:
                                browser.close()
                finally:
                    if server:
                        server.terminate()
                        try:
                            server.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            server.kill()
                            server.wait()
                    log.flush()
                    (output / 'browser-audio-server.log').write_text(redact(log_path.read_text(errors='replace')))
    except Exception as error:
        results.append({'check': stage, 'status': 'failed' if stage == 'browser acceptance checks' else 'blocked', 'error': redact(error)})
    finally:
        report = {'status': 'passed' if success else results[-1]['status'] if results else 'blocked',
                  'checks': results, 'model_configuration': 'YOUJI_* stripped; all audio model variables explicitly empty',
                  'chromium_sandbox': True, 'data': 'synthetic accounts, four-second zero PCM WAVs and authored manual transcripts only',
                  'limitations': ['390x844 is browser emulation, not a physical phone or native soft keyboard',
                                 'No microphone recording, ASR, save-during-network-loss or concurrent-edit acceptance',
                                 'Blob observation wraps real browser methods; no mock API/media decoder',
                                 'Browser route restriction is not OS-level egress isolation']}
        (output / 'browser-audio-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        (output / 'browser-audio-diagnostics.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'status': report['status'], 'results': str(output / 'browser-audio-results.json')}, ensure_ascii=False), flush=True)
    return 0 if success else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    parser.add_argument('--output', type=Path, default=Path('validation/mobile-workspace-20261118'))
    raise SystemExit(run(parser.parse_args()))
