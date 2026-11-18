"""Read-only preflight for a fresh local demo; never starts a server or model."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


MODEL_ENV = tuple(
    f"YOUJI_{kind}_{part}"
    for kind, parts in (("AUDIO", ("PYTHON", "WORKER", "MODEL")),
                        ("PDF", ("PYTHON", "WORKER")),
                        ("RETRIEVAL", ("PYTHON", "WORKER", "MODEL")))
    for part in parts
)


def inspect(binary, data, environ=None, runner=subprocess.run):
    """Check paths and the trusted binary's version subcommand, without writing."""
    environ = os.environ if environ is None else environ
    report = {"kind": "fresh-local-demo-preflight", "server_contacted": False,
              "models_executed": False,
              "model_env_set": {key: bool(environ.get(key)) for key in MODEL_ENV}}
    executable = Path(binary).absolute()
    target = Path(data).absolute()
    try:
        if target.is_symlink():
            state = "symlink_refused"
        elif target.exists():
            state = "empty" if target.is_dir() and next(target.iterdir(), None) is None else "existing_data_refused"
        else:
            ancestor = target.parent
            while not ancestor.exists() and ancestor != ancestor.parent:
                ancestor = ancestor.parent
            state = "new" if ancestor.is_dir() and os.access(ancestor, os.W_OK | os.X_OK) else "parent_unavailable"
    except OSError:
        state = "unreadable"
    report["data_state"] = state
    report["binary"] = {"executable": executable.is_file() and os.access(executable, os.X_OK),
                        "version": None, "status": "unavailable"}
    if report["binary"]["executable"]:
        try:
            # The caller selects a trusted local binary. No shell, inherited secrets,
            # server flags, data path or model configuration are passed to it.
            result = runner([str(executable), "version"], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=5, check=False, env={"LANG": "C.UTF-8"})
            match = re.fullmatch(rb"(?:memos version )?([0-9]{2}\.[0-9]{2}\.[0-9]+(?:[-+.][A-Za-z0-9.-]+)?)\s*", result.stdout, re.I)
            if result.returncode == 0 and match:
                report["binary"].update(status="ok", version=match.group(1).decode("ascii"))
            else:
                report["binary"]["status"] = "unexpected_version"
        except (OSError, subprocess.TimeoutExpired):
            report["binary"]["status"] = "version_check_failed"
    report["ok"] = (state in ("new", "empty") and report["binary"]["status"] == "ok"
                    and not any(report["model_env_set"].values()))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, help="Trusted locally built Memos/Youji executable")
    parser.add_argument("--data", required=True, help="New or empty demo directory (not created)")
    args = parser.parse_args()
    report = inspect(args.binary, args.data)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
