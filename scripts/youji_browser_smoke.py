#!/usr/bin/env python3
"""Real Chromium smoke test against a fresh, loopback-only Youji process.
Requires Python Playwright and a Chromium executable; no mock API or private data.
Run: python scripts/youji_browser_smoke.py --binary build/youji --output /tmp/youji-e2e
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
import zipfile
from playwright.sync_api import sync_playwright, expect


def run(binary, chromium, output):
    output.mkdir(parents=True, exist_ok=True)
    results = []
    def passed(name, **evidence):
        results.append(dict(check=name, status="passed", **evidence))
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    with tempfile.TemporaryDirectory(prefix="youji-browser-") as temp:
        root = Path(temp)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        with (root / "server.log").open("w") as log:
            server = subprocess.Popen([str(binary.resolve()), "--addr", "127.0.0.1", "--port", str(port),
                                       "--data", str(root / "data"), "--config-apply", "off"], stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if server.poll() is not None:
                        raise RuntimeError((root / "server.log").read_text())
                    try:
                        urllib.request.urlopen(url, timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.5)
                else:
                    raise RuntimeError("Server did not become ready")
                with sync_playwright() as p:
                    browser = p.chromium.launch(executable_path=chromium, args=["--no-sandbox"])
                    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US")
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.set_default_timeout(30000)
                    username, password = "synthetic_e2e", secrets.token_urlsafe(24)
                    page.goto(url)
                    page.locator("#signup-username").fill(username)
                    page.locator("#signup-password").fill(password)
                    page.locator('button[type="submit"]').click()
                    page.wait_for_url(url + "/")
                    page.goto(url + "/moteary")
                    expect(page.get_by_test_id("moteary-workspace")).to_be_visible()
                    passed("fresh instance signup and authenticated workspace")
                    text = "合成材料 YoujiBrowserNeedle：海边散步与知识记录。\n".encode()
                    wav = io.BytesIO()
                    with wave.open(wav, "wb") as w:
                        w.setnchannels(1)
                        w.setsampwidth(2)
                        w.setframerate(8000)
                        w.writeframes(b"\x00\x00" * 8000)
                    files = [("synthetic-note.txt", text, "text/plain"), ("synthetic-silence.wav", wav.getvalue(), "audio/wav")]
                    page.get_by_label("批量资料文件").set_input_files([
                        {"name": name, "mimeType": mime, "buffer": data} for name, data, mime in files])
                    page.get_by_label("批量共同批注").fill("SyntheticAnnotationNeedle 合成批注")
                    page.get_by_role("button", name="预检这批资料", exact=True).click()
                    expect(page.get_by_text("已预检，尚未保存", exact=True)).to_have_count(2)
                    expect(page.get_by_test_id("moteary-source-record")).to_have_count(0)
                    passed("preflight does not create records")
                    page.get_by_role("button", name="保存为私有记录 / 复核重试", exact=True).click()
                    expect(page.get_by_text("已保存", exact=True)).to_have_count(2)
                    expect(page.get_by_test_id("moteary-source-record")).to_have_count(2)
                    passed("browser uploads text and audio originals over real API")
                    page.get_by_role("button", name="保存为私有记录 / 复核重试", exact=True).click()
                    expect(page.get_by_text("已复核原件", exact=True)).to_have_count(2)
                    expect(page.get_by_test_id("moteary-source-record")).to_have_count(2)
                    passed("retry verifies originals without duplicate records")
                    with page.expect_download() as download:
                        page.get_by_role("button", name="下载本批回执").click()
                    receipt = json.loads(Path(download.value.path()).read_text())
                    assert len(receipt["items"]) == 2
                    assert all(item["status"] == "verified" for item in receipt["items"])
                    assert "SyntheticAnnotationNeedle" not in json.dumps(receipt)
                    passed("browser receipt download reports verified hashes without annotation")
                    page.reload()
                    expect(page.get_by_test_id("moteary-source-record")).to_have_count(2)
                    expect(page.get_by_label("记录可见范围")).to_have_text(["仅自己可见", "仅自己可见"])
                    for term, count in [("YoujiBrowserNeedle", 1), ("SyntheticAnnotationNeedle", 2), ("synthetic-silence.wav", 1), ("nonexistentneedle", 0)]:
                        page.get_by_label("资料关键词").fill(term)
                        page.get_by_role("button", name="搜索资料", exact=True).click()
                        expect(page.get_by_test_id("moteary-source-record")).to_have_count(count)
                    passed("refresh persistence and body annotation filename searches")
                    page.get_by_role("button", name="清除搜索", exact=True).click()
                    expect(page.get_by_test_id("moteary-source-record")).to_have_count(2)
                    page.screenshot(path=str(output / "desktop.png"), full_page=True)
                    for item, (name, data, _) in zip(receipt["items"], files):
                        page.goto(url + "/" + item["record"])
                        link = page.locator('a[href*="/file/attachments/"]').filter(has_text=name + ".original.zip").first
                        expect(link).to_be_visible()
                        href = link.get_attribute("href")
                        with page.expect_download() as original_download:
                            link.click()
                        downloaded = Path(original_download.value.path()).read_bytes()
                        with zipfile.ZipFile(io.BytesIO(downloaded)) as archive:
                            assert archive.namelist() == [name]
                            assert archive.read(name) == data
                        anonymous = p.request.new_context()
                        denied = anonymous.get(href if href.startswith("http") else url + href)
                        assert denied.status in (401, 403), denied.status
                        anonymous.dispose()
                        passed("authenticated original download and anonymous denial", filename=name, sha256=hashlib.sha256(data).hexdigest(), anonymous_status=denied.status)
                    mobile = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="en-US")
                    phone = mobile.new_page()
                    phone.goto(url + "/auth")
                    phone.locator("#signin-username").fill(username)
                    phone.locator("#signin-password").fill(password)
                    phone.locator('button[type="submit"]').click()
                    phone.wait_for_url(url + "/")
                    phone.goto(url + "/moteary")
                    expect(phone.get_by_test_id("moteary-source-record")).to_have_count(2)
                    phone.get_by_label("资料关键词").fill("YoujiBrowserNeedle")
                    phone.get_by_role("button", name="搜索资料", exact=True).click()
                    expect(phone.get_by_test_id("moteary-source-record")).to_have_count(1)
                    assert phone.evaluate("document.documentElement.scrollWidth <= innerWidth"), "mobile horizontal overflow"
                    phone.screenshot(path=str(output / "mobile.png"), full_page=True)
                    passed("independent mobile-sized browser login sync and search", viewport="390x844", physical_device=False)
                    assert not errors, errors
                    passed("no uncaught desktop JavaScript errors")
                    browser.close()
            except Exception as error:
                results.append(dict(check="smoke run", status="failed", error=str(error)))
                raise
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.binary, args.chromium, args.output)
