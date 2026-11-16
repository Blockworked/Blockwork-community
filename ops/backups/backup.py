#!/usr/bin/env python3
"""Encrypted full service snapshots, stored as verified chunks in private R2.

Requires Python 3, Docker, GnuPG and an existing alpine image. Secrets stay on
the backup host; no third-party Python dependencies are required.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path.home() / '.local/share/blockwork-backup'
CONFIG = Path.home() / '.config/blockwork-backup/config.json'
CHUNK_SIZE = 32 * 1024 * 1024


def log(message):
    print(dt.datetime.now(dt.timezone.utc).isoformat(), message, flush=True)


def command(args, output=None, timeout=300):
    if output:
        with open(output, 'wb') as stream:
            subprocess.run(args, stdout=stream, stderr=subprocess.PIPE,
                           check=True, timeout=timeout)
    else:
        return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout)


class Backup:
    def __init__(self):
        self.config = json.loads(CONFIG.read_text())
        self.token = Path(self.config['token_file']).read_text().strip()
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + self.config['account_id']
        self.bucket = self.config['backup_bucket']
        self.paused = []

    def request(self, path, method='GET', data=None, raw=False, headers=None):
        h = {'Authorization': 'Bearer ' + self.token, **(headers or {})}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            h['Content-Type'] = 'application/json'
        for attempt in range(5):
            try:
                api_base = 'https://api.cloudflare.com/client/v4' if path.startswith('/zones') else self.base
                req = urllib.request.Request(api_base + path, data=data, headers=h, method=method)
                with urllib.request.urlopen(req, timeout=90) as response:
                    body = response.read()
                if raw:
                    return body
                value = json.loads(body)
                if not value.get('success', False):
                    raise RuntimeError('Cloudflare request failed: ' + path)
                return value
            except urllib.error.HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                    raise RuntimeError(f'Cloudflare HTTP {error.code}: {path.split("?")[0]}') from None
                time.sleep(min(30, int(error.headers.get('Retry-After', '5'))))
            except (TimeoutError, urllib.error.URLError):
                if attempt == 4:
                    raise RuntimeError('Cloudflare connection failed') from None
                time.sleep(5)

    @staticmethod
    def object_path(bucket, key):
        return '/r2/buckets/' + bucket + '/objects/' + urllib.parse.quote(key, safe='')

    def objects(self, bucket, prefix=''):
        result, cursor = [], None
        while True:
            params = {'per_page': '1000', 'prefix': prefix}
            if cursor:
                params['cursor'] = cursor
            page = self.request('/r2/buckets/' + bucket + '/objects?' + urllib.parse.urlencode(params))
            result.extend(page['result'])
            info = page.get('result_info', {})
            if not info.get('is_truncated'):
                return result
            next_cursor = info.get('cursor')
            if not next_cursor or next_cursor == cursor:
                raise RuntimeError('R2 pagination did not advance')
            cursor = next_cursor

    def put_verified(self, key, content):
        path = self.object_path(self.bucket, key)
        self.request(path, 'PUT', content, raw=True,
                     headers={'Content-Type': 'application/octet-stream'})
        received = self.request(path, raw=True)
        digest = hashlib.sha256(content).hexdigest()
        if hashlib.sha256(received).hexdigest() != digest:
            raise RuntimeError('Uploaded object failed read-back verification')
        return {'key': key, 'size': len(content), 'sha256': digest}

    def pause(self, names):
        # Persist intent before pausing, so ExecStopPost can recover after SIGKILL.
        for name in names:
            status = json.loads(command(['docker', 'inspect', name]))[0]['State']
            if not status['Running'] or status.get('Paused'):
                raise RuntimeError('Expected service to be running and unpaused: ' + name)
            self.paused.append(name)
            (ROOT / 'paused.json').write_text(json.dumps(self.paused))
            command(['docker', 'pause', name], timeout=30)

    def resume(self):
        failed = []
        for name in reversed(self.paused):
            try:
                state = json.loads(command(['docker', 'inspect', name]))[0]['State']
                if state.get('Paused'):
                    command(['docker', 'unpause', name], timeout=30)
            except Exception:
                failed.append(name)
        self.paused = list(reversed(failed))
        (ROOT / 'paused.json').write_text(json.dumps(self.paused))
        if failed:
            raise RuntimeError('Could not resume services: ' + ', '.join(failed))

    def tar_mounts(self, mounts, target):
        args = ['docker', 'run', '--rm', '--network', 'none']
        for source, destination, kind in mounts:
            args += ['--mount', f'type={kind},source={source},destination=/{destination},readonly']
        args += [self.config['archive_image'], 'tar', 'czf', '-', '--exclude=.git', '-C', '/']
        args += [destination for _, destination, _ in mounts]
        command(args, target, timeout=300)
        # Check every gzip member and tar header before accepting the capture.
        with tarfile.open(target, 'r:gz') as archive:
            for member in archive:
                if member.isfile():
                    stream = archive.extractfile(member)
                    while stream.read(1024 * 1024):
                        pass

    def capture_host(self, stage):
        containers = json.loads(command(['docker', 'inspect'] + self.config['containers']))
        (stage / 'containers.json').write_text(json.dumps(containers, indent=2))
        self.tar_mounts(self.config['configuration_mounts'], stage / 'configuration.tar.gz')
        mail_writers = self.config['mail_writers']
        log('Capturing Mailcow; briefly pausing mail writers')
        try:
            self.pause(mail_writers)
            command(['docker', 'exec', self.config['mail_mysql'], 'sh', '-c',
                     'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mariadb-dump -uroot '
                     '--single-transaction --routines --events --all-databases --hex-blob'],
                    stage / 'mailcow.sql')
            command(['docker', 'exec', self.config['mail_redis'], 'sh', '-c',
                     'export REDISCLI_AUTH="$REDISPASS"; exec redis-cli --no-auth-warning SAVE'])
            self.tar_mounts(self.config['mail_mounts'], stage / 'mailcow-volumes.tar.gz')
        finally:
            self.resume()
        log('Mailcow writers resumed')
        log('Capturing Weblate; briefly pausing its application workers')
        try:
            self.pause([self.config['weblate']])
            command(['docker', 'exec', self.config['weblate_db'], 'sh', '-c',
                     'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                    stage / 'weblate.dump')
            self.tar_mounts(self.config['weblate_mounts'], stage / 'weblate-data.tar.gz')
        finally:
            self.resume()
        log('Weblate workers resumed')
        # ntfy uses SQLite WAL. Pause it while preserving database, WAL and SHM.
        try:
            self.pause([self.config['ntfy']])
            self.tar_mounts(self.config['ntfy_mounts'], stage / 'notifications.tar.gz')
        finally:
            self.resume()

    def capture_cloud(self, stage):
        log('Capturing community and support D1/R2')
        directory = stage / 'objects'
        directory.mkdir()
        inventory = {}

        def download(obj):
            key = obj['key']
            # Use hashed local filenames; remote keys cannot traverse staging paths.
            name = hashlib.sha256(key.encode()).hexdigest()
            body = self.request(self.object_path(self.config['source_bucket'], key), raw=True)
            (directory / name).write_bytes(body)
            inventory[key] = {**obj, 'local_file': 'objects/' + name,
                              'sha256': hashlib.sha256(body).hexdigest(), 'captured_size': len(body)}

        # Capture objects before exporting references, then capture any additions.
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(download, self.objects(self.config['source_bucket'])))
        path = '/d1/database/' + self.config['database_id'] + '/export'
        bookmark = None
        for _ in range(120):
            body = {'output_format': 'polling'}
            if bookmark:
                body['current_bookmark'] = bookmark
            result = self.request(path, 'POST', body)['result']
            if result.get('status') == 'complete':
                url = result['result']['signed_url']
                # Signed URLs are credentials: never include them in logs/errors.
                try:
                    with urllib.request.urlopen(url, timeout=90) as response:
                        sql = response.read()
                except Exception:
                    raise RuntimeError('D1 signed export download failed') from None
                break
            if result.get('status') == 'error':
                raise RuntimeError('D1 export failed')
            bookmark = result.get('at_bookmark', bookmark)
            time.sleep(2)
        else:
            raise RuntimeError('D1 export timed out')
        (stage / 'community.sql').write_bytes(sql)
        db = sqlite3.connect(':memory:')
        db.executescript(sql.decode())
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Exported D1 database failed integrity check')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {name: db.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
                  for name in tables}
        expected = set()
        if 'versions' in tables:
            expected.update('packs/' + row[0] + '.json' for row in db.execute('SELECT sha256 FROM versions'))
        if 'ticket_attachments' in tables:
            expected.update('support/' + row[0] for row in db.execute('SELECT id FROM ticket_attachments'))
        # Downloads failing because of concurrent deletion fail the whole snapshot.
        # Do not publish success with a missing ticket attachment or pack.
        for obj in self.objects(self.config['source_bucket']):
            key = obj['key']
            if key not in inventory:
                download(obj)
            elif inventory[key].get('etag') != obj.get('etag'):
                # Preserve the first copy; mark mutable objects for review instead
                # of claiming a point-in-time snapshot of a changing object.
                raise RuntimeError('R2 object changed during capture; retry snapshot')
        missing = expected - inventory.keys()
        if missing:
            raise RuntimeError(f'{len(missing)} D1-referenced R2 objects are missing')
        for key in expected:
            if key.startswith('packs/') and inventory[key]['sha256'] != key[6:-5]:
                raise RuntimeError('Community pack content hash mismatch')
        (stage / 'objects.json').write_text(json.dumps(inventory, indent=2))
        (stage / 'd1-validation.json').write_text(json.dumps({'tables': counts,
            'referenced_objects': len(expected), 'captured_objects': len(inventory)}, indent=2))
        workers = self.request('/workers/scripts')['result']
        (stage / 'workers.json').write_text(json.dumps(workers, indent=2))
        # Include the inbound email bridge as well as the community/helpdesk.
        for worker in workers:
            name = worker['id']
            safe_name = hashlib.sha256(name.encode()).hexdigest()
            directory = stage / 'workers' / safe_name
            directory.mkdir(parents=True)
            (directory / 'name.txt').write_text(name)
            path = '/workers/scripts/' + urllib.parse.quote(name, safe='')
            for suffix, filename in [('/settings', 'settings.json'), ('/secrets', 'secret-names.json')]:
                (directory / filename).write_text(json.dumps(self.request(path + suffix), indent=2))
            (directory / 'source.multipart').write_bytes(self.request(path, raw=True))
        zones = self.request('/zones?name=blockworked.com')['result']
        if len(zones) != 1:
            raise RuntimeError('Expected exactly one blockworked.com DNS zone')
        zone = zones[0]['id']
        (stage / 'dns-zone.json').write_text(json.dumps(zones, indent=2))
        records, page = [], 1
        while True:
            response = self.request(f'/zones/{zone}/dns_records?per_page=100&page={page}')
            records.extend(response['result'])
            if page >= response.get('result_info', {}).get('total_pages', 1):
                break
            page += 1
        (stage / 'dns-records.json').write_text(json.dumps(records, indent=2))
        rules, cursor = [], None
        while True:
            query = '?per_page=100' + ('&cursor=' + urllib.parse.quote(cursor) if cursor else '')
            response = self.request(f'/zones/{zone}/email/routing/rules' + query)
            rules.extend(response['result'])
            info = response.get('result_info', {})
            next_cursor = info.get('cursors', {}).get('after')
            if not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor
        (stage / 'email-routing.json').write_text(json.dumps(rules, indent=2))
        (stage / 'email-routing-catchall.json').write_text(json.dumps(
            self.request(f'/zones/{zone}/email/routing/rules/catch_all'), indent=2))

    def snapshot(self):
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
        with tempfile.TemporaryDirectory(prefix='capture-', dir=ROOT) as scratch:
            scratch = Path(scratch)
            stage = scratch / 'snapshot'
            stage.mkdir(mode=0o700)
            self.capture_host(stage)
            self.capture_cloud(stage)
            (stage / 'backup-config.json').write_text(CONFIG.read_text())
            (stage / 'backup.py').write_text(Path(__file__).read_text())
            (stage / 'restore-smoketest.py').write_text(
                Path(__file__).with_name('restore-smoketest.py').read_text())
            files = {str(p.relative_to(stage)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in stage.rglob('*') if p.is_file()}
            (stage / 'checksums.json').write_text(json.dumps(files, indent=2))
            bundle = scratch / 'snapshot.tar'
            with tarfile.open(bundle, 'w') as archive:
                archive.add(stage, arcname='snapshot')
            encrypted = scratch / 'snapshot.tar.gpg'
            command(['gpg', '--batch', '--yes', '--pinentry-mode', 'loopback',
                     '--passphrase-file', self.config['key_file'], '--symmetric',
                     '--cipher-algo', 'AES256', '--compress-algo', 'none',
                     '--output', str(encrypted), str(bundle)], timeout=600)
            prefix = 'snapshots/' + stamp + '/'
            chunks = []
            log('Uploading encrypted snapshot; verifying every chunk by downloading it')
            with encrypted.open('rb') as stream:
                while content := stream.read(CHUNK_SIZE):
                    chunks.append(self.put_verified(prefix + f'part-{len(chunks):05d}.gpg', content))
            manifest = {'format': 1, 'created_at': stamp, 'chunks': chunks,
                        'cipher': 'GnuPG AES256 symmetric', 'key_file_hint': 'recovery-passphrase',
                        'components': ['Mailcow', 'Weblate', 'Blockwork ntfy', 'Cloudflare D1/R2',
                                       'configuration and deployed Worker source'],
                        'limitations': ['Worker secret values must be retained separately.',
                                        'R2/D1 capture validates references; it is not an atomic provider snapshot.']}
            self.put_verified(prefix + 'manifest.json', json.dumps(manifest, indent=2).encode())
            self.put_verified('last-success.json', json.dumps({'manifest': prefix + 'manifest.json',
                              'created_at': stamp}).encode())
            (ROOT / 'last-success.json').write_text(json.dumps(manifest, indent=2))
            log('Backup complete: ' + prefix + 'manifest.json')
            return prefix + 'manifest.json'

    def restore_archive(self, manifest_key, destination):
        manifest = json.loads(self.request(self.object_path(self.bucket, manifest_key), raw=True))
        destination = Path(destination)
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        encrypted = destination / 'snapshot.tar.gpg'
        with encrypted.open('xb') as stream:
            for chunk in manifest['chunks']:
                body = self.request(self.object_path(self.bucket, chunk['key']), raw=True)
                if len(body) != chunk['size'] or hashlib.sha256(body).hexdigest() != chunk['sha256']:
                    raise RuntimeError('Restore chunk verification failed')
                stream.write(body)
        command(['gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase-file',
                 self.config['key_file'], '--output', str(destination / 'snapshot.tar'),
                 '--decrypt', str(encrypted)], timeout=600)
        with tarfile.open(destination / 'snapshot.tar') as archive:
            archive.extractall(destination, filter='data')
        stage = destination / 'snapshot'
        checksums = json.loads((stage / 'checksums.json').read_text())
        for name, expected in checksums.items():
            p = stage / name
            if not p.resolve().is_relative_to(stage.resolve()):
                raise RuntimeError('Invalid manifest path')
            if hashlib.sha256(p.read_bytes()).hexdigest() != expected:
                raise RuntimeError('Restored file checksum mismatch')
        log('Downloaded, decrypted and checksum-verified ' + str(len(checksums)) + ' files')

    def prune(self):
        manifests = [o['key'] for o in self.objects(self.bucket, 'snapshots/')
                     if o['key'].endswith('/manifest.json')]
        keep, days, weeks, months = set(), set(), set(), set()
        for key in sorted(manifests, reverse=True):
            date = dt.datetime.strptime(key.split('/')[1], '%Y-%m-%dT%H-%M-%SZ')
            day, week, month = date.date(), date.isocalendar()[:2], (date.year, date.month)
            for period, seen, count in [(day, days, 14), (week, weeks, 8), (month, months, 12)]:
                if period not in seen and len(seen) < count:
                    keep.add(key)
                    seen.add(period)
        # Only delete snapshots created by this tool with a complete manifest.
        for key in sorted(set(manifests) - keep):
            manifest = json.loads(self.request(self.object_path(self.bucket, key), raw=True))
            prefix = key.removesuffix('manifest.json')
            if manifest.get('format') != 1 or not all(c['key'].startswith(prefix + 'part-')
                                                     for c in manifest['chunks']):
                raise RuntimeError('Refusing retention for an unrecognized manifest')
            self.request(self.object_path(self.bucket, key), 'DELETE', raw=True)
            for chunk in manifest['chunks']:
                self.request(self.object_path(self.bucket, chunk['key']), 'DELETE', raw=True)
        log(f'Retention complete: {len(keep)} snapshots retained')


def main():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--restore', metavar='MANIFEST_KEY')
    parser.add_argument('--destination')
    parser.add_argument('--prune', action='store_true')
    parser.add_argument('--verify-latest', action='store_true')
    args = parser.parse_args()
    backup = Backup()
    if args.resume:
        p = ROOT / 'paused.json'
        if p.exists():
            backup.paused = json.loads(p.read_text())
            backup.resume()
        return
    if args.restore:
        if not args.destination:
            parser.error('--destination is required with --restore')
        backup.restore_archive(args.restore, args.destination)
        return
    with (ROOT / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def interrupted(_signum, _frame):
            raise RuntimeError('Backup interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        try:
            if args.verify_latest:
                latest = json.loads(backup.request(backup.object_path(backup.bucket,
                                    'last-success.json'), raw=True))
                with tempfile.TemporaryDirectory(prefix='verify-', dir=ROOT) as scratch:
                    backup.restore_archive(latest['manifest'], scratch)
                    stage = Path(scratch) / 'snapshot'
                    db = sqlite3.connect(':memory:')
                    db.executescript((stage / 'community.sql').read_text())
                    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Restored D1 integrity check failed')
                    for p in stage.glob('*.tar.gz'):
                        with tarfile.open(p, 'r:gz') as archive:
                            for member in archive:
                                if member.isfile():
                                    stream = archive.extractfile(member)
                                    while stream.read(1024 * 1024):
                                        pass
                    command(['docker', 'run', '--rm', '--network', 'none', '--mount',
                             f'type=bind,source={stage},destination=/restore,readonly',
                             'postgres:18-alpine', 'pg_restore', '--list', '/restore/weblate.dump'])
                    command(['/usr/bin/python3', str(Path(__file__).with_name('restore-smoketest.py')), str(stage)],
                            timeout=600)
                log('Latest off-site backup passed archive, D1 and isolated database restore checks')
            elif args.prune:
                backup.prune()
            else:
                backup.snapshot()
        finally:
            backup.resume()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Subprocess stderr and HTTP URLs can contain secrets. Keep journals terse.
        log('FAILED: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1)
