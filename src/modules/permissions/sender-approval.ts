/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval`, which holds through the
 * approvals primitive (action 'sender_admit'):
 *
 *   - approver rule: the agent group's admin chain, plus the specific
 *     admin the card was delivered to (named-or-admin);
 *   - in-flight dedup via the hold's dedup key — a retry / rapid second
 *     message from the same unknown sender is silently dropped (no duplicate
 *     card), replacing the old sender table's UNIQUE(mg, sender);
 *   - the hold is sessionless: there is no agent session to notify, so
 *     failure modes (no approver, no reachable DM, no adapter) log and leave
 *     no row, letting a future attempt retry.
 *   - sender-specific query/continuation fields live in a one-to-one detail
 *     row created atomically with the common lifecycle master.
 *
 * On approve: the 'sender_admit' handler in index.ts adds an
 * agent_group_members row for the sender and re-invokes routeInbound with the
 * stored event — the second routing attempt passes the gate because the user
 * is now a member. On deny: the shared reject path just drops the hold (no
 * denial persistence — a future message re-triggers a fresh card).
 */
import type { RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { requestApproval } from '../approvals/primitive.js';
import { createPendingSenderApprovalDetail } from './db/pending-sender-approval-details.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve', style: 'primary' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject', style: 'danger' },
];

export const SENDER_ADMIT_ACTION = 'sender_admit';

export function senderAdmitDedupKey(messagingGroupId: string, senderIdentity: string): string {
  return `${SENDER_ADMIT_ACTION}:${messagingGroupId}:${senderIdentity}`;
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // namespaced user id (channel_type:handle)
  senderName: string | null;
  event: InboundEvent;
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  const originMg = getMessagingGroup(messagingGroupId);
  const senderDisplay = senderName && senderName.length > 0 ? senderName : senderIdentity;
  const originName = originMg?.name ?? `a ${originMg?.channel_type ?? ''} channel`;

  await requestApproval({
    agentGroupId,
    agentName: senderDisplay,
    action: SENDER_ADMIT_ACTION,
    payload: { messagingGroupId, agentGroupId, senderIdentity, senderName, event },
    title: '👤 New sender',
    question: `${senderDisplay} wants to talk to your agent in ${originName}. Allow?`,
    options: APPROVAL_OPTIONS,
    dedupKey: senderAdmitDedupKey(messagingGroupId, senderIdentity),
    recordDeliveredApprover: true,
    originChannelType: originMg?.channel_type ?? '',
    persistDetails: (approvalId) =>
      createPendingSenderApprovalDetail({
        approval_id: approvalId,
        messaging_group_id: messagingGroupId,
        sender_identity: senderIdentity,
        sender_name: senderName,
        original_message: JSON.stringify(event),
      }),
  });
}
