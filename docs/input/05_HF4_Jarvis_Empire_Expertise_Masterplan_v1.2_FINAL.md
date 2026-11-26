# Jarvis masterplan HF4 - Jarvis Empire + Expertise Masterplan v1.2 FINAL (tekstkonvertering)

> Konvertert automatisk fra `HF4_Jarvis_Empire_Expertise_Masterplan_v1.2_FINAL.pdf` (`pdftotext -layout`; én fenced blokk per side, sidemarkører beholdt som i
> `02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`). **PDF-en er originalkilden ved tvil** om formatering, tabeller og sidetall:
> `docs/input/pdf/HF4_Jarvis_Empire_Expertise_Masterplan_v1.2_FINAL.pdf`. Teksten er ikke redigert. Dokumentstatus (mottatt som input 2026-11-26, ikke formelt adoptert; ingenting her er et krav
> før eieren har truffet en navngitt D-beslutning, ADR-001 §2.1) og hvilken fil som er hvilken plan: `docs/input/README.md`.

---

<!-- side 1 -->

```text
                                      JARVIS // EMPIRE + EXPERTISE MASTERPLAN




                                             JARVIS
                            EMPIRE + EXPERTISE
                                         MASTERPLAN v1.2

 One Empire experience. Hard legal isolation. Expert intelligence treated as a hostile
                                  trust surface.

                                            Owner architecture blueprint
                                                  13 August 2026

Core decision
Version 1.2 keeps v1.1's anti-duplication architecture, but hardens the two mechanisms v1.1 actually introduces:
Empire Session Grants and Expert Packs. Security tier governance, revocation, replay resistance, prompt-injection
containment, provenance purity, external eval anchors, source rights, cost ownership, aggregate-cache isolation,
dependency gates, expert recall and freshness degradation are now binding parts of the design.




                                    Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 2 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


01

Executive summary
The architecture stays small; the new trust surfaces become explicit, revocable and testable.
Version 1.2 preserves the v1.1 authority model: Multi-Company (MC) owns identity, tenancy, company boundaries and
authority; Empire is an owner-facing UX/session layer; Evolution (EV) owns research/evaluation/freshness
infrastructure; UA owns runtime and Context Builder foundations; Expertise (EX) owns expert schemas, routing,
provenance and expert-specific policy.

 Target state
 Tobias can unlock an Empire and move seamlessly between authorized companies only when deterministic tier
 policy says the risk is equivalent. A live Empire grant is invalidated immediately when memberships, tiers, policies,
 devices or entity state change. Expert packs are loaded as typed knowledge data, never as trusted instructions, and
 can be recalled if later found wrong or poisoned.


Layer                                                           Authoritative responsibility

                                                                Identity, legal entities, memberships, Company Lock, tier governance,
MC
                                                                revocation, credentials, isolation, portfolio authorization.

                                                                Thin owner umbrella, dashboard, switcher, same-tier navigation
Empire UX
                                                                grant and derived aggregate display.

                                                                Research swarm, Evaluation Lab, freshness engine, shared cost
EV
                                                                controls and dependency interfaces.

                                                                Context Builder, model/tool runtime, workers, Policy Gateway and
UA / Core
                                                                capability enforcement.

                                                                Expert registry, routing, typed packs, provenance/rights, injection
EX
                                                                controls, expert eval suites, recall and Expert Library.


The design principle is unchanged: remove duplicate systems. The security principle is stronger: every new convenience
or reusable knowledge object is treated as a potentially compromised derived artifact and must be bounded by
authoritative state.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 3 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


02

Authority map, anti-duplication and dependency contracts
Reuse is mandatory, but reuse is not assumed until the dependency is verified.

Capability                               Authority                                           v1.2 rule

Authentication / device identity         MC identity adapter                                 No Empire identity service.

Org / legal-entity authorization         MC tenancy + Policy Gateway                         Every action re-resolves exact company scope.

                                                                                             Tier and revocation state are authoritative,
Security tier / grant revocation         MC Company Lock / Authority Plane
                                                                                             deterministic policy.

Connections / credentials                MC Connections Center                               No Empire credential pool.

                                                                                             EX submits jobs only after interface contract is
Deep research                            EV-3 research swarm
                                                                                             verified.

                                                                                             Expert evals are suites inside one Lab; high-risk
Evaluation                               EV-4 Evaluation Lab
                                                                                             suites require external anchors.

                                                                                             EX adds freshness state/policy, not a second
Freshness                                EV-10 maintenance engine
                                                                                             monitor.

                                                                                             Expert content enters as typed data under
Context loading                          UA Context Builder + MC scope
                                                                                             org/sensitivity controls.

Scope/access                             MC org/BU/membership IDs                            EX scope binds to MC IDs; no parallel ACL model.



 Anti-duplication constitution
 One tenancy model. One Policy Gateway. One research swarm. One Evaluation Lab. One freshness engine. New
 EX/Empire code may add schemas, adapters and policies, but may not fork platform authorities.


Dependency                               Required proof before dependent phase               Fallback if not ready

                                         Interface/version recorded; grant invalidation
MC org sessions + Company Lock                                                               Block MC-E2; keep company-by-company login.
                                         hooks proven.

                                         Scope/sensitivity API and data-vs-instruction       Manual expert lookup outside tool-capable
UA Context Builder
                                         boundary verified.                                  context.

                                         Durability, source manifest, budget enforcement
EV-3 research swarm                                                                          Manual curated packs only.
                                         verified.

                                         Versioned suites, holdouts, independent grader
EV-4 Eval Lab                                                                                Manual review + limited low-risk packs.
                                         path verified.

                                         Freshness state, failure signal and refresh hooks   Manual re-verification dates; no high-risk auto-
EV-10 freshness
                                         verified.                                           use.



 Decision D-EX-11
 EX phase estimates are conditional. Each dependency records contract_version, verified_at and evidence reference. A
 missing or changed dependency blocks the phase or forces explicit re-estimation; it is never treated as a fact because
 another plan says it will exist.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 4 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


03

Empire model and terminology bridge
Empire remains a UX portfolio label; legal entities remain the real security and accounting boundaries.

Layer                                   Purpose                                       Example

                                        Human identity, authentication, devices and
User                                                                                  Tobias / Pappa
                                        personal preferences.

                                        Thin owner-defined UX entity grouping legal
Empire                                                                                Tobias Empire
                                        entities and session policy.

                                        Hard security, accounting, credential,
Legal Entity / Organization                                                           Holding AS / Drift AS
                                        memory and authority boundary.

                                        Product or operating line inside one legal
Business Unit                                                                         AI Sales Coach / CRM
                                        entity.

                                        Project/collaboration scope within an
Workspace                                                                             CRM Growth Q4
                                        authorized entity/BU.

                                        Mailbox, repo, ad account, bank feed,
Resource                                documents, customer data or secret            Gmail / GitHub / Fiken
                                        reference.


An empires record may contain owner(s), permitted legal entities, UX defaults and session policy. It may not store
company source data, raw credentials or durable cross-company memory. Portfolio behavior is always derived from
company-scoped authorization.

 Non-negotiable
 One owner experience must never become one undifferentiated data pool. Empire convenience is derived and
 revocable; legal entities remain authoritative.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 5 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


04

Security tier taxonomy and governance
"Same tier" is now a defined security property, not a label an owner can flatten for convenience.
Each legal entity receives an Entity Security Tier from deterministic MC policy. The tier is the maximum required by
enabled capabilities, data sensitivity, regulated status and authority exposure. Users may request a change, but they
cannot directly set the effective tier.

Tier                                     Typical characteristics                               Same-tier navigation

                                         Ordinary business apps; no payment write
T1 - Standard                            authority, no restricted/legal-privileged data, no    Eligible if all other grant conditions pass.
                                         security-admin/root capability.

                                         Customer/employee data, production systems,           Eligible only with T2 entities; sensitive tools still
T2 - Sensitive
                                         confidential IP, financial reporting/read access.     require their own capability.

                                         Bank/payment write, payroll, legal privileged
                                                                                               Navigation may be same-tier, but
T3 - Restricted                          material, regulated/high-sensitivity data, security
                                                                                               finance/restricted use still requires step-up.
                                         administration.

                                         Authority Plane, security constitution, root/cloud
                                                                                               Never covered by ordinary seamless grant;
T4 - Constitutional/Critical             ownership, recovery roots, ownership/control
                                                                                               explicit Class D/security path.
                                         changes.



  Effective tier = max(policy floors derived from resources, data classes, authority and regulatory flags).
  Tier downgrade requires Class D approval and cannot go below any active mandatory floor.
  Tier upgrade or downgrade bumps tier_epoch and immediately invalidates every Empire Session Grant that includes
   the entity.
  Adding a capability that raises the floor triggers reclassification before that capability becomes usable.
  Tier policy itself is part of the security constitution; changing taxonomy/criteria requires Class D and audit.

 Decision D-MC-27
 Security tier assignment is Authority Plane/MC policy, not owner-editable metadata. Tier changes are Class D,
 auditable, epoch-versioned and immediately revoke affected grants.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 6 -->

```text
                                                   JARVIS // EMPIRE + EXPERTISE MASTERPLAN


