# Førsteinntrykk: seks masterplaner mot chain-tipp f47d0883 (PR #25) — lead, 2026-11-26 (IKKE dypanalyse; nøkkelordsøk + planenes fasetabeller)

Kilder (eierens opplastinger 2026-11-26, tekstuttrekk i /tmp/lead/masterplans/*.txt, PDF-kopier samme mappe):
HF1 Sovereign Autonomy v4.0 (31 s) · HF2 Evolution v1.2 FINAL GOVERNING (20 s) · HF3 Multi-Company Identity/Trust/Platform Ops v1.3 FINAL (19 s)
HF4 Empire + Expertise v1.2 FINAL (26 s) · HF5 Adaptive Continuity v1.1 (19 s) · HF6 Continuous Intelligence v1.2 FINAL GOVERNING (25 s)
Repoets docs/input/02_..._v4.0.md = automatisk konvertering av HF1-PDF (5-gram-overlapp ca. 90 %; PDF er originalkilden).

## Programkonstitusjon (HF6 §24, D-PROG-01..11)
- HF1-HF6 = det governing plansettet (D-PROG-11). Konfliktrekkefølge: (1) ekstern lov/plattform/kontrakt, (2) mest spesifikke kanoniske domeneeier, (3) HF3/Authority for legal tenant/cross-org/secrets/root/recovery/provider data boundary, (4) HF2 for self-change/eval/release/capability activation, (5) HF1 for owner-autonomi innen legitim authority, (6) HF4/5/6 kun i egne data-/workflow-domener, (7) ellers PROGRAM_CONFLICT (ingen stille vinner).
- CANONICAL_SPEC skal bli maskinlesbar programindeks (component_id, canonical_owner, contract_version, state_store, events_in/out, dependencies, runtime_state, evidence_ref ...), compatibility-sjekk ved oppstart/deploy.
- «NO EVIDENCE, NO FINISHED»: 17 Program Completion-porter (Plan-sett, Canonical ownership, Contract compatibility, Identity/tenant/authority, Autonomy, Evolution, Expertise, Continuity, Continuous Intelligence, Diagnostics, Recovery, Security, Long-run stability, Multi-tenant reality, Economics, Value, Operational graduation). Kode ferdig/PR merget/dokumentstatus erstatter ikke runtime-evidens. ORL0 spec complete -> ORL1 build complete -> ORL2 integrated -> ORL3 burn-in (30 d) -> ORL4 pilot -> ORL5 fully operational.
- Interaksjon med repoet: ADR-001 (v4.0 «ACKNOWLEDGED_NOT_ADOPTED», strengeste sikkerhetsregel vinner til navngitt D-beslutning) og CLAUDE.md regel 2/8 vs HF1 «ingen godkjenning som standard for eierens egen tenant». HF6 §24.2 pkt 5 gir HF1 forrang for eier-autonomi innen legitim authority. ADOPSJON ER EIERENS NAVNGITTE D-BESLUTNING (aldri stille).
- D-406 (eier 2026-10-05): «de seks masterplanene bygges ÉN OG ÉN som skrevet - ingen sammenslåing/kutting».

## Fasetall og planenes egne anslag
HF1 UA-0..UA-11 (12) · HF2 EV-0..EV-23 (24; 48-79 uker EV-effort i planen) · HF3 MC-0..MC-13 (14; 20-38 uker) · HF4 EX-0..EX-8 + MC-E1..E3 Empire (29-42 uker) · HF5 JX-0..JX-8 (9; ca. 20-35 uker) · HF6 CI-0..CI-11 (12; 32-51 uker).

## Førsteinntrykk per plan (kode på chain-tipp; alt `NOT VERIFIED`)
- HF1: 12/12 UA bygget, DORMANT/AV (UA-0 delvis, UA-8 mangler lokalagent); 0 av 15 DoD bevist.
- HF2: 14 av 24 EV aktive som observasjon/delvis, 10 DORMANT beredskap (EV-6/11/15/18/20 bevisst ikke bygget). MATRISE-RE-SJEKK mot PDF gjenstår (CLOSURE_MATRIX ble bygget uten PDF; EV-18 = «Capability Discovery/Capability Registry» i HF2/HF6 vs «Connector-fabrikk» i matrisen).
- HF3: ingen MC-fase ferdig. Fundament finnes: tenant-RLS (76 testfiler cross-tenant), step-up/enhets-tilbakekall (owner_controls.revoke_device), Infisical, bedrifts-tenant-CLI (provision-business-tenant), Policy Gateway/klasse D, Finance Gateway. Mangler: Platform Operator/Plane, organizations/memberships/authority_policies, OIDC-adapter (ZITADEL) + passkeys, Company Lock, org-sessions, per-org vault/miljøisolasjon, Model Provider Registry/org AI-policy, Security Event Plane, hash-kjedet audit med signerte checkpoints, portefølje. Eier/jus: DPA/tjenesteavtale, Platform Operator = Kundeoppfølging AS, pappas bedrift som første eksterne tenant (HARD_EXTERNAL).
- HF4: ikke påbegynt (0 treff Empire/expert registry/pack).
- HF5: ikke påbegynt som pakke. Deler finnes: V2 push/oppfølging, Business OS (UA-3), Value Center (Impact delvis), voice-gateway, Twilio/Telnyx, watchdog (OPS2a på vei). Mangler: Commitment & Reminder Engine (JX-3), CRM-uttrekk/Business Graph (JX-4), produksjonstelefoni/SIP (JX-5), Impact Ledger (JX-6), knowledge_gap/workspace (JX-7), pilot (JX-8).
- HF6: ikke påbegynt (0 treff Experience Ledger). Delvis: trace_id/correlation (48 filer), incident-producenter, EV-9 heal/last-known-good i release-gate.

## Avhengigheter (planenes egne regler)
HF5: aktiveres først etter HF1 DoD (kan forberede docs/grensesnitt/test). HF6: aktiv læring bare når underliggende UA/EV/MC/EX/JX er produksjonsverifisert; til da kun schema/interface/test + passiv instrumentering. HF4 EX-0 krever MC-0..5 stabil; EX-1 UA verified; EX-3..5 krever EV-3/EV-4. HF3 bølge A: MC-0 + start MC-1/2/5.
