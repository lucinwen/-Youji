"""Plan or explicitly start a fresh loopback-only demo with optional processors disabled."""
import argparse
import json
import os
from pathlib import Path
from youji_demo_check import inspect


def plan(binary, data, port=5231):
    if not 1024 <= port <= 65535:
        raise ValueError('Choose an unprivileged port from 1024 to 65535.')
    executable = Path(binary).absolute()
    target = Path(data).absolute()
    # Deliberately inspect the exact clean environment the child receives.
    check = inspect(executable, target, environ={})
    return {'ok': check['ok'], 'preflight': check, 'url': f'http://127.0.0.1:{port}/moteary',
            'command': [str(executable), '--addr', '127.0.0.1', '--port', str(port),
                        '--data', str(target), '--driver', 'sqlite', '--dsn', '',
                        '--unix-sock', '', '--config-apply', 'off'],
            'environment': {'LANG': 'C.UTF-8'},
            'notice': 'Fresh data only; no inherited credentials, proxies or model configuration. No data deletion. Keep the printed data path for restart.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, help='Trusted locally built executable')
    parser.add_argument('--data', required=True, help='New or empty demo directory; existing instances refused')
    parser.add_argument('--port', type=int, default=5231)
    parser.add_argument('--run', action='store_true', help='Explicitly start the server; omission only prints the plan')
    args = parser.parse_args()
    try:
        result = plan(args.binary, args.data, args.port)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    if not result['ok']:
        return 1
    if not args.run:
        return 0
    # A fresh explicit directory, fixed loopback and explicit SQLite flags; no shell.
    # A browser and account are never opened or created by this helper.
    os.execve(result['command'][0], result['command'], result['environment'])


if __name__ == '__main__':
    raise SystemExit(main())
