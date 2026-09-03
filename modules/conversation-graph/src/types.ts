/**
 * UA-7 Communications Hub - foerste slice (D-119): Conversation Graph +
 * confidence-basert, reversibel identitetsopploesning. Se
 * `046_conversation_graph.sql` for full arkitekturbegrunnelse
 * (D-64 Core-vs-Adapter, reuse-audit).
 */

export type ConversationIdentityStatus = "active" | "merged";
export type ConversationChannel = "email" | "telegram";
export type ChannelLinkStatus = "active" | "revoked";
export type ChannelLinkMatchMethod = "exact_email" | "owner_configured" | "manual";
export type MergeAction = "merge" | "split";
export type MergePerformedBy = "owner" | "deterministic_rule";

export interface ConversationIdentity {
  identity_id: string;
  tenant_id: string;
  memory_space_id: string;
  display_name: string | null;
  linked_business_contact_id: string | null;
  linked_person_id: string | null;
  status: ConversationIdentityStatus;
  merged_into_identity_id: string | null;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationChannelLink {
  link_id: string;
  tenant_id: string;
  memory_space_id: string;
  identity_id: string;
  channel: ConversationChannel;
  channel_identifier: string;
  confidence: number;
  match_method: ChannelLinkMatchMethod;
  source_type: string | null;
  source_instance_id: string | null;
  external_id: string | null;
  status: ChannelLinkStatus;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ConversationIdentityMerge {
  merge_id: string;
  tenant_id: string;
  memory_space_id: string;
  action: MergeAction;
  source_identity_id: string;
  target_identity_id: string;
  reverses_merge_id: string | null;
  affected_link_ids: string[];
  confidence: number;
  reason: string;
  performed_by: MergePerformedBy;
  created_by_person_id: string | null;
  created_at: string;
}

export interface LinkChannelIdentityInput {
  identity_id?: string;
  channel: ConversationChannel;
  channel_identifier: string;
  confidence: number;
  match_method: ChannelLinkMatchMethod;
  source_type?: string;
  source_instance_id?: string;
  external_id?: string;
  display_name?: string;
  linked_business_contact_id?: string;
  linked_person_id?: string;
  created_by_person_id?: string;
}

export interface MergeIdentitiesInput {
  source_identity_id: string;
  target_identity_id: string;
  confidence: number;
  reason: string;
  performed_by: MergePerformedBy;
  created_by_person_id?: string;
}

export interface SplitMergeInput {
  merge_id: string;
  performed_by: MergePerformedBy;
  reason: string;
  created_by_person_id?: string;
}

export interface CrossChannelCommitment {
  followup_id: string;
  title: string;
  reason: string | null;
  next_action: string | null;
  due_at: string;
  priority: "low" | "normal" | "high";
  status: "open" | "completed" | "cancelled";
}

export interface IdentityTimelineEntry {
  activity_id: string;
  activity_type: string;
  summary: string;
  canonical_uri: string | null;
  occurred_at: string;
}