05

Empire Session Grant lifecycle, revocation and replay resistance
A grant is a short-lived cache of authority, not authority itself.
The Empire Session Grant may simplify navigation across same-tier entities, but every sensitive action still resolves
current authoritative state. The grant is device/session-bound and carries version epochs so stale authorization fails
closed.

Grant field                                                                Purpose

grant_id / jti                                                             Unique replay/revocation identity.

user_id / user_session_id / device_key_id                                  Binds grant to authenticated session and device proof.

empire_id + allowed_legal_entity_ids + roles                               Exact navigation scope only.

security_tier                                                              Tier snapshot allowed by D-MC-27.

membership_epoch / tier_epoch / policy_epoch / empire_epoch                Detects stale derived authorization.

auth_strength / issued_at / expires_at                                     Authentication/risk and short lifetime.

entity_set_hash                                                            Prevents silent widening of the covered entity set.



Invalidation event                                                         Required behavior

Membership revoked/role reduced                                            Bump membership epoch; deny next use; revoke refresh.

Legal entity suspended/removed from Empire                                 Bump empire/entity epoch; invalidate affected grants.

Tier reclassified                                                          Bump tier epoch; all grants containing entity fail closed.

Company Lock/security policy changed                                       Bump policy epoch; force fresh evaluation/step-up.

Device/user session revoked or risk escalates                              Revoke grant immediately and deny device-bound proof.

