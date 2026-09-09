/**
 * UA-3 Native Jarvis Operations Core (D-129). Jarvis EIER selv den
 * kanoniske business-operations-domenemodellen (JARVIS_CANONICAL, D-64
 * Core-vs-Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md
 * D-129). Masterplan §13: "Operations - Tasks, owners, deadlines,
 * suppliers, runbooks, escalations". ZERO leverandør-spesifikke felter her
 * - et fremtidig eksternt driftsverktøy er en VALGFRI, senere adapter,
 * aldri domeneeier.
 */

export type VendorCategory = "general" | "it" | "facilities" | "logistics" | "professional_services" | "other";
export type VendorStatus = "active" | "inactive";

export interface OperationsVendor {
  vendor_id: string;
  vendor_number: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  name: string;
  category: VendorCategory;
  status: VendorStatus;
  escalation_contact_person_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateVendorInput {
  name: string;
  category?: VendorCategory;
  company_id?: string;
  contact_id?: string;
  escalation_contact_person_id?: string;
  notes?: string;
}

export type RunbookCategory = "general" | "vendor_escalation" | "incident_response" | "onboarding" | "offboarding" | "maintenance";

export interface OperationsRunbook {
  runbook_id: string;
  runbook_number: string;
  tenant_id: string;
  memory_space_id: string;
  vendor_id: string | null;
  title: string;
  category: RunbookCategory;
  content: string;
  is_active: boolean;
  owner_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRunbookInput {
  title: string;
  content: string;
  category?: RunbookCategory;
  vendor_id?: string;
  owner_person_id?: string;
}

export type OperationsTaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type OperationsTaskPriority = "low" | "normal" | "high" | "critical";

export type OperationsTaskEventType =
  | "task_created"
  | "status_changed"
  | "priority_changed"
  | "owner_changed"
  | "due_at_changed"
  | "vendor_linked"
  | "runbook_linked"
  | "escalated";

export interface OperationsTask {
  task_id: string;
  task_number: string;
  tenant_id: string;
  memory_space_id: string;
  vendor_id: string | null;
  runbook_id: string | null;
  title: string;
  description: string | null;
  status: OperationsTaskStatus;
  priority: OperationsTaskPriority;
  owner_person_id: string | null;
  due_at: string | null;
  escalation_level: number;
  escalated_at: string | null;
  escalated_to_person_id: string | null;
  source_type: string;
  source_instance_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CreateOperationsTaskInput {
  title: string;
  description?: string;
  priority?: OperationsTaskPriority;
  vendor_id?: string;
  runbook_id?: string;
  owner_person_id?: string;
  due_at?: string;
  source_type?: string;
  source_instance_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  actor_person_id?: string;
}

export interface OperationsTaskEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  task_id: string;
  event_type: OperationsTaskEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}
