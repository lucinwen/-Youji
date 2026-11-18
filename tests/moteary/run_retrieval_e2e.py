"""Real isolated SQLite/HTTP retrieval checks; no browser or mocked API.
MOTEARY_BINARY=./build/youji python tests/moteary/run_retrieval_e2e.py
"""
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("source_importer", root / "moteary/import_sources.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
binary = Path(os.environ.get("MOTEARY_BINARY", root / "build/youji")).resolve()
checks = []

with tempfile.TemporaryDirectory(prefix="youji-retrieval-") as directory:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    process = None
    with open(Path(directory) / "server.log", "w") as log:
        def start():
            global process
            process = subprocess.Popen([str(binary), "--addr", "127.0.0.1", "--port", str(port), "--data", directory, "--config-apply", "off"], stdout=log, stderr=log)
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("Isolated server exited before readiness")
                try:
                    with urlopen(base, timeout=1):
                        return
                except OSError:
                    time.sleep(0.1)
            raise RuntimeError("Isolated server did not become ready")

        def stop():
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        def public(route, body):
            request = Request(base + "/api/" + route, json.dumps(body).encode(), {"Content-Type": "application/json"})
            with urlopen(request, timeout=10) as response:
                return json.load(response)

        def login(username, password):
            token = public("auth/signin", {"passwordCredentials": {"username": username, "password": password}})["accessToken"]
            return module.Client(base, token)

        def account(username):
            password = secrets.token_urlsafe(24)
            user = public("users", {"username": username, "password": password})
            return user["name"], password, login(username, password)

        try:
            start()
            account("synthetic-admin")
            owner, password, client = account("synthetic-owner")
            _, _, other = account("synthetic-other")
            def memo(api, kind, when, category="work"):
                result = api.call("POST", "memos", {"content": f"#拾微 #{category} #source/{kind}\n\nSyntheticRetrievalNeedle 合成原话与批注", "visibility": "PRIVATE"})
                api.call("PATCH", result["name"] + "?" + urlencode({"updateMask": "create_time"}), {"name": result["name"], "createTime": when})
                return result["name"]

            # US Eastern 2026-03-08 is a 23-hour local day, 05:00Z through next 04:00Z.
            wanted = {memo(client, "podcast", "2026-03-08T05:00:00Z"), memo(client, "podcast", "2026-03-09T03:59:59Z")}
            memo(client, "podcast", "2026-03-08T04:59:59Z")
            memo(client, "podcast", "2026-03-09T04:00:00Z")
            text = memo(client, "text", "2026-03-08T12:00:00Z", "diary")
            memo(other, "podcast", "2026-03-08T12:00:00Z")
            scope = f'(creator == {json.dumps(owner)}) && (tag in ["拾微"])'
            start_ts = int(datetime.fromisoformat("2026-03-08T05:00:00+00:00").timestamp())
            end_ts = int(datetime.fromisoformat("2026-03-09T04:00:00+00:00").timestamp())
            interval = f'(created_ts >= timestamp({start_ts})) && (created_ts < timestamp({end_ts}))'
            combined = scope + ' && (tag in ["work"]) && (tag in ["source/podcast"]) && (content.contains("SyntheticRetrievalNeedle")) && ' + interval

            def find(api, filter_, expected, label):
                names, page_token, pages = [], "", 0
                while True:
                    result = api.call("GET", "memos?" + urlencode({"filter": filter_, "pageSize": 1, "pageToken": page_token, "orderBy": "create_time desc"}))
                    pages += 1
                    names.extend(item["name"] for item in result.get("memos", []))
                    page_token = result.get("nextPageToken", "")
                    if not page_token:
                        break
                    assert pages < 20, "pagination did not terminate"
                assert set(names) == expected and len(names) == len(expected), (label, names)
                checks.append({"check": label, "passed": True, "records": len(names), "pages": pages})

            find(client, combined, wanted, "source/category/keyword/date with paginated full results")
            find(client, scope + ' && (tag in ["diary"]) && (tag in ["source/text"]) && ' + interval, {text}, "life diary retrieval")
            find(client, combined + ' && content.contains("missingneedle")', set(), "empty match remains empty")
            find(client, scope + ' && content.contains(' + json.dumps('x") || true || ("') + ')', set(), "keyword operators remain literal")
            find(other, combined, set(), "other account cannot retrieve private owner records")
            stop()
            start()
            client = login("synthetic-owner", password)
            find(client, combined, wanted, "same records retrieved after process restart and sign-in")
            print(json.dumps({"kind": "real SQLite and HTTP, not browser E2E", "checks": checks}, ensure_ascii=False, indent=2))
        finally:
            stop()