Credential/finance policy becomes restricted                               Grant may remain navigation-only; restricted capability requires step-up.

                                                                           Reject because token is proof-of-possession/session bound; record security
Grant theft/replay from another device/session
                                                                           event.



 Lifetime rule
 Default maximum grant TTL is short (target 5 minutes) and refresh is allowed only after re-checking current epochs
 and risk. The grant is never a long-lived bearer token and is never accepted as a database/tool authorization by itself.


 Decision D-MC-28
 Membership, entity, tier, policy, Empire composition, device/session or risk changes invalidate living grants.
 Replay/theft is explicitly tested. A stale grant cannot outlive the authoritative state from which it was derived.




                                                 Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 7 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


06

Legal entity isolation and credentials
The Empire experience can be broad; credentials and action capabilities remain narrow.

Boundary                                                       Isolation requirement

                                                               tenant/legal_entity_id enforced by MC RLS and service authorization.
Database
                                                               Portfolio reads are separate scoped reads plus aggregation.

                                                               Separate vault project/path or equivalent per legal entity; separate
Credentials
                                                               machine identity where practical.

                                                               Every provider connection belongs to one company connection record and
OAuth
                                                               cannot be silently reused elsewhere.

                                                               Bank, cards, spend, revenue, invoices, reserves and payment authority are
Money
                                                               entity-specific.

Memory                                                         Company/customer memory never merges across entities by default.

                                                               Every action records user, entity, BU/workspace, tool, approval, expert
Audit
                                                               version, source/provenance and outcome when applicable.

                                                               Job tokens are scoped to one company and one task; no generic portfolio
Workers
                                                               worker token.

AI context                                                     Model receives only minimum company context required for the task.



 Shared AI credential rule - D-MC-26
 Empire-shared AI credentials exist only through explicit MC cross_org_shares with scope, owner, audit and
 revocation. They are not a silent shared-credential category.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 8 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


07

Empire Dashboard and derived aggregate safety
Cross-company visibility must not create the cross-company source-of-truth pool the architecture forbids.
Empire Dashboard values are derived views over authorized company data. The cache is explicitly non-authoritative,
short-lived, regenerable and excluded from Memory, Company Knowledge and Expert training/retrieval.

Aggregate rule                                                  Requirement

                                                                Every aggregate keyed by empire_id + authorized entity-set hash + metric
Scope
                                                                schema/version.

                                                                Normalized KPI/summary values only; no raw customer rows, documents,
Content
                                                                secrets or source payloads.

                                                                Each value stores source legal_entity_ids, source timestamps/versions and
Provenance
                                                                as_of time.

                                                                Short policy TTL; regenerate from company sources. Long-term reporting
Retention
                                                                requires an explicit analytics artifact with owner/retention policy.

                                                                Membership, grant, tier, entity-state or source-version changes invalidate
Invalidation
                                                                affected cache.

                                                                Aggregate cache is never a default retrieval source for company tasks,
Retrieval boundary
                                                                memory recall or expert acquisition.

                                                                Dashboard read must still prove access to every contributing entity at
Authorization
                                                                request time.



 Decision D-MC-29
 Empire aggregates are derived display/analytics artifacts, never a new data pool or authority. They are traceable,
 regenerable, scope-bound and excluded from memory/expertise ingestion by default.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 9 -->

```text
                                    JARVIS // EMPIRE + EXPERTISE MASTERPLAN


08

Four-layer knowledge model
Memory, company truth, expertise and current context remain semantically distinct.

Layer                                Question answered                            Examples

                                                                                  Decisions, conversations, outcomes, past
Memory                               What happened?
                                                                                  actions.

                                                                                  Products, pricing, customers, processes,
Company Knowledge                    What does this company know?
                                                                                  policies, internal facts.

                                                                                  Google Ads, Norwegian corporate law, SaaS
Expertise                            How does this domain work?
                                                                                  pricing, PostgreSQL.

Current Context                      What is relevant right now?                  User, company, task, deadline, live state.



 Canonical specification rule
 Expert packs are reusable domain knowledge. They do not become company memory, and company evidence does
 not become Global expertise merely because it is summarized or rewritten.




                                  Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 10 -->

```text
                                      JARVIS // EMPIRE + EXPERTISE MASTERPLAN


09

Expertise Intelligence architecture and acquisition modes
Expert Library remains useful even if the research swarm is delayed, expensive or disabled.

EX capability                                                    Implementation

                                                                 Version, scope, provenance, rights, freshness, eval status, recall status and
Expert Registry
                                                                 routing metadata.

                                                                 Maps task to domain/jurisdiction/risk/scope/freshness and chooses pack
Expert Router
                                                                 combination.

                                                                 Compiles typed claims/procedures from validated evidence; never imports
Expert Builder
                                                                 source instructions as authority.

Expert Eval Suite                                                Runs in EV-4; high-risk status requires external/holdout anchors.

Expert Context Loader                                            UA adapter that loads minimum authorized slices as knowledge data.

                                                                 Disables bad versions, invalidates caches and finds dependent
Expert Recall Controller
                                                                 decisions/actions.

Freshness Policy                                                 EV-10 integration with explicit fresh/stale/unknown/monitor_failed states.



Acquisition mode                       When used                                           Requirements

                                       Human/owner provides or curates sources and         Full provenance, rights, injection, eval and
manual_curated
                                       pack content.                                       freshness gates still apply.

                                       Jarvis helps research targeted gaps without full
