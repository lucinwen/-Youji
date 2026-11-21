"""Build (optional) and run synthetic loopback acceptance; never browser/ASR evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = '8ef2d5dc40bb9f082ab726b2f7c3478a0a8453de'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='New evidence directory; existing path refused')
    parser.add_argument('--binary', help='Existing trusted build; without --build no compilation occurs')
    parser.add_argument('--build', action='store_true', help='Install locked frontend dependencies, build frontend then backend; requires dependency network/cache')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.is_relative_to(ROOT):
        parser.error('Place the evidence directory outside the source checkout.')
    if output.exists():
        parser.error('Evidence directory exists; choose a new path (no overwrite).')
    binary_path = Path(args.binary or ROOT / 'build' / ('youji.exe' if os.name == 'nt' else 'youji'))
    if args.build and (binary_path.exists() or binary_path.is_symlink()):
        parser.error('Build output already exists; choose an unused --binary path (no overwrite).')
    binary = binary_path.resolve()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, commit], cwd=ROOT, check=True)
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        parser.error('Commit the acceptance checkpoint first; checkout must be clean.')
    output.mkdir(parents=True)
    report = {'source_commit': commit, 'functional_baseline': BASE, 'platform': platform.platform(),
              'python': platform.python_version(), 'build_requested': args.build, 'checks': [],
              'browser_tested': False, 'asr_executed': False,
              'limitations': ['HTTP/modules only, not browser or phone',
                             'Picker uses the same binary before/after restart: not old-version migration',
                             'No Windows claim unless this report platform is Windows',
                             'Existing binary hash records identity, not proof of independent rebuild']}
    env = {k: v for k, v in os.environ.items() if not k.startswith(('YOUJI_', 'MEMOS_'))}
    env.update({'CGO_ENABLED': '0', 'GOTOOLCHAIN': 'local', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    stage = 'prerequisites'
    try:
        if args.build:
            pnpm = shutil.which('pnpm.cmd' if os.name == 'nt' else 'pnpm')
            go = shutil.which('go')
            if not pnpm or not go:
                raise RuntimeError('pnpm and Go must already be installed; no toolchain installation performed')
            for label, command in [('frontend-install', [pnpm, '--dir', 'web', 'install', '--frozen-lockfile']),
                                   ('frontend-build', [pnpm, '--dir', 'web', 'release']),
                                   ('backend-build', [go, 'build', '-mod=readonly', '-o', str(binary), './cmd/memos'])]:
                stage = label
                binary.parent.mkdir(parents=True, exist_ok=True)
                with (output / (label + '.log')).open('w', encoding='utf-8') as log:
                    subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
                report['checks'].append({'check': label, 'status': 'passed'})
        if not binary.is_file():
            raise RuntimeError('Trusted binary missing; build first or explicitly use --build')
        with binary.open('rb') as stream:
            report['binary_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
        for label, script, extra in [
            ('multisource', 'run_multisource_demo_e2e.py', {'YOUJI_MULTISOURCE_QA_OUTPUT': str(output / 'multisource')}),
            ('source-picker', 'run_source_picker_e2e.py', {'YOUJI_PICKER_QA_OUTPUT': str(output / 'source-picker'), 'YOUJI_BASELINE_BINARY': str(binary)})]:
            stage = label
            with (output / (label + '.log')).open('w', encoding='utf-8') as log:
                subprocess.run([sys.executable, str(ROOT / 'tests/moteary' / script)], cwd=ROOT,
                               env={**env, **extra, 'MOTEARY_BINARY': str(binary)},
                               stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
            report['checks'].append({'check': label, 'status': 'passed'})
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['checks'].append({'check': stage, 'status': 'failed', 'error_type': type(error).__name__})
    finally:
        (output / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
