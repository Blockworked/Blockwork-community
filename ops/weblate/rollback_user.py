"""Undo what one Blockworked contributor did on Weblate since a time.

Run inside the Weblate container, as a Weblate admin:

    weblate shell -c "exec(open('/app/data/rollback_user.py').read())" -- \
        bw_<32 hex> 2026-11-17T00:00:00Z [--apply]

The Blockworked account page under /admin/users/<id> shows the bw_ name.
Without --apply it only lists what it would do. With it, it blocks the
contributor (the auth bridge refuses inactive users), puts every string they
changed back to the text before their first change in the window, and deletes
their suggestions and comments since then. A string someone else changed
afterwards is left alone and listed.
"""
import sys
from datetime import datetime

from django.db import transaction
from weblate.auth.models import User
from weblate.trans.models import Change, Comment, Suggestion

args = [a for a in sys.argv[1:] if a != "--"]
if len(args) < 2:
    raise SystemExit("usage: rollback_user.py <weblate username> <ISO time> [--apply]")
username, since_text = args[0], args[1]
apply = "--apply" in args
since = datetime.fromisoformat(since_text.replace("Z", "+00:00"))
user = User.objects.get(username=username)
if not username.startswith("bw_"):
    raise SystemExit("Only Blockworked contributors (bw_...) are rolled back by this script.")

changes = Change.objects.filter(user=user, timestamp__gte=since, unit__isnull=False).order_by("timestamp")
first = {}
for change in changes:
    first.setdefault(change.unit_id, change)

reverted, skipped = [], []
for unit_id, change in first.items():
    unit = change.unit
    later = Change.objects.filter(unit=unit, timestamp__gt=change.timestamp).exclude(user=user).exists()
    if later:
        skipped.append(unit)
        continue
    reverted.append((unit, change.old))

suggestions = Suggestion.objects.filter(user=user, timestamp__gte=since)
comments = Comment.objects.filter(user=user, timestamp__gte=since)

print(f"{username}: {len(reverted)} strings to put back, {len(skipped)} changed by others since, "
      f"{suggestions.count()} suggestions, {comments.count()} comments")
for unit in skipped:
    print(f"  left alone (edited since): unit {unit.pk} {unit.translation}")

if apply:
    admin = User.objects.filter(is_superuser=True).order_by("pk").first()
    with transaction.atomic():
        user.is_active = False
        user.save(update_fields=["is_active"])
        for unit, old in reverted:
            # STATE_EMPTY when the string had no translation before.
            unit.translate(admin, old.split("\x1e\x1e") if old else [""] * len(unit.get_target_plurals()), 20 if old else 0,
                           change_action=Change.ACTION_REVERT)
        suggestions.delete()
        comments.delete()
    print("Done. The contributor is blocked; set is_active back in Weblate's admin to unblock.")
else:
    print("Dry run. Add --apply to do it.")