assisted_research                                                                          Budgeted source collection + verifier path.
                                       swarm.

                                       Broad/deep domain build via EV-3 multi-agent        Verified EV-3 dependency, hard budget, durable
swarm_acquisition
                                       research.                                           job, same publish gates.



 Decision D-EX-13
 Manual curated packs are a permanent first-class mode, not a temporary EX-0 workaround. Expert Library delivers
 value without requiring the full acquisition swarm.




                                    Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 11 -->

```text
                                          JARVIS // EMPIRE + EXPERTISE MASTERPLAN


10

Expert pack schema, storage and prompt-injection containment
A stored expert pack is potentially persistent hostile input, even after factual verification.

Logical element                                                  Purpose / security treatment

expert.json                                                      Stable identity, schema, scope, acquisition mode and policy metadata.

                                                                 Provenance, authority, rights and dates; raw source material remains
sources/
                                                                 quarantined.

                                                                 Typed claims with claim_id, evidence refs, jurisdiction/date and taint/scope
knowledge/
                                                                 labels.

                                                                 Structured domain procedures as data; never system/developer/tool
procedures/
                                                                 instructions.

decision_trees/                                                  Typed conditions and outcomes; runtime still decides permissions/actions.

examples/ / checklists/                                          Reference data, not privileged commands.

                                                                 Declarative tool requirements/capabilities only; no executable or
tools/requirements.json
                                                                 authority-granting prompt text.

known_unknowns/                                                  Gaps, disputed interpretations and uncertainty.

evals/                                                           Security, factual, scope, rights and domain eval results.

changelog/ / updates/                                            Version history, candidate patches and rollback/recall state.



  Raw web/source text is quarantined and is never directly promoted into an active pack context.
  Pack compilation converts evidence into typed fields/claims; instruction-looking source text is stripped, escaped or
   retained only as quoted evidence with explicit source provenance.
  UA Context Builder inserts expert material in a data-only knowledge boundary. Expert content can inform reasoning
   but cannot create system/developer/tool authority.
  Every publish candidate runs prompt-injection/adversarial evals, including payloads that ask the model to ignore
   policy, reveal secrets or invoke tools.
  Global packs cannot contain free-form tool directives. Tool requirements are declarative and Policy Gateway remains
   authoritative.

 Decision D-EX-06
 Expert-pack content is data, never privileged instruction. Factual/source verification is insufficient by itself; injection-
 specific compile and eval gates are mandatory before publication.




                                       Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 12 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


11

Deep research, source rights and durable storage
Legal access to a source does not automatically grant the right to store, export or redistribute it.
1. Expert Router checks existing pack coverage, scope, freshness, eval status and recall status.
2. Acquisition job declares jurisdiction, risk, source policy, acquisition mode, hard budget and billing owner.
3. Research prioritizes primary/official sources and records access/rights metadata at capture time.
4. Verifiers check provenance, conflicts, dates, unsupported conclusions, prompt-injection indicators and rights
   constraints.
5. Builder compiles only admissible evidence into typed pack content.
6. Eval gates run before publication; restricted-source material is filtered from exports/sharing according to rights
    metadata.
7. Published version starts freshness monitoring immediately.
Per-source rights field                                         Meaning

access_right                                                    May Jarvis retrieve/read the source?

retention_right                                                 May source content be retained, and for how long?

derivative_storage_right                                        May derived summaries/structured claims be stored?

redistribution_right                                            May pack-derived content be shared outside original scope?

export_right                                                    May human-readable bundle include this source-derived material?

license_id / expiry                                             Contract/license reference and expiry/review date.



 Decision D-EX-09
 Source compliance covers access, retention, derivative storage, redistribution and export. Unknown/insufficient rights
 fail closed for durable storage or wider sharing; exports are rights-filtered.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 13 -->

```text
                                          JARVIS // EMPIRE + EXPERTISE MASTERPLAN


12

Research budget, shared-pack funding and cost attribution
No Expert Job starts without both technical budget authority and an accounting owner.

Control                                                           Required behavior

EV_EXPERT_MONTHLY_CAP_NOK                                         Hard program ceiling enforced by deterministic policy.

job_budget_nok                                                    Hard per-job limit checked before expensive branches.

max_agents / max_depth                                            Bounds swarm fan-out/recursion.

billing_scope_type / billing_scope_id                             company, Empire or platform/global cost owner.

funding_legal_entity_id                                           Named legal entity paying when company/Empire funded.

cost_center / allocation_policy                                   Accounting classification and any approved shared allocation.

budget exhaustion                                                 Pause/fail closed with current evidence, gaps and estimated next step.

                                                                  Provider/token/search/tool cost by expert_id, version, job_id and funding
cost trace
                                                                  owner.



  Company-scoped pack: sponsoring legal entity is explicit.
  Empire-shared pack: job must name one sponsor or an approved allocation policy across legal entities before
   spending.
  Global pack: funded from an explicit platform/Jarvis operator budget, never silently charged to a tenant company.
  If an Empire-shared allocation may represent an intercompany service, the Finance/MC policy records the
   chargeback requirement; EX does not invent accounting treatment.

 Decision D-EX-10
 There is no anonymous shared spend. Every acquisition/refresh job has a budget owner and funding source before
 Authority Plane authorizes cost.




                                        Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 14 -->

