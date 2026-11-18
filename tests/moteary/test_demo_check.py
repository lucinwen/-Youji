import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("demo_check", Path(__file__).resolve().parents[2] / "scripts/youji_demo_check.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class DemoCheckTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "trusted-binary"
        self.binary.write_text("test fixture only")
        self.binary.chmod(0o700)

    def run_check(self, data=None, environ=None, runner=None):
        return check.inspect(self.binary, data or self.root / "new-data", environ or {},
                             runner or (lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=b"26.11.18-dev.abc1234\n")))

    def test_new_path_is_not_created(self):
        report = self.run_check()
        self.assertTrue(report["ok"])
        self.assertFalse((self.root / "new-data").exists())

    def test_existing_data_is_not_touched(self):
        data = self.root / "data"
        data.mkdir()
        content = data / "memos_prod.db"
        content.write_bytes(b"unchanged")
        self.assertEqual(self.run_check(data)["data_state"], "existing_data_refused")
        self.assertEqual(content.read_bytes(), b"unchanged")

    def test_empty_and_symlink(self):
        data = self.root / "empty"
        data.mkdir()
        self.assertTrue(self.run_check(data)["ok"])
        link = self.root / "link"
        link.symlink_to(data, target_is_directory=True)
        self.assertFalse(self.run_check(link)["ok"])

    def test_model_environment_is_redacted_and_refused(self):
        report = self.run_check(environ={"YOUJI_AUDIO_MODEL": "secret-model-path"})
        self.assertFalse(report["ok"])
        self.assertTrue(report["model_env_set"]["YOUJI_AUDIO_MODEL"])
        self.assertNotIn("secret-model-path", str(report))

    def test_subprocess_is_version_only_and_has_no_inherited_credentials(self):
        def runner(args, **kwargs):
            self.assertEqual(args, [str(self.binary), "version"])
            self.assertEqual(kwargs["env"], {"LANG": "C.UTF-8"})
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            return SimpleNamespace(returncode=0, stdout=b"memos version 26.11.18\n")
        self.assertTrue(self.run_check(environ={"SECRET_TOKEN": "secret"}, runner=runner)["ok"])

    def test_invalid_output_and_timeout_are_sanitized(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("sensitive-path", 5)
        for runner in (timeout, lambda *a, **kw: SimpleNamespace(returncode=0, stdout=b"secret-token")):
            report = self.run_check(runner=runner)
            self.assertFalse(report["ok"])
            self.assertNotIn("secret", str(report))


if __name__ == "__main__":
    unittest.main()
