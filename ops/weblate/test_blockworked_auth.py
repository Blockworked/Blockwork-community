"""Run with Django and DRF installed: python -m unittest discover -s ops/weblate."""
import base64
import hashlib
import hmac
import json
import sys
import time
import types
import unittest
from unittest.mock import MagicMock, patch

from django.conf import settings
if not settings.configured:
    settings.configure(
        SECRET_KEY='tests', DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
        BLOCKWORKED_SHARED_SECRET='s' * 64, BLOCKWORKED_COMPONENTS=['blockwork/ui'], BLOCKWORKED_TRANSLATOR_GROUP_ID=7,
    )
import django
django.setup()
from django.core.cache import cache
from rest_framework.exceptions import AuthenticationFailed
from blockworked_auth import verify, SignedBlockworkedAuthentication

SECRET = 's' * 64
BODY = b'{"target":["Hallo"],"state":20}'

def signed(body=BODY, method='PATCH', path='/api/units/42/', timestamp=None):
    identity = base64.urlsafe_b64encode(json.dumps({'id':'local:translator-1','name':'Translator 🌍'},ensure_ascii=False,separators=(',', ':')).encode()).decode().rstrip('=')
    headers = {'X-Blockworked-Time': str(timestamp or int(time.time())), 'X-Blockworked-Nonce': '12345678-1234-1234-1234-123456789abc', 'X-Blockworked-Identity': identity}
    canonical = '\n'.join([headers['X-Blockworked-Time'],headers['X-Blockworked-Nonce'],identity,method,path,hashlib.sha256(body).hexdigest()])
    headers['X-Blockworked-Signature'] = hmac.new(SECRET.encode(),canonical.encode(),hashlib.sha256).hexdigest()
    return headers

class ProtocolTests(unittest.TestCase):
    def test_valid_unicode_identity(self):
        data, nonce = verify(signed(), 'PATCH', '/api/units/42/', BODY, SECRET)
        self.assertEqual(data, {'id':'local:translator-1','name':'Translator 🌍'})

    def test_tampering_expiration_and_endpoint_scope(self):
        for change in ('body','identity','method','path','query','expired','secret'):
            headers = signed(timestamp=int(time.time()) - 90) if change == 'expired' else signed()
            if change == 'identity': headers['X-Blockworked-Identity'] += 'a'
            with self.subTest(change=change), self.assertRaises(AuthenticationFailed):
                verify(headers, 'POST' if change == 'method' else 'PATCH', '/api/users/' if change == 'path' else '/api/units/42/?q=private' if change == 'query' else '/api/units/42/', b'changed' if change == 'body' else BODY, 'weak' if change == 'secret' else SECRET)

    def test_signed_admin_request_still_rejected(self):
        with self.assertRaises(AuthenticationFailed):
            verify(signed(path='/api/users/'), 'PATCH', '/api/users/', BODY, SECRET)

