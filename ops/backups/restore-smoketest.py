#!/usr/bin/env python3
"""Restore downloaded database dumps into disposable containers without networking.

Usage: python3 restore-smoketest.py /path/to/restored/snapshot
Requires the original database images to be available locally.
"""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=120, **kwargs).stdout


def wait_for(args):
    for _ in range(60):
        try:
            run(args)
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise RuntimeError('Restore-test database did not start')


def main():
    stage = Path(sys.argv[1])
    db = sqlite3.connect(':memory:')
    db.executescript((stage / 'community.sql').read_text())
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    expected = json.loads((stage / 'd1-validation.json').read_text())['tables']
    for table, count in expected.items():
        actual = db.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
        assert actual == count
    print(f'D1 restored: {len(expected)} tables; integrity and row counts passed', flush=True)
    containers = json.loads((stage / 'containers.json').read_text())
    mail = next(c for c in containers if 'mysql-mailcow' in c['Name'])
    mailenv = dict(v.split('=', 1) for v in mail['Config']['Env'] if '=' in v)
    pg = next(c for c in containers if c['Name'] == '/weblate-docker-database-1')
    pgenv = dict(v.split('=', 1) for v in pg['Config']['Env'] if '=' in v)
    names = []
    try:
        name = 'blockwork-restore-postgres-' + uuid.uuid4().hex[:10]
        run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m',
             '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
             '-e', 'POSTGRES_USER=' + pgenv['POSTGRES_USER'],
             '-e', 'POSTGRES_DB=' + pgenv['POSTGRES_DB'], pg['Image']])
        names.append(name)
        # The entrypoint's temporary initialization server has no TCP listener.
        # Wait for the final server, rather than racing that temporary instance.
        wait_for(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', pgenv['POSTGRES_USER'],
                  '-d', pgenv['POSTGRES_DB']])
        with (stage / 'weblate.dump').open('rb') as stream:
            run(['docker', 'exec', '-i', name, 'pg_restore', '-U', pgenv['POSTGRES_USER'],
                 '-d', pgenv['POSTGRES_DB'], '--exit-on-error'], stdin=stream)
        result = run(['docker', 'exec', name, 'psql', '-U', pgenv['POSTGRES_USER'],
                      '-d', pgenv['POSTGRES_DB'], '-Atc',
                      "SELECT 'users=' || count(*) FROM weblate_auth_user; "
                      "SELECT 'translations=' || count(*) FROM trans_translation;"])
        print('Weblate restored: ' + result.decode().strip().replace('\n', ', '), flush=True)
        name = 'blockwork-restore-mariadb-' + uuid.uuid4().hex[:10]
        run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m',
             '--tmpfs', '/var/lib/mysql', '-e', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1', mail['Image']])
        names.append(name)
        wait_for(['docker', 'exec', name, 'mariadb-admin', '--protocol=tcp', '-h127.0.0.1', 'ping', '-uroot'])
        with (stage / 'mailcow.sql').open('rb') as stream:
            run(['docker', 'exec', '-i', name, 'mariadb', '-uroot'], stdin=stream)
        # Importing mysql's grant tables does not refresh the server's cached
        # privileges. Reload them before testing the original root credential.
        run(['docker', 'exec', name, 'mariadb', '-uroot', '-e', 'FLUSH PRIVILEGES'])
        # Supply the restored root password on stdin, never in process arguments.
        result = run(['docker', 'exec', '-i', name, 'sh', '-c',
                      'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mariadb -uroot -N mailcow '
                      '-e "SELECT COUNT(*) FROM mailbox; SELECT COUNT(*) FROM domain"'],
                     input=(mailenv['MYSQL_ROOT_PASSWORD'] + '\n').encode())
        print('Mailcow restored mailbox/domain counts: ' + result.decode().strip().replace('\n', ', '), flush=True)
        print('Isolated database restore passed', flush=True)
    finally:
        for name in names:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not log dump contents, credentials, or subprocess input on failure.
        print('Restore test failed: ' + type(error).__name__, flush=True)
        raise SystemExit(1)