```text
                                           JARVIS // EMPIRE + EXPERTISE MASTERPLAN


13

Expert routing and multi-expert reasoning
Routing chooses knowledge; it does not loosen scope, freshness, rights or tool permissions.

User task                                                          Experts / knowledge loaded

How should we price the CRM?                                       SaaS Pricing + Sales Psychology + CRM Company Knowledge.

Can Holding buy IP from Drift AS?                                  Norwegian Corporate Law + Tax + Accounting + Corporate Finance.

Why did Google Ads CAC spike?                                      Google Ads + Attribution + Sales Funnel + company campaign data.

Design the worker architecture.                                    Distributed Systems + Docker Security + PostgreSQL + Jarvis Architecture.

                                                                   Procurement + Contract Negotiation + China Import + company supplier
Negotiate a Chinese supplier contract.
                                                                   history.



  Load summaries first; retrieve details only as needed.
  Keep unrelated packs out of working context.
  Cache keys include expert version, sensitivity, scope and org/legal_entity identity when scoped data can be
   combined.
  Chief Analyst preserves disagreements instead of averaging them away.
  Router refuses recalled, rights-incompatible or high-risk stale/unknown versions.




                                         Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 15 -->

```text
                                      JARVIS // EMPIRE + EXPERTISE MASTERPLAN


14

Scope purity and provenance taint
A Global label is permitted only when the evidence graph itself is Global-clean.
Every claim and procedure carries evidence provenance and a scope/taint label. Rewriting a company-derived fact does
not remove its origin. Pack scope is constrained by the most restrictive evidence used.

Evidence class                                                Allowed pack scopes

external_public_shareable                                     Global, Empire, company, BU, private subject to rights.

licensed_restricted                                           Only scopes permitted by redistribution/export rights.

                                                              That company only unless explicit MC cross-org share permits a
internal_company
                                                              broader defined scope.

internal_empire_shared                                        That Empire only; never Global by summarization.

private/restricted                                            Only named user/roles per MC policy.


  Global publish gate rejects any claim/procedure with internal evidence provenance or restricted redistribution
   rights.
  Empire-shared pack may contain internal evidence only when the originating company explicitly shares it under MC
   policy.
  Derived conclusions inherit the union of source restrictions; taint is not erased by synthesis.
  Pack export uses the same scope/rights graph and cannot disclose hidden source material.

 Decision D-EX-07
 Global and broader shared packs must be provably clean of company-derived evidence unless the target scope and
 rights explicitly permit it. Global means zero internal-company evidence provenance.




                                    Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 16 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


15

Evaluation integrity and high-risk external anchors
The same model cannot be the sole author, examinee and grader of its own expertise.

Eval layer                                                     Requirement

                                                               Versioned benchmark suite with expected concepts, procedures and
Domain coverage
                                                               known-unknown handling.

                                                               Questions with expected answers/citations derived from primary/official
Source-anchored holdouts
                                                               sources and withheld from pack construction.

                                                               Builder model/provider cannot be the only grader; use independent
Independent grading
                                                               model/rule/human path where available.

                                                               Adversarial payloads inside sources/pack fields must not alter authority,
Injection/security suite
                                                               reveal secrets or cause tool use.

Scope/rights suite                                             Tests prove Global purity, org isolation and export-right enforcement.

                                                               High-risk suites and published decision-support status receive initial and
Human sampling
                                                               periodic human/professional review.

                                                               High-risk suite itself is reviewed/versioned before it can confer decision-
Eval-suite review
                                                               support status.



Metric-derived confidence remains the rule, but confidence is only meaningful when metrics contain independent
anchors. High-risk legal/tax/medical/contract packs cannot become "decision support" solely from self-generated LLM
tests.

 Decision D-EX-08
 High-risk expert status requires externally anchored holdouts, independent grading and periodic human/professional
 sampling. The model that built the pack may participate, but cannot be the sole evaluator.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 17 -->

```text
                                         JARVIS // EMPIRE + EXPERTISE MASTERPLAN


16

Freshness, monitor failure and outcome learning
Unknown freshness is a first-class degraded state, not absence of information.

Freshness state                                                 Behavior

fresh                                                           Within policy window; normal use subject to risk/scope.

                                                                Policy window exceeded; visible warning, confidence degradation
stale
                                                                and refresh candidate.

                                                                Freshness has not been verified; treated as degraded, not equivalent
unknown
                                                                to fresh.

                                                                EV monitor/check failed or dependency unavailable; visible degraded
monitor_failed
                                                                state and incident signal.

recalled                                                        Version disabled; no routing/use except audit/forensics.


  High-risk decision-support is blocked when freshness is unknown, monitor_failed or stale beyond domain policy.
  Lower-risk tasks may continue only with visible degraded confidence and date/freshness status.
  A source change creates a candidate patch; no silent overwrite. Old versions remain auditable.
  Company outcomes may enrich packs only as internal evidence with inherited scope/taint; they never become
   universal facts.

 Decision D-EX-14
 Failure of the freshness mechanism degrades the expert visibly. High-risk use fails closed until freshness is re-
 established.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 18 -->

```text
                                         JARVIS // EMPIRE + EXPERTISE MASTERPLAN


17

Expert recall procedure
If an expert version is later wrong, poisoned or non-compliant, Jarvis must unwind its influence.
1. Trigger recall: security incident, factual defect, license/rights breach, scope contamination, invalid eval anchor or
    poisoned source.