class AdapterTests(unittest.TestCase):
    def setUp(self):
        cache.clear()
        self.user = MagicMock()
        self.user.email = hashlib.sha256(b'local:translator-1').hexdigest() + '@accounts.blockworked.invalid'
        self.user.is_active = True
        self.user.is_superuser = False
        self.user.has_usable_password.return_value = False
        self.user.full_name = 'Translator 🌍'
        self.user.groups.filter.return_value.exists.return_value = True
        self.users = MagicMock()
        self.users.objects.get_or_create.return_value = (self.user, False)
        self.groups = MagicMock()
        self.groups.objects.filter.return_value.first.return_value = types.SimpleNamespace(pk=7)
        self.units = MagicMock()
        self.unit = types.SimpleNamespace(translation=types.SimpleNamespace(component=types.SimpleNamespace(slug='ui',project=types.SimpleNamespace(slug='blockwork'))))
        self.units.objects.select_related.return_value.filter.return_value.first.return_value = self.unit
        self.origin = MagicMock()
        auth = types.ModuleType('weblate.auth.models'); auth.User = self.users; auth.Group = self.groups
        trans = types.ModuleType('weblate.trans.models'); trans.Unit = self.units
        change = types.ModuleType('weblate.utils.change_origin'); change.change_origin = self.origin; change.set_acting_user = MagicMock()
        self.modules = patch.dict(sys.modules, {'weblate.auth.models':auth,'weblate.trans.models':trans,'weblate.utils.change_origin':change})
        self.modules.start()
        self.request = types.SimpleNamespace(headers=signed(), method='PATCH', path='/api/units/42/', get_full_path=lambda:'/api/units/42/',body=BODY,data=json.loads(BODY))
        self.adapter = SignedBlockworkedAuthentication()

    def tearDown(self):
        self.modules.stop()

    def test_individual_account_and_replay(self):
        self.assertEqual(self.adapter.authenticate(self.request), (self.user,None))
        username = self.users.objects.get_or_create.call_args.kwargs['username']
        self.assertTrue(username.startswith('bw_'))
        self.origin.set.assert_called_once_with({'scope':'api'})
        with self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)

    def test_older_weblate_without_change_origin_uses_request_user(self):
        with patch.dict(sys.modules, {'weblate.utils.change_origin': None}):
            self.assertEqual(self.adapter.authenticate(self.request), (self.user, None))

    def test_foreign_component_is_rejected_before_account_creation(self):
        self.unit.translation.component.project.slug = 'private'
        with self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)
        self.users.objects.get_or_create.assert_not_called()

    def test_approval_and_arbitrary_fields_rejected(self):
        for data in ({'target':['Hallo'],'state':30},{'target':['Hallo'],'state':20,'explanation':'changed'}):
            cache.clear()
            self.request.data = data
            self.request.body = json.dumps(data).encode()
            self.request.headers = signed(body=self.request.body)
            with self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)
        self.users.objects.get_or_create.assert_not_called()

    def use(self, method, path, data):
        cache.clear()
        body = json.dumps(data).encode()
        self.request = types.SimpleNamespace(headers=signed(body=body, method=method, path=path), method=method, path=path, get_full_path=lambda: path, body=body, data=data)

    def test_needs_editing_suggestions_and_comments_are_allowed(self):
        for method, path, data in (('PATCH', '/api/units/42/', {'target':['Hallo'],'state':10}),
                                   ('POST', '/api/units/42/suggestions/', {'target':['Hallo']}),
                                   ('POST', '/api/units/42/comments/', {'scope':'report','comment':'Typo in the English'})):
            self.use(method, path, data)
            with self.subTest(path=path, data=data):
                self.assertEqual(self.adapter.authenticate(self.request), (self.user, None))

    def test_other_writes_on_suggestions_and_comments_are_rejected(self):
        for method, path, data in (('POST', '/api/units/42/suggestions/', {'target':['Hallo'],'state':20}),
                                   ('POST', '/api/units/42/suggestions/', {'target':[]}),
                                   ('POST', '/api/units/42/comments/', {'scope':'global','comment':'x','user_email':'a@b.c'}),
                                   ('POST', '/api/units/42/comments/', {'scope':'admin','comment':'x'}),
                                   ('POST', '/api/units/42/comments/', {'scope':'global','comment':'x' * 1001}),
                                   ('PATCH', '/api/units/42/suggestions/', {'target':['Hallo']}),
                                   ('POST', '/api/suggestions/9/accept/', {'target':['Hallo']}),
                                   ('POST', '/api/units/42/', {'target':['Hallo'],'state':20})):
            self.use(method, path, data)
            with self.subTest(method=method, path=path, data=data), self.assertRaises(AuthenticationFailed):
                self.adapter.authenticate(self.request)
        self.users.objects.get_or_create.assert_not_called()

    def test_disabled_or_colliding_accounts_cannot_authenticate(self):
        for field, value in (('is_active',False),('is_superuser',True),('email','someone@example.com')):
            cache.clear()
            old = getattr(self.user,field); setattr(self.user,field,value)
            with self.subTest(field=field), self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)
            setattr(self.user,field,old)
        cache.clear(); self.user.has_usable_password.return_value = True
        with self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)
        cache.clear(); self.user.has_usable_password.return_value = False; self.user.groups.filter.return_value.exists.return_value = False
        with self.assertRaises(AuthenticationFailed): self.adapter.authenticate(self.request)

    def test_new_accounts_get_no_password_and_only_configured_group(self):
        self.users.objects.get_or_create.return_value = (self.user,True)
        self.adapter.authenticate(self.request)
        self.user.set_unusable_password.assert_called_once()
        self.user.groups.set.assert_called_once_with([self.groups.objects.filter.return_value.first.return_value])

if __name__ == '__main__': unittest.main()
