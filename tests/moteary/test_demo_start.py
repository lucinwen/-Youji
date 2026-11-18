import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('demo_start', ROOT / 'scripts/youji_demo_start.py')
start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(start)


class DemoStartTest(unittest.TestCase):
    def test_clean_explicit_plan(self):
        with patch.object(start, 'inspect', return_value={'ok': True}) as inspect:
            result = start.plan('/trusted/youji', '/new/demo', 5231)
        self.assertEqual(result['environment'], {'LANG': 'C.UTF-8'})
        self.assertEqual(result['command'][1:], ['--addr', '127.0.0.1', '--port', '5231', '--data', '/new/demo',
                                              '--driver', 'sqlite', '--dsn', '', '--unix-sock', '', '--config-apply', 'off'])
        self.assertEqual(inspect.call_args.kwargs, {'environ': {}})

    def test_refusal_not_overridden(self):
        with patch.object(start, 'inspect', return_value={'ok': False}):
            self.assertFalse(start.plan('/trusted/youji', '/existing/data')['ok'])

    def test_privileged_or_invalid_port_refused(self):
        for port in (-1, 0, 80, 65536):
            with self.assertRaises(ValueError): start.plan('/trusted/youji', '/new/data', port)

    @unittest.skipUnless(os.environ.get('YOUJI_DEMO_REAL_BINARY'), 'real trusted binary not configured')
    def test_actual_clean_plan_start_and_existing_data_refusal(self):
        binary = str(Path(os.environ['YOUJI_DEMO_REAL_BINARY']).absolute())
        with tempfile.TemporaryDirectory(prefix='youji-clean-start-') as temp:
            data = Path(temp) / 'data'
            command = [sys.executable, str(ROOT / 'scripts/youji_demo_start.py'), '--binary', binary, '--data', str(data)]
            env = {**os.environ, 'YOUJI_AUDIO_MODEL': '/synthetic-must-not-be-inherited', 'MEMOS_ADDR': '0.0.0.0'}
            result = subprocess.run(command, env=env, capture_output=True, check=True, timeout=15)
            plan = json.loads(result.stdout)
            self.assertTrue(plan['ok'])
            self.assertEqual(plan['environment'], {'LANG': 'C.UTF-8'})
            self.assertNotIn('synthetic-must-not', result.stdout.decode())
            self.assertFalse(data.exists())
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            with (Path(temp) / 'server.log').open('w') as log:
                server = subprocess.Popen(command + ['--port', str(port), '--run'], env=env, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        try:
                            with urlopen(f'http://127.0.0.1:{port}/moteary', timeout=1) as response:
                                self.assertEqual(response.status, 200)
                                self.assertIn(b'<html', response.read().lower())
                            break
                        except OSError:
                            if server.poll() is not None: self.fail('clean demo server exited')
                            time.sleep(.1)
                    else: self.fail('clean demo startup timeout')
                    with self.assertRaises(HTTPError) as denied:
                        urlopen(f'http://127.0.0.1:{port}/api/memos', timeout=5)
                    self.assertEqual(denied.exception.code, 401)
                finally:
                    server.terminate(); server.wait(timeout=10)
            self.assertTrue(any(data.iterdir()))
            refused = subprocess.run(command, env=env, capture_output=True, timeout=15)
            self.assertEqual(refused.returncode, 1)
            self.assertEqual(json.loads(refused.stdout)['preflight']['data_state'], 'existing_data_refused')


if __name__ == '__main__': unittest.main()