2. Mark expert_id/version as recalled and block routing/context loading immediately.
3. Invalidate every cached slice and dependent derived artifact tied to that version.
4. Query audit for all decisions, recommendations, tool actions and outputs that referenced the recalled version.
5. Risk-rank affected records by domain/action class, company and whether a binding tool action occurred.
6. Notify relevant owners/admins and create review tasks for affected high-risk decisions/actions.
7. Create corrected candidate version with new evidence/evals; never mutate the recalled version in place.
8. Close recall only when impact review, replacement/rollback and required notifications are evidenced.

 Decision D-EX-12
 Expert versions are recallable dependencies. Audit provenance is operationally used to find and remediate decisions
 made with a bad version, not stored merely for post-hoc inspection.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 19 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


18

Expert permissions and high-risk domains
Expertise supports decisions; it never becomes authority.

Expert scope                             Who can access                                    Example

                                         Authorized Jarvis users; Global-purity + rights
Global                                                                                     Public Google Ads knowledge
                                         gates pass.

                                         Members explicitly allowed in one Empire;
Empire shared                                                                              Empire growth playbook
                                         provenance/share rules pass.

Company                                  Members of one legal entity.                      Drift AS pricing strategy

Business Unit                            Authorized product team only.                     CRM competitive intelligence

Private                                  One user.                                         Personal negotiation notes

Restricted                               Named roles + step-up.                            Legal strategy / sensitive finance



  An expert never grants tools, budget, credentials or authority; Policy Gateway and Authority Plane remain
   authoritative.
  Untrusted source content stays quarantined until provenance, injection, rights and eval gates pass.
  Legal, tax, medical and other professional packs are decision support - professional verification required before
   binding action.
  High-risk output includes jurisdiction, date, freshness, confidence and explicit escalation when policy requires.
  Expert creation/update cannot modify Policy Gateway, Class D rules, tier policy or security constitution.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 20 -->

```text
                                   JARVIS // EMPIRE + EXPERTISE MASTERPLAN


19

Core data model and service boundaries
The new controls are represented as data so they can be enforced and audited deterministically.

Entity / fields                                            v1.2 role

empires                                                    Thin UX/session entity only; no pooled source data.

                                                           legal_entity_id, effective_tier, policy_floor_reasons, tier_epoch,
entity_security_tiers
                                                           changed_by_approval_id.

                                                           grant/jti, user/session/device binding, entity set, tier, auth strength, epochs,
empire_sessions
                                                           issued/expiry/revocation.

                                                           empire_id, entity_set_hash, metric schema, source refs/as_of, TTL; non-
empire_aggregate_cache
                                                           authoritative.

                                                           domain, jurisdiction, owner_scope, acquisition_mode, current version,
experts
                                                           routing/recall state.

                                                           immutable content identity, freshness_state, eval_status,
expert_versions
                                                           provenance/rights summary, recall state.

                                                           typed claim/procedure, evidence refs, evidence_scope/taint,
expert_claims
                                                           jurisdiction/date.

                                                           provenance, authority, rights fields, publication/verification dates,
expert_sources
                                                           checksum/license.

                                                           suite/test, holdout flag, expected anchor/source, grader independence,
expert_evals
                                                           result/date.

                                                           workflow state, hard budget, billing scope, funding entity, cost center, EV
expert_jobs
                                                           dependency refs.

                                                           reason, affected versions, cache invalidation, impacted decision/action
expert_recall_events
                                                           review state.



Logical service                                            Actual ownership

Empire Access facade                                       UX adapter over MC org sessions, Company Lock, tier/revocation policy.

Connections Center                                         Existing MC component.

Expert Registry / Router                                   New EX component.

Research Orchestrator                                      EX workflow using EV-3; manual mode does not require swarm.

                                                           EX suite manager using EV-4 plus external/human anchors where
Expert Eval adapter
                                                           required.

Freshness adapter                                          EX state/policy using EV-10.

Recall Controller                                          EX service reading audit/provenance and invalidating router/caches.

Context Builder integration                                UA Context Builder with MC scope and data-only expert boundary.




                                 Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 21 -->

```text
                                           JARVIS // EMPIRE + EXPERTISE MASTERPLAN


20

Build sequence and dependency gates
Security hardening lands before convenience or autonomous research scale.

Increment                     Build                                      Exit criterion                          Estimate

                              Tier taxonomy + deterministic              Tier floors proven; owner cannot
MC-E1                         assignment + Class D                       flatten tiers; reclassification         2-3 wk
                              reclassification.                          audit/epoch works.

                                                                         Stolen/replayed/stale grant fails;
                              Device-bound Empire Grant +
MC-E2                                                                    membership/tier/policy changes          2-3 wk
                              epochs + revocation/replay controls.
                                                                         revoke immediately.

                                                                         Same-tier navigation works;
                              Empire UX + safe derived
MC-E3                                                                    dashboard cache cannot become           1-2 wk
                              aggregates.
                                                                         retrieval/source pool.



EX phase                      Build / prerequisite                       Exit criterion                          Estimate

                              Registry + manual_curated mode;            Manual pack registers, routes, scopes
EX-0                                                                                                             2-3 wk
                              MC-0..5 stable.                            and exports with provenance/rights.

                              Context loader + D-EX-06 injection         Pack data cannot create privileged
