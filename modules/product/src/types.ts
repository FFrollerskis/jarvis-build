/**
 * UA-3 Native Jarvis Product Core (D-128). Jarvis EIER selv produkt-
 * tilbakemeldings-/roadmap-domenemodellen (JARVIS_CANONICAL, D-64 Core-vs-
 * Adapter-porten kjørt FØRST - se DECISIONS_AND_ASSUMPTIONS.md D-128). ZERO
 * leverandør-spesifikke felter her - et fremtidig eksternt issue-tracker-
 * verktøy er en VALGFRI, senere adapter, aldri domeneeier. "Smallest
 * complete": kun det som faktisk kreves for
 * lifecycle/prioritering/rapportør-kobling - ingen produkt-analytics-
 * plattform-kompleksitet uten reelt behov.
 */

export type ProductItemType = "feature_request" | "bug_report" | "usage_feedback" | "improvement";
export type ProductItemStatus = "new" | "triaged" | "planned" | "in_progress" | "shipped" | "declined" | "closed";
export type ProductItemPriority = "low" | "normal" | "high" | "critical";

export type ProductItemEventType =
  | "item_created"
  | "status_changed"
  | "priority_changed"
  | "owner_changed"
  | "reporter_linked";

export interface ProductItem {
  item_id: string;
  item_number: string;
  tenant_id: string;
  memory_space_id: string;
  company_id: string | null;
  contact_id: string | null;
  title: string;
  description: string | null;
  item_type: ProductItemType;
  status: ProductItemStatus;
  priority: ProductItemPriority;
  owner_person_id: string | null;
  source_type: string;
  source_instance_id: string | null;
  source_message_id: string | null;
  canonical_uri: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ProductItemEvent {
  event_id: string;
  tenant_id: string;
  memory_space_id: string;
  item_id: string;
  event_type: ProductItemEventType;
  summary: string;
  actor_person_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export interface CreateProductItemInput {
  title: string;
  description?: string;
  item_type?: ProductItemType;
  priority?: ProductItemPriority;
  company_id?: string;
  contact_id?: string;
  owner_person_id?: string;
  source_type?: string;
  source_instance_id?: string;
  source_message_id?: string;
  canonical_uri?: string;
  actor_person_id?: string;
}
