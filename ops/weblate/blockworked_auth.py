"""Narrow signed authentication for the Blockworked contributor UI.

Install alongside Weblate, add SignedBlockworkedAuthentication BEFORE existing
REST_FRAMEWORK authentication classes. See docs/translations.md. Only a
translation edit, a new suggestion or vote, and a comment can be signed: no
browser session, token issuing, admin, source edit, approval or suggestion
acceptance endpoint can be reached using this authenticator.
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


# The only writes the contributor UI makes: a translation edit, a suggestion
# (posting an existing one again is Weblate's vote) and a comment.
ENDPOINTS = (
    ('PATCH', re.compile(r'/api/units/([1-9][0-9]*)/')),
    ('POST', re.compile(r'/api/units/([1-9][0-9]*)/suggestions/')),
    ('POST', re.compile(r'/api/units/([1-9][0-9]*)/comments/')),
)


def allowed_endpoint(method, path):
    """The unit id for an allowed method and exact path, else None."""
    for allowed, pattern in ENDPOINTS:
        match = pattern.fullmatch(path)
        if method == allowed and match:
            return int(match.group(1))
    return None


def valid_payload(path, data):
    """Accept only the fields each endpoint needs; never approval or other serializer fields."""
    if not isinstance(data, dict):
        return False
    target_ok = isinstance(data.get('target'), list) and bool(data['target']) and all(isinstance(v, str) for v in data['target'])
    if path.endswith('/suggestions/'):
        return set(data) == {'target'} and target_ok
    if path.endswith('/comments/'):
        return (set(data) == {'scope', 'comment'} and data['scope'] in ('translation', 'global', 'report')
                and isinstance(data['comment'], str) and 1 <= len(data['comment']) <= 1000)
    # Translated (20) or needs editing (10).
    return set(data) == {'target', 'state'} and data['state'] in (10, 20) and target_ok


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
            or not allowed_endpoint(method, path)
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
        unit_id = allowed_endpoint(request.method, request.path)
        allowed = getattr(settings, 'BLOCKWORKED_COMPONENTS', [])
        unit = Unit.objects.select_related('translation__component__project').filter(pk=unit_id).first()
        if unit is None:
            raise AuthenticationFailed('Translation not available')
        component = unit.translation.component
        if f'{component.project.slug}/{component.slug}' not in allowed:
            raise AuthenticationFailed('Translation not available')
        if not valid_payload(request.path, request.data):
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
