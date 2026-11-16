"""Narrow signed authentication for the Blockworked contributor UI.

Install alongside Weblate, add SignedBlockworkedAuthentication BEFORE existing
REST_FRAMEWORK authentication classes. See docs/translations.md. No browser
session, token issuing, admin, source edit, or suggestion acceptance endpoints
can be reached using this authenticator.
"""
import base64
import hashlib
import hmac
import json
import re
import time

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed


def verify(headers, method, path, body, secret, now=None):
    """Validate the exact wire representation before parsing identity data."""
    timestamp = headers.get('X-Blockworked-Time', '')
    nonce = headers.get('X-Blockworked-Nonce', '')
    identity = headers.get('X-Blockworked-Identity', '')
    signature = headers.get('X-Blockworked-Signature', '')
    now = time.time() if now is None else now
    if (len(secret) < 32 or not re.fullmatch(r'[0-9]{10,11}', timestamp)
            or abs(now - int(timestamp)) > 60
            or not re.fullmatch(r'[a-f0-9-]{36}', nonce)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,2048}', identity)
            or not re.fullmatch(r'[a-f0-9]{64}', signature)
            or method != 'PATCH' or not re.fullmatch(r'/api/units/[1-9][0-9]*/', path)
            or len(body) > 100000):
        raise AuthenticationFailed('Invalid Blockworked request')
    canonical = '\n'.join([timestamp, nonce, identity, method, path, hashlib.sha256(body).hexdigest()])
    expected = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise AuthenticationFailed('Invalid Blockworked signature')
    try:
        data = json.loads(base64.urlsafe_b64decode(identity + '=' * (-len(identity) % 4)))
        if (not isinstance(data, dict) or not isinstance(data.get('id'), str)
                or not 1 <= len(data['id']) <= 200 or not isinstance(data.get('name'), str)
                or not 1 <= len(data['name']) <= 150):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise AuthenticationFailed('Invalid Blockworked identity') from None
    return data, nonce


class SignedBlockworkedAuthentication(BaseAuthentication):
    def authenticate_header(self, request):
        return 'Blockworked'

    def authenticate(self, request):
        if not request.headers.get('X-Blockworked-Signature'):
            return None
        # Imports stay here so protocol tests can run without a Weblate install.
        from weblate.auth.models import Group, User
        from weblate.trans.models import Unit

        identity, nonce = verify(request.headers, request.method, request.get_full_path(),
                                 request.body, getattr(settings, 'BLOCKWORKED_SHARED_SECRET', ''))
        if not cache.add('blockworked-request:' + nonce, True, timeout=125):
            raise AuthenticationFailed('Blockworked request already used')
        unit_id = int(request.path.rstrip('/').split('/')[-1])
        allowed = getattr(settings, 'BLOCKWORKED_COMPONENTS', [])
        unit = Unit.objects.select_related('translation__component__project').filter(pk=unit_id).first()
        if unit is None:
            raise AuthenticationFailed('Translation not available')
        component = unit.translation.component
        if f'{component.project.slug}/{component.slug}' not in allowed:
            raise AuthenticationFailed('Translation not available')
        # Accept only translation edits; never approval or arbitrary serializer fields.
        data = request.data
        if (not isinstance(data, dict) or set(data) != {'target', 'state'} or data['state'] != 20
                or not isinstance(data['target'], list)
                or not all(isinstance(value, str) for value in data['target'])):
            raise AuthenticationFailed('Invalid translation edit')
        group = Group.objects.filter(pk=getattr(settings, 'BLOCKWORKED_TRANSLATOR_GROUP_ID', None)).first()
        if group is None:
            raise AuthenticationFailed('Blockworked translators are not configured')
        digest = hashlib.sha256(identity['id'].encode()).hexdigest()
        username = 'bw_' + digest[:32]
        email = digest + '@accounts.blockworked.invalid'
        with transaction.atomic():
            user, created = User.objects.get_or_create(username=username, defaults={
                'email': email, 'full_name': identity['name'], 'is_active': True,
            })
            if created:
                user.set_unusable_password()
                user.save(update_fields=['password'])
                # New users may inherit Weblate auto-groups; retain only the UI team.
                user.groups.set([group])
            if (user.email != email or user.has_usable_password() or not user.is_active
                    or user.is_superuser or not user.groups.filter(pk=group.pk).exists()):
                raise AuthenticationFailed('Blockworked contributor is disabled')
            if user.full_name != identity['name']:
                user.full_name = identity['name']
                user.save(update_fields=['full_name'])
        # Older Weblate releases attribute changes through request.user directly.
        try:
            from weblate.utils.change_origin import change_origin, set_acting_user
        except ModuleNotFoundError as error:
            if error.name != 'weblate.utils.change_origin':
                raise
        else:
            change_origin.set({'scope': 'api'})
            set_acting_user(user)
        return user, None
