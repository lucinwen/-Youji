"""Explicit administrator-only model download; never called by serving requests."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.request import urlopen
from retrieval_worker import FILES, MODEL, REVISION


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--read-only', action='store_true', help='Seal this dedicated model directory and verified files with read-only mode bits')
    args = parser.parse_args()
    destination = Path(args.directory).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for name, expected in FILES.items():
        target = destination / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            continue
        url = f'https://huggingface.co/{MODEL}/resolve/{REVISION}/onnx/{name}'
        # Partial downloads never replace a validated file.
        with tempfile.NamedTemporaryFile(dir=destination, delete=False) as output:
            temporary = Path(output.name)
            try:
                digest = hashlib.sha256()
                size = 0
                with urlopen(url, timeout=60) as response:
                    while block := response.read(1 << 20):
                        size += len(block)
                        if size > 130 << 20:
                            raise ValueError('model file exceeds expected size bound')
                        digest.update(block)
                        output.write(block)
                output.close()
                if digest.hexdigest() != expected:
                    raise ValueError('model checksum mismatch')
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    manifest = destination / 'manifest.json'
    manifest_text = json.dumps({'repository': MODEL, 'revision': REVISION, 'sha256': FILES}, indent=2)
    if not manifest.is_file() or manifest.read_text() != manifest_text:
        manifest.write_text(manifest_text)
    if args.read_only:
        for name in [*FILES, 'manifest.json']:
            (destination / name).chmod(0o444)
        destination.chmod(0o555)
    print('Verified local model files. No user documents were read or uploaded.')


if __name__ == '__main__':
    main()
