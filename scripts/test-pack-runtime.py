#!/usr/bin/env python3
"""Test pack behavior using an existing Blockwork Rust build and simulated I/O.

Usage: python3 scripts/test-pack-runtime.py /path/to/Blockwork/target/debug/deps
   or: python3 scripts/test-pack-runtime.py build.json
build.json is the output of `cargo build -p blockwork-core --message-format=json`,
which works whatever layout cargo's build directory has (newer cargo no longer
keeps every rlib in target/debug/deps). The build must use the active rustc.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('deps', type=Path, help="Blockwork's target/debug/deps directory, or cargo's JSON build messages")
args = parser.parse_args()
deps = args.deps.resolve()
if deps.is_file():
    # Every crate's artifacts, wherever cargo put them.
    libraries, search = [], set()
    for line in deps.read_text().splitlines():
        message = json.loads(line) if line.startswith('{') else {}
        if message.get('reason') != 'compiler-artifact':
            continue
        for name in message.get('filenames', []):
            if name.endswith(('.rlib', '.rmeta')):
                search.add(str(Path(name).parent))
                if message['target']['name'] == 'blockwork_core' and name.endswith('.rlib'):
                    libraries.append(Path(name))
else:
    libraries, search = list(deps.glob('libblockwork_core-*.rlib')), {str(deps)}
if not libraries:
    parser.error('Build blockwork-core first; no libblockwork_core-*.rlib found.')
if len(libraries) > 1:
    # Builds with different features sit side by side; which one is meant can't be guessed.
    parser.error('Several libblockwork_core-*.rlib builds in %s; clean it and build blockwork-core once.' % deps)
root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='blockwork-pack-tests-') as directory:
    executable = str(Path(directory) / 'pack-runtime-tests')
    subprocess.run([
        'rustc', '--edition=2024', str(root / 'test/official-packs-runtime.rs'),
        '--extern', f'blockwork_core={libraries[0]}',
        *(arg for d in sorted(search) for arg in ('-L', f'dependency={d}')), '-o', executable,
    ], check=True, cwd=root)
    subprocess.run([executable], check=True, cwd=root)
