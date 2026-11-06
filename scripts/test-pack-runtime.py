#!/usr/bin/env python3
"""Test pack behavior using an existing Blockwork Rust build and simulated I/O.

Usage: python3 scripts/test-pack-runtime.py /path/to/Blockwork/target/debug/deps
The build must contain blockwork-core and use the active rustc toolchain.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('deps', type=Path, help='Blockwork target/debug/deps directory')
args = parser.parse_args()
deps = args.deps.resolve()
libraries = list(deps.glob('libblockwork_core-*.rlib'))
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
        '--extern', f'blockwork_core={libraries[0]}', '-L', f'dependency={deps}', '-o', executable,
    ], check=True, cwd=root)
    subprocess.run([executable], check=True, cwd=root)
