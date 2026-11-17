#!/usr/bin/env python3
"""Create the Weblate project for the two Blockworked sites and wire it up.

Makes project `blockworked` with components `website` (Blockworked/blockworked.com,
locales/website.pot) and `community` (Blockworked/Blockwork-community-blocks,
locales/community.pot), copying the repository push settings from blockwork/ui,
adds the msgmerge add-on so each .po follows its template, turns on suggestion
voting, and gives the contributor team Translate and the reader team View on the
new project. Safe to run again: whatever already exists is left as it is.

    WEBLATE_URL=https://weblate.blockworked.com WEBLATE_ADMIN_TOKEN=... \\
      python3 ops/weblate/setup_site_projects.py --translators 8 --reader 9

The admin token is used only for this run; never store it in the Worker.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

PROJECT = {'name': 'Blockworked sites', 'slug': 'blockworked', 'web': 'https://blockworked.com/'}
COMPONENTS = [
    {'name': 'blockworked.com', 'slug': 'website', 'repo': 'https://github.com/Blockworked/blockworked.com.git',
     'template': 'locales/website.pot'},
    {'name': 'Community site', 'slug': 'community', 'repo': 'https://github.com/Blockworked/Blockwork-community-blocks.git',
     'template': 'locales/community.pot'},
]
# Repository settings taken from the app's component so the sites push the same way.
COPIED = ('vcs', 'push_branch', 'merge_style', 'commit_message', 'add_message', 'delete_message',
          'merge_message', 'addon_message', 'license', 'license_url', 'agreement')


def call(base, token, method, path, body=None):
    request = urllib.request.Request(base + path, method=method, headers={
        'Authorization': f'Token {token}', 'Accept': 'application/json',
        'Content-Type': 'application/json', 'User-Agent': 'Blockworked-setup/1',
    }, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors='replace')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--translators', type=int, required=True, help='Blockworked translators team ID')
    parser.add_argument('--reader', type=int, required=True, help='read-only Worker team ID')
    parser.add_argument('--branch', default='master')
    args = parser.parse_args()
    base = os.environ.get('WEBLATE_URL', '').rstrip('/')
    token = os.environ.get('WEBLATE_ADMIN_TOKEN', '')
    if not base.startswith('https://') or not token:
        sys.exit('Set WEBLATE_URL (https) and WEBLATE_ADMIN_TOKEN.')

    status, app = call(base, token, 'GET', '/api/components/blockwork/ui/')
    if status != 200:
        sys.exit(f'Could not read blockwork/ui ({status}): {app}')
    copied = {key: app[key] for key in COPIED if app.get(key) not in (None, '')}

    status, body = call(base, token, 'GET', f"/api/projects/{PROJECT['slug']}/")
    if status == 404:
        status, body = call(base, token, 'POST', '/api/projects/', PROJECT)
        if status not in (200, 201):
            sys.exit(f'Could not create the project ({status}): {body}')
        print('created project', PROJECT['slug'])
    project_id = body['id']

    for component in COMPONENTS:
        path = f"/api/components/{PROJECT['slug']}/{component['slug']}/"
        status, body = call(base, token, 'GET', path)
        if status == 404:
            status, body = call(base, token, 'POST', f"/api/projects/{PROJECT['slug']}/components/", {
                **copied, 'name': component['name'], 'slug': component['slug'],
                'repo': component['repo'], 'branch': args.branch,
                'file_format': 'po', 'filemask': 'locales/*.po', 'template': '',
                'new_base': component['template'], 'new_lang': 'add',
                'source_language': {'code': 'en'},
            })
            if status not in (200, 201):
                sys.exit(f"Could not create {component['slug']} ({status}): {body}")
            print('created component', component['slug'])
        status, addons = call(base, token, 'GET', path + 'addons/')
        names = {a.get('name') for a in (addons or {}).get('results', [])} if status == 200 else set()
        if 'weblate.gettext.msgmerge' not in names:
            status, body = call(base, token, 'POST', path + 'addons/', {'name': 'weblate.gettext.msgmerge'})
            print('msgmerge add-on', component['slug'], status)

    # The translate site's vote button posts the same suggestion again, which Weblate counts
    # only while voting is on; autoaccept stays 0 so votes never replace a translation by themselves.
    for path in ['/api/components/blockwork/ui/'] + [f"/api/components/{PROJECT['slug']}/{c['slug']}/" for c in COMPONENTS]:
        status, body = call(base, token, 'PATCH', path, {'suggestion_voting': True})
        print('suggestion voting', path, status)

    for team in (args.translators, args.reader):
        status, body = call(base, token, 'POST', f'/api/groups/{team}/projects/', {'project_id': project_id})
        print('team', team, 'gets project', PROJECT['slug'], status)
    print('Now add', ', '.join(f"{PROJECT['slug']}/{c['slug']}" for c in COMPONENTS),
          'to BLOCKWORKED_COMPONENTS on Weblate and WEBLATE_COMPONENTS in wrangler.toml.')


if __name__ == '__main__':
    main()
