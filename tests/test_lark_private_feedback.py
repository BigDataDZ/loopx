"""Native state drives presentation; provider receipts never own admission."""
import json
import time

import pytest
from test_chat_ordinary_project import ordinary  # noqa: F401
from test_lark_private_conversations import connect

from loopx.extensions.lark.private_conversations import LarkPrivateConversations


def active(store, row):
    deadline = time.monotonic() + 10
    while store.load_session(row['session_id']).get('active_turn_id') != row['turn_id']:
        assert time.monotonic() < deadline
        time.sleep(.01)


def test_default_feedback_tracks_queue_execution_stop_and_app_isolation(ordinary):  # noqa: F811
    store, runtime, provider, transport = connect(ordinary)
    try:
        slow = provider.event('notes-app', 'feedback_slow', 'wait for interrupt')
        transport.admit('notes-app', slow)
        first = transport.core.pending()[0]
        active(store, first)
        queued = provider.event('notes-app', 'feedback_queued', 'follow-up')
        transport.admit('notes-app', queued)
        transport.reconcile()
        assert ('notes-app', slow['message_id'], 'OnIt') in provider.reaction_creates
        assert ('notes-app', queued['message_id'], 'Get') in provider.reaction_creates
        assert ('notes-app', queued['message_id'], 'OnIt') not in provider.reaction_creates
        assert any(row[1:] == (slow['message_id'], 'OnIt') for row in provider.reactions.values())
        # A new provider instance reuses durable receipts, not in-memory emoji state.
        replay = LarkPrivateConversations(controller=runtime, runtime_root=transport.runtime_root,
                                         runner=provider, cli_bin='lark-cli')
        before = list(provider.reaction_creates)
        replay.admit('notes-app', {**slow, 'event_id': 'replayed'})
        replay.reconcile()
        assert provider.reaction_creates == before
        other = provider.event('steward-app', 'feedback_other', '/status')
        replay.admit('steward-app', other)
        replay.reconcile()
        assert ('steward-app', other['message_id'], 'Get') in provider.reaction_creates
        assert not any(profile == 'steward-app' and ref == slow['message_id']
                       for profile, ref, _ in provider.reaction_creates)
        replay.admit('notes-app', provider.event('notes-app', 'feedback_stop', '/stop'))
        follow = next(row for row in replay.core.pending() if row['message'] == 'follow-up')
        runtime.wait_for_turn(session_id=follow['session_id'], turn_id=follow['turn_id'], timeout_sec=10)
        replay.reconcile()
        assert not any(row[1:] == (slow['message_id'], 'OnIt') for row in provider.reactions.values())
        assert ('notes-app', slow['message_id'], 'Get') in provider.reactions.values()
        assert all(row['goal_id'] is None for row in store.list_sessions())
    finally:
        runtime.close()


def test_terminal_cleanup_recovers_verified_answer_without_resend(ordinary):  # noqa: F811
    store, runtime, provider, transport = connect(ordinary)
    try:
        event = provider.event('notes-app', 'cleanup_slow', 'wait for interrupt')
        transport.admit('notes-app', event)
        row = transport.core.pending()[0]
        active(store, row)
        transport.reconcile()
        transport.admit('notes-app', provider.event('notes-app', 'cleanup_stop', '/stop'))
        runtime.wait_for_turn(session_id=row['session_id'], turn_id=row['turn_id'], timeout_sec=10)
        provider.fail_reaction_delete = True
        transport.reconcile()
        record_path = transport.root / f"{row['request_ref']}.json"
        record = json.loads(record_path.read_text())
        assert record['status'] != 'delivered'
        assert record['deliveries']['terminal']['verified'] is False
        assert record['deliveries']['terminal']['attempt']
        before = list(provider.writes)
        transport.reconcile()
        assert provider.writes == before
        provider.fail_reaction_delete = False
        transport.reconcile()
        assert provider.writes == before
        assert json.loads(record_path.read_text())['status'] == 'delivered'
    finally:
        runtime.close()


@pytest.mark.parametrize('enabled', [False, True])
def test_opt_out_or_missing_reaction_permission_preserves_real_admission(ordinary, enabled):  # noqa: F811
    store, runtime, provider, transport = connect(ordinary)
    transport.reaction_feedback = enabled
    provider.fail_reaction_create = True
    try:
        rejected = provider.event('notes-app', 'wrong_feedback', '/status')
        assert transport.admit('steward-app', rejected)['status'] == 'audience_rejected'
        event = provider.event('notes-app', 'no_scope_feedback', 'plain request')
        assert transport.admit('notes-app', event)['status'] == 'durably_accepted'
        row = transport.core.pending()[0]
        runtime.wait_for_turn(session_id=row['session_id'], turn_id=row['turn_id'], timeout_sec=10)
        assert transport.reconcile() == 1
        assert provider.reaction_creates == []
        assert bool(any('reactions' in call for call in provider.calls)) == enabled
        assert any(text == 'Runtime response.' for _, text in provider.writes)
        assert len(store.list_sessions()) == 1
    finally:
        runtime.close()