EX-1                                                                                                             2-3 wk
                              boundary; UA verified.                     instructions/tool authority.

                                                                         Correct pack selected;
EX-2                          Router + scope purity/recall checks.       recalled/tainted/rights-invalid packs   2-3 wk
                                                                         refused.

                                                                         Durable job produces source manifest
                              EV-3 acquisition adapter +
EX-3                                                                     within budget; dependency contract      3-5 wk
                              budget/funding.
                                                                         recorded.

                              Verification + source rights + injection   Unsupported/injected/rights-invalid
EX-4                                                                                                             3-4 wk
                              scan.                                      material cannot promote.

                                                                         High-risk pack cannot self-certify;
EX-5                          Builder + EV-4 eval + external anchors.                                            4-6 wk
                                                                         publish gates proven.

EX-6                          Multi-expert + Chief Analyst.              Conflicts surfaced and traceable.       2-3 wk

                                                                         Monitor failure produces degraded
EX-7                          Freshness degradation + EV-10.                                                     2-3 wk
                                                                         state; high-risk use blocks.

                                                                         Recall finds dependent
                              Outcome learning + Recall + Expert
EX-8                                                                     decisions/actions;                      3-4 wk
                              Library UI.
                                                                         scope/rights/versions inspectable.




 Estimate rule
 Incremental work in this document is approximately 29-42 working weeks if the named MC/UA/EV dependencies
 already meet their contracts. This is not a wall-clock promise from today. If EV-3/4/10 or UA/MC interfaces are
 incomplete, the phase is blocked or re-estimated; manual curated packs remain usable meanwhile.




                                       Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 22 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


21

Acceptance and adversarial tests
Evidence gates must attack the new mechanisms, not only re-test the old platform.
Empire / MC negative tests
  Tier downgrade request cannot bypass mandatory resource/data floors and requires Class D.
  Tier reclassification while an Empire grant is active invalidates the grant before the next entity action.
  Membership revoked mid-grant cannot be used until TTL expiry; access fails immediately via epoch/revocation
   check.
  A stolen/replayed empire_session from another device/session fails proof-of-possession and raises a security event.
  Entity suspension, Empire removal or Company Lock policy change invalidates affected grants.
  Finance/restricted and every Class D action still require step-up even between same-tier companies.
  Empire Dashboard aggregate cache cannot return data for an entity removed from current authorization and is
   never retrieved as company memory/expertise.
Expertise negative tests
  Injection payload embedded in a source, knowledge claim, procedure or tool guidance cannot override
   system/developer policy, reveal secrets or trigger unauthorized tool use.
  Global pack publication fails if any claim has internal/company evidence provenance, even after
   synthesis/rewording.
  Rights-invalid source content is excluded from durable pack/export/share according to source rights metadata.
  High-risk pack fails decision-support publication if its eval suite lacks source-anchored holdouts, independent
   grading or required human review.
  Model that built the pack cannot be the sole high-risk grader.
  Unknown/monitor_failed freshness visibly degrades confidence; high-risk decision support is blocked.
  Recalled expert version disappears from routing, invalidates caches and returns a complete impact list from audit.
  Empire-shared/Global acquisition job cannot spend without billing scope and funding owner.
  Manual curated pack remains fully usable when EV-3 swarm is unavailable, but still passes security/provenance/eval
   gates.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 23 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


22

Migration from v1.1 and current Jarvis
Upgrade the integration contract without replacing working MC/EV/UA foundations.
1. Add D-MC-27 tier taxonomy to MC-E1; migrate every legal entity to a deterministic effective tier with recorded floor
   reasons.
2. Extend Empire Session Grant schema with epochs, device/session binding, jti/revocation and entity_set_hash;
    implement D-MC-28 invalidation hooks.
3. Create safe empire_aggregate_cache with D-MC-29 restrictions; purge any existing long-lived dashboard cache that
    acts as source data.
4. Extend Expert Pack compiler/context loading with D-EX-06 data-only/injection policy before any pack is used in tool-
    capable context.
5. Add claim-level provenance taint and D-EX-07 Global-purity publish gate.
6. Add D-EX-08 external holdout/independent grading/human review requirements for high-risk decision-support
   packs.
7. Add per-source retention/redistribution/export rights and filter all pack export/share paths under D-EX-09.
8. Add billing/funding fields to Expert Jobs and require D-EX-10 funding owner before spend.
9. Record dependency contract/version/verified_at for MC/UA/EV prerequisites; use manual_curated mode until missing
   dependencies pass.
10. Implement Expert Recall runbook/controller and freshness degraded states before autonomous EX-3+ scale.
11. Renumber migration steps from 1 and run the visual export gate on every final PDF.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 24 -->

