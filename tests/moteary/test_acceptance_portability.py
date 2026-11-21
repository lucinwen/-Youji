"""No server/network: output protection, UTF-8 and failure propagation."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('acceptance', ROOT / 'scripts/youji_acceptance.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AcceptanceTests(unittest.TestCase):
    def invoke(self, args):
        with patch.object(sys, 'argv', ['acceptance', *map(str, args)]):
            return module.main()

    def test_source_output_refused(self):
        with self.assertRaises(SystemExit) as error:
            self.invoke(['--output', ROOT / 'never-created-evidence'])
        self.assertEqual(error.exception.code, 2)
        self.assertFalse((ROOT / 'never-created-evidence').exists())

    def test_existing_evidence_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(SystemExit):
                self.invoke(['--output', temp])
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_existing_binary_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'existing.exe'
            binary.write_bytes(b'preserve')
            with self.assertRaises(SystemExit):
                self.invoke(['--output', Path(temp) / 'out', '--build', '--binary', binary])
            self.assertEqual(binary.read_bytes(), b'preserve')
            self.assertFalse((Path(temp) / 'out').exists())

    def test_utf8_and_child_failure_propagate(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / 'synthetic.exe'
            binary.write_bytes(b'not-executed')
            output = Path(temp) / 'out'
            commands = []
            def run(command, **kwargs):
                commands.append((command, kwargs))
                if command[0] != 'git':
                    self.assertEqual(kwargs['env']['PYTHONUTF8'], '1')
                    self.assertEqual(kwargs['env']['PYTHONIOENCODING'], 'utf-8')
                    raise subprocess.CalledProcessError(7, command)
            with patch.object(module.subprocess, 'check_output', side_effect=['synthetic-sha\n', '']), \
                 patch.object(module.subprocess, 'run', side_effect=run), \
                 patch.object(module.platform, 'platform', return_value='合成 Windows 环境'):
                self.assertEqual(self.invoke(['--output', output, '--binary', binary]), 1)
            report = json.loads((output / 'acceptance.json').read_text(encoding='utf-8'))
            self.assertEqual(report['platform'], '合成 Windows 环境')
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['checks'][0]['check'], 'multisource')
            self.assertEqual(len(commands), 2)  # ancestry + failed child; no next stage


if __name__ == '__main__':
    unittest.main()
