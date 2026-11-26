# JARVIS BYGGEPROGRAM 2 (HF1-HF6) - lead, opprettet 2026-11-26 ~16:25Z. Fasit for rekkefølge/parallellitet etter gap-analysene. Oppdateres fortløpende.

## 0. Mandat
Eierens ordrer 2026-11-26 (direkte i chat): «alt skal bygges og det skal bygges riktig ... hvis noe passer å bygge samtidig gjør det nå» (D-496) og STÅENDE FULLMAKT «Du får full tilgang til å styre alt selv ...» (D-497; tekst /tmp/lead/D-497-draft.md). Lead merger rutinemessige PR-er selv (vilkår i D-497); stopp kun ved HARD_EXTERNAL_BLOCKER. Alt bygges REELT/komplett og DORMANT (flagg AV der planen gater aktivering), testet underveis (rød-først, mutanter, uavhengig review, kjede-/full-suite). Planer: /tmp/lead/masterplans/ (HF1-HF6); gap-rapporter: /tmp/lead/gap/HF{3,4,5,6}-gap.md (+HF2 når ferdig); felles regler: /tmp/lead/briefs/BUILD-RULES.md.

## 1. Omfang (analytikernes anslag i lead-økter; S ≤ 1, M 2-3, L 4+; spenn)
HF3 MC: 22 WP, ca. 70 (55-90) · HF4 EX/MCE: 15 WP, ca. 47 (38-56) · HF5 JX: 18 WP, ca. 52 (40-60) · HF6 PG/DX/CI: 26 WP, ca. 68 (55-85) · HF2 EV: (analyse pågår, ab5b26702244573eb) · HF1-rest + kø (OPS2b, H3, AUTH2a/b, UA2, I2, UI1, DOC1; under arbeid: T1, S1, OPS2a, SEC2, V2): ca. 35-50. Sum ≈ 320-380 økter. Målt takt hittil ca. 1 økt/time ved 3 samtidige agenter (7 WP-er/19 t). Flaskehals = brukergrensen (auto-gjenopptak). Grovt: kode ferdig på 4-8 uker; operativ (ORL5) 3-5 mnd pga. NAS-verifisering/burn-in 30 d/pilot/jus.

## 2. Lead-beslutninger (D-497; EB = analytikernes eierbeslutning-ID)
- HF3 EB-1 adopsjon: bygg MC-faser DORMANT/flagg-AV (D-496); ADR-001 §2.1 gjelder uendret til eier NAVNGIR regler som erstattes.
- EB-2: org ≡ tenant. `organizations` = 1:1-profil mot `tenants`; `org_sessions` = utvidet `session_grants`; `organization_memberships` = utvidet `person_tenants`; INGEN ny `org_id` på ~128 tabeller (PC-3).
- EB-3/PC-1 (kryss-selskap-overføring krever alltid eksplisitt klasse D, også for SOVEREIGN): bygges i MC7 som deterministisk juridisk-enhet-grense bak flagg `JARVIS_MC_AUTHORITY_V2` (AV = main); anbefalt aktivering ved første eksterne tenant (eier-handling). Strengeste regel = trygg standard.
- EB-4 IdP: generisk OIDC-adapter (leverandørnøytral; ZITADEL = foretrukket i planen, ingen SDK i kjerne), conformance mot fake IdP. Passkeys hos IdP via OIDC acr/amr (ingen WebAuthn-bibliotek i kjernen; Ed25519-enhetsnøkler/klasse D uendret); IdP-exit-runbook (re-registrering) dokumenteres. D-64: OIDC-adapter = CORE_DEPENDENCY_DECISION_REQUIRED=false; passkey-RP hos IdP = true -> logget valg (adapter + exit-vei), ingen stans. Self-host vs managed = eier/ekstern (konto/betaling) -> OWNER_ACTIONS.
- EB-5 miljøtopologi, EB-6 sjekkpunkt-signer/retention, EB-7 DR-mål, EB-8 pappas tilgang, EB-9 second-device-terskler: bygg konfigurerbart/adapter; faktisk valg/konto/nøkkel = eier/ekstern (OWNER_ACTIONS).
- EB-10 S1/Q-71: bygg NÅ (S1 pågår). Q-65 pkt 1 (request_digest) = ja (T1 pågår); Q-63 pkt 7 (avstemming) = ja.
- HF5 PC-1/PC-2 (bygg dormant før HF1 DoD): D-496 dekker; aktivering per fase knyttes til DoD-punkter/NAS-evidens (eier).
- HF6 §24 programkonstitusjon bygges som kode/CI-vakt (PG1: maskinlesbar indeks + duplicate-owner-scan) men adopsjon av «HF1 vinner for owner-autonomi» mot ADR-001 §2.1 krever eierens navngitte D; bygg mekanismen med trygg standard.
- EV-18 Capability Registry finnes IKKE (matrise/readiness feilmerker «Connector-fabrikk»); bygges som egen HF2-WP (HF6 CI-3/5/6 avhenger). Generell event-transport finnes ikke: eies av DX1 (EventEnvelope v2 + Postgres-outbox, ren Postgres, ingen ny meldingsmotor, CANONICAL §1.2).
- Nye moduler `modules/expertise`, `modules/empire` aksepteres (D-496).
- Migrasjonsområder (lead tildeler eksakt nummer pr WP): S1 149-152 · T1 153-154 · SEC2 155 · (156 reserve) · OPS2a 157 (ubrukt) · 158 reserve · AUTH2 159 · HF3/MC 160-189 · HF4/EX/MCE 190-219 · HF5/JX 220-249 · HF6/PG/DX/CI 250-279 · HF2/EV 280-299 · HF1-rest 300-319.