```text
                                     JARVIS // EMPIRE + EXPERTISE MASTERPLAN


23

Binding decisions in the v1.2 integration contract
v1.2 keeps v1.1 decisions and adds explicit rules for the newly identified trust surfaces.

Decision                                                     Binding rule

                                                             Same-tier Empire navigation may be seamless; higher tier, finance/restricted,
D-MC-24
                                                             Class D and cross-Empire require step-up.

                                                             Empire is UX terminology for MC Portfolio; Legal Entity/Organization remains
D-MC-25
                                                             the tenancy/security term.

D-MC-26                                                      Empire-shared AI credentials require explicit MC cross_org_shares.

                                                             Entity Security Tier is deterministic Authority Plane/MC policy; changes are Class
D-MC-27
                                                             D and invalidate affected grants.

                                                             Empire Grants are device/session-bound derived caches with epoch-based
D-MC-28
                                                             revocation and explicit replay resistance.

                                                             Empire aggregate caches are derived, regenerable, scoped and never default
D-MC-29
                                                             memory/expertise/retrieval sources.

D-EX-01                                                      One research swarm, one Eval Lab, one freshness engine; EX reuses EV.

D-EX-02                                                      Every acquisition/refresh job has enforced per-job and monthly budget controls.

                                                             High-risk professional domains are decision support and require professional
D-EX-03
                                                             verification before binding action.

                                                             Expert cache identity includes org/legal_entity scope, sensitivity and expert
D-EX-04
                                                             version.

                                                             Untrusted research requires verification and source-access compliance before
D-EX-05
                                                             promotion.

                                                             Expert pack content is data, not privileged instruction; injection-specific
D-EX-06
                                                             compile/eval gates are mandatory.

                                                             Global packs contain zero internal-company evidence provenance; derived
D-EX-07
                                                             claims inherit provenance taint.

                                                             High-risk expert status requires source-anchored holdouts, independent grading
D-EX-08
                                                             and periodic human/professional sampling.

                                                             Source rights govern access, retention, derivative storage, redistribution and
D-EX-09
                                                             export.

                                                             Every shared/global Expert Job has explicit billing scope and funding owner
D-EX-10
                                                             before spend.

                                                             EX dependencies are verified contracts with version/date/evidence; missing
D-EX-11
                                                             dependencies block or re-estimate.

                                                             Expert versions support recall with cache invalidation and audit-driven impact
D-EX-12
                                                             remediation.

D-EX-13                                                      Manual curated expert packs are a permanent first-class acquisition mode.

                                                             Stale/unknown/monitor_failed freshness degrades confidence; high-risk decision
D-EX-14
                                                             support fails closed.




                                   Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 25 -->

```text
                                        JARVIS // EMPIRE + EXPERTISE MASTERPLAN


24

Operating model and final architecture
What Jarvis becomes after the hardened Empire + Expertise plan is complete.

 Normal request path
 User -> authenticated User Session -> optional short Empire Grant -> current legal-entity authorization/epoch check ->
 UA Context Builder -> Memory + Company Knowledge + typed Expert Pack data -> Model/Agent -> Tool Gateway ->
 Policy Gateway -> company-scoped capability -> external system -> audit/outcome.


 Expert acquisition path
 User request -> Expert Router -> gap -> acquisition mode selected -> funded/budgeted job -> evidence capture with
 rights + injection quarantine -> typed Expert Builder -> shared Eval Lab + security/scope/rights tests + external
 anchors when high-risk -> publish immutable version -> freshness monitor -> lazy-load later -> recall if required.


  Authentication proves the person; current authorization proves entity, tier, data scope and exact action.
  A navigation grant never becomes a root/company tool token.
  Empire aggregates are views, not truth stores.
  Expert packs are knowledge data, not authority-bearing prompts.
  Global scope is a provenance property, not a label.
  Confidence is metric-derived and externally anchored where risk demands it.
  Every Expert Job has technical budget authority and accounting ownership.
  Dependency uncertainty is visible and blocks false completion claims.
  Every important decision remains attributable to user, entity, expert version, evidence, model, tools, approvals, cost
   and outcome.

 Definition of done
 The plan is complete only when same-tier Empire switching survives tier/revocation/replay adversarial tests;
 dashboard aggregation cannot become a cross-company data pool; expert packs resist persistent prompt injection and
 scope contamination; high-risk evaluation has independent anchors; rights and funding are enforceable; stale experts
 degrade safely; and recalled versions can be traced through every dependent decision/action.




                                      Version 1.2 | Architecture blueprint | 13 Aug 2026
```

---

<!-- side 26 -->

```text
                                       JARVIS // EMPIRE + EXPERTISE MASTERPLAN


25

Version tracking
Why v1.2 supersedes v1.1.

Version                                                        Change

                                                               Introduced Empire Security Domain and Expertise Intelligence as two
v1.0
                                                               parallel strategic layers.

                                                               Folded Empire into MC; mapped EX to EV/UA/MC; added cost caps,
v1.1
                                                               estimates, high-risk policy, cache isolation and source-access rules.

                                                               Defines security tiers; adds grant revocation/replay resistance; isolates
                                                               Empire aggregates; treats packs as persistent injection surfaces; enforces
v1.2                                                           Global provenance purity, source rights, external eval anchors and
                                                               funding ownership; adds dependency verification, expert recall,
                                                               permanent curated mode and freshness-failure degradation.



This v1.2 document supersedes v1.1 for Empire + Expertise integration behavior. MC, EV and UA remain authoritative
for their underlying components. Where a dependency has not yet been implemented and verified, this document
records the required interface contract rather than assuming the implementation exists.

 End state
 Jarvis remains a portfolio-aware operating system with hard company boundaries and reusable expert intelligence,
 but the two new convenience layers are no longer trusted merely because Jarvis created them. Grants are revocable
 derived authorization; expert packs are typed, scoped, rights-aware, externally testable and recallable knowledge.




                                     Version 1.2 | Architecture blueprint | 13 Aug 2026
```
