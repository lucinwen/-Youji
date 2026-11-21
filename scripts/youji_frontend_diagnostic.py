"""One-run fixed-label diagnosis; captures output locally, never publishes error text."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = ('passed', 'missing_package', 'native_load', 'path_permission', 'unresolved_import', 'oom_kill', 'unknown')


def classify(code, text, native=False):
    if code == 0:
        return 'passed'
    if native:
        return {21: 'missing_package', 22: 'native_load', 23: 'path_permission'}.get(code, 'unknown')
    if re.search(r'heap out of memory|allocation failed.*heap|out of memory|STATUS_NO_MEMORY', text, re.I) or code in (-9, 137):
        return 'oom_kill'  # kill observed, not proof of OOM
    if re.search(r'ERR_DLOPEN_FAILED|cannot find native binding|failed to load native binding|DLL load failed', text, re.I):
        return 'native_load'
    if re.search(r'could not resolve|failed to resolve import|UNRESOLVED_IMPORT', text, re.I):
        return 'unresolved_import'
    if re.search(r'MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|cannot find (?:module|package)', text, re.I):
        return 'missing_package'
    if re.search(r'\b(?:EACCES|EPERM|ENOENT)\b|permission denied', text, re.I):
        return 'path_permission'
    return 'unknown'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['cli', 'rolldown', 'oxide', 'lightningcss', 'release'])
    args = parser.parse_args()
    native = args.mode in ('rolldown', 'oxide', 'lightningcss')
    if native:
        cmd, cwd = ['node', str(ROOT / 'scripts/youji_native_probe.mjs'), args.mode], ROOT
    else:
        cmd = ['node', str(ROOT / 'web/node_modules/vite/bin/vite.js')]
        cmd += ['--version'] if args.mode == 'cli' else ['build', '--mode', 'release', '--outDir=../server/frontend/dist', '--emptyOutDir']
        cwd = ROOT / 'web'
    code, output = 98, ''
    try:
        with tempfile.TemporaryFile() as capture:
            result = subprocess.run(cmd, cwd=cwd, stdout=capture, stderr=subprocess.STDOUT, timeout=480 if args.mode == 'release' else 60)
            code = result.returncode
            capture.seek(0)
            output = capture.read(8 * 1024 * 1024).decode('utf-8', errors='replace')
        category = classify(code, output, native)
    except subprocess.TimeoutExpired:
        category, code = 'unknown', 124
    except OSError as error:
        category = 'path_permission' if error.errno in (2, 13) else 'unknown'
    flags = {'vite_started': bool(re.search(r'vite v[\d.]', output, re.I)),
             'transform_started': bool(re.search(r'transforming', output, re.I)),
             'transform_complete': bool(re.search(r'\d+ modules transformed', output, re.I)),
             'target_index_exists': (ROOT / 'server/frontend/dist/index.html').is_file()}
    print(json.dumps({'category': category, 'exit_code': code, **flags}))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write(f'category={category}\nexit_code={code}\n')
    return 0 if category == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