## 3. Bølgeplan (parallell = filedisjunkt; hotspots H1 migrasjoner, H2 gateway/policy/approval, H3 identitet/sesjon/enhet/server.ts-auth, H4 main.ts/worker-main/compose/service-env, H5 connector-registry/integrations, H6 model-gateway, H7 audit-writer, H8 control-center/apps/web)
Status 16:25Z: STABEL #19-#25 (PR #25 f47d0883) full-suite i flock-kø -> merges av lead når grønn. PÅGÅR: SEC2 (adf4afd7dd36fd0ce), V2-fix2 (a06320a8eb414a682), OPS2a (a985296660ea47ec9), DOCW1 (ac3010f40aa50807a), MC8a (a2006df8e7b31b193), S1 (af417c7684dc8d40a), T1 (a8ad53c08bb138228), HF2-analyse (ab5b26702244573eb).
- Bølge A (nå): MC8a, S1, T1 (+ OPS2a, SEC2, V2, DOCW1 ferdigstilles).
- Bølge B (neste plasser, brief trengs): MC2 (etter MC8a pushet), AUTH2a, PG-A (PG1+PG3+DX0 «programfundament», nye filer), EX0a, EX0c, MCE0 (nye moduler), MC1a, MC5a, JX0, JX3a (etter T1), JX4a/JX4b, JX5a (fake provider), CI0, CI1a, FT, DX1-kontrakt, EV-18-registeret (etter HF2-analyse), MC13a-bibliotek.
- Bølge C: MC3, MC13b, MC8b, MC6b-tabeller, MC4a (etter S1), MC5b, MC1b, EX0b, EX3/EX4, JX1a/b, JX2a, JX3b, DX2 (etter SEC2), DX3/DX4/PG2 (etter OPS2a+V2), CC (etter H3).
- Bølge D: MC7 (etter MC3, MC4a, AUTH2a/b, T1), MC4b, MC6a (etter MC5b, I2), MC9 (etter MC2/5b/6a/7), EX1 (etter T1/AUTH2/UA2), EX5/EX6/EX7/EX8, MCE1/MCE2, JX2b/JX2c/JX5b/JX5c/JX6/JX7, DX5.
- Bølge E: MC10, MC11 (etter UI1), MC12, MC13c/d, MCE3, JX8, CI-live-dormant, OR1 (chaos/ORL-harness).
Kritisk linje HF3: MC8a -> MC2 -> MC3 -> (S1) MC4a -> MC7 -> MC4b -> MC6a/MC5b -> MC9 -> MC10/MC11 -> MC13d (28-35 økter).

## 4. Prosess per WP
bygger (BUILD-RULES + pakkebrief) -> kombinert A+B-reviewer (to uavhengige for identitet/authority/secrets/egress/audit/penger/gateway) -> fiks-runder (fersk bygger, smal brief) -> delta-review for MEDIUM+ -> lead-kjedeverifisering på eksakt HEAD (statisk + HELE `apps/api/test` hvis server/main/worker røres + modultester + vakter) -> PR (base main) -> D-497-merge når vilkårene holder (bølge-/kjedetopper: FULL suite). Docs: DOCW1 nå, deretter docs per bølge (egen docs-agent). Forward-merge main inn i pågående grener etter hver merge; `.gitleaksignore` kun lead.

## 5. Kjente fallgruver
Naive kommentarfjernere i `apps/api/test` kildevakter (aldri `/*`/`*/` i server.ts/main.ts-strenger/-kommentarer); Write-verktøyet dekoder \uXXXX; full suite uten `embedded-postgres-ipv4-contention*`; 5 kjente sandkassefeil (wpc3-review1-hardening F10a/b/c, break-glass-guard, nas-ua0-gate); `mk-build-wt-from.sh` KJØRES SEKVENSIELT (parallell worktree-opprettelse feiler); cwd-drift: alltid `cd /home/user/jarvisbuild`.
