# Plan for «alle masterplaner» (eierens «ja jobb til du er ferdig med alle masterplaner», 2026-11-25 ~20:22Z). Base: origin/main 71a31d8b.
Kilde: kartleggingsrapport `/tmp/lead/plan-remaining-report.md` (agent a910dcd5f04aa44a8, 2026-11-25, kun lesing; testtall er dokumentpåstander). Dette dokumentet er LEDERENS avgjørelse; STATE.md er fasit for fremdrift.

## 0. Tolkning og grenser (logges som D-tolkning i den samlede docs-PR-en; eieren kan nedlegge veto)
- Ordren gjelder ALT som kan bygges uten eierens valg eller ekstern handling. Pipeline per WP uendret: bygger -> to uavhengige reviewere -> fiks -> delta-review -> egen verifisering -> draft-PR -> klar. Eieren merger (D-192 stående fullmakt ubesvart).
- [A*]-pakker (SEC2, T1): Q-anbefalingen er «ja» og endringen er innstramming/additiv/AV som standard: bygges under denne tolkningen (D-450-presedens), merkes tydelig i PR og i docs, eieren kan veto.
- STOPP og varsle ved: HARD_EXTERNAL_BLOCKER (credential/betaling/fysisk/juridisk), CORE_DEPENDENCY_DECISION_REQUIRED (bil-leverandør, e-sign, Pieces, sanntids-stack, møte-bot), pakker som krever navngitt D-beslutning (WP-S1/JARVIS-111, JARVIS-084/Reservasjonsregisteret, autonom utsendelse, selvendring). Disse bygges IKKE (kategori B/C/E i rapporten).
- Leverandørfakta (Wallester/Neonomics/Meta/GBP/...) er `unverified` til offisiell dokumentasjon er lest (D-41); byggerne merker uverifisert vendor-spesifikt som DEFERRED.
- Hotspots: `tool-gateway/src/gateway.ts` (G1c, N1b, T1, AUTH2), `integrations.ts` (AUTH2, UA2), `control-center/*` (N1b, G3b, H3, SEC2 privacy.ts), PROJECT_STATUS/D-logg (alle; kun lead rører), migrasjonsnummer (se under), baseline-fixturer (wph1-*, wph2-*, wpn1-differensialen: regenereres bare etter guardens instruks).

## 1. Kø (i gang/klar)
1. WP-G1c = JARVIS-112 b,c,d,f,g,h (D-481, mig 141-143). Bygger a1ee997a8218b6b91 (5 commits, tipp 4d0bd89e per 20:42Z).
2. WP-N1b = JARVIS-116 a,b (D-482). Bygget (ebc85c38); reviewere a5101405fc2cb76a4 (A), ac223750322ddf1a5 (B).
3. WP-G2c = JARVIS-113 b,d,e,j (D-483, mig 144-145). Bygger a0a2ed477374b8cf7 startet 20:45Z.
4. WP-G4b = JARVIS-115 (D-484, mig 148-149). Brief klar; start når G1c-bygger er ferdig.
5. WP-G3b = JARVIS-114 e,k (D-485, mig 146-147). Brief klar (P3, sist i køen).

## 2. Neste bølge (foreslått rekkefølge; ids/migrasjoner tildeles ved start)
6. WP-FIN2 (D-486, mig 151-152): JARVIS-019/020/070/072/097 + finans-018; `modules/finance/**`. P1/P2. Planlegger skriver brief (a791b0b01c000d2a8).
7. WP-SEC2 (D-487) [A*]: hemmelighetsskanner/redaksjon (013, 069, H2-N5). P1/P2. Brief fra samme planlegger.
8. WP-V2 (D-488): voice-robusthet (079, 080, 098, 063, Piper-spawn). P2/P3. Ingen køkonflikt. Brief fra samme planlegger.
9. WP-T1 (D-489, mig 153-154) [A*]: ToolGateway-ledger `request_digest` (102), `unverified`-utløp (103), klasse D-infra `high` (105). Rører `gateway.ts`: BASERES på integrasjon av G1c + N1b (ikke på main alene). Brief skrives når G1c/N1b er ferdige.
10. WP-OPS2a/b (D-490/491): watchdog-prosess (041), backup/restore-livssyklus, EV-1/19/7-kobling, 075/089/086/056-rest. L, deles i to. NAS-verifisering er D.
11. WP-H3 (D-492): H2 N2-N6 + INFO, MemoryExporter/slett-rute i Minne-senteret (060), måling av permanent-ukjente (Q-64/8). Etter N1b og G3b (control-center).
12. WP-AUTH2a/b (D-493/494): klasse C preflight/readback (014; 012 valgfri). Generisk rammeverk + fake-transporter først; leverandørfakta når dokumentasjon er lest.
13. WP-P3 (D-495): småplukk (104, 106, 107, 108-GBP, 054, 025, 067, 094, 029-test-hardening). Kan gå parallelt når som helst.
14. WP-UA2 / WP-I2 / G-rester (114 a/c/f, 115 k, 117 d): etter det over.
15. WP-UI1 (eier-UI for DORMANT-ruter; L; per domene): sist; step-up-flyt i UI venter på S1.
16. WP-DOC1 (S, docs): SIST (etter at PR-ene er merget eller i den samlede docs-PR-en): foreldede ledger-rader (011, 032, 033, 036, 049, 084, 085), ledger-ID til H2 N2-N6/INFO og worker-hjerteslag, krymp PROJECT_STATUS (2113 linjer mot «kort»), rett INTEGRATIONS §4, VERIFICATION_SESSION:178, UA7-DPIA:3-22, Q-25/Q-29; ADR-addendum om v4.0 og D-tolkning av ordren. Doc-vaktene d398-doc-banners og wpj-closure-matrix oppdateres i samme PR.

## 3. Eierens valg (kategori B) som låser mest opp (spørres kort, blokkerer ikke)
- Q-71/WP-S1/JARVIS-111 (step-up-kanalen; anbefaling ja; låser opp alle penge-/fysiske/utgående flagg + JARVIS-066).
- Q-77 pkt 1 (stående D-192-fullmakt for rutine-PR-er) + pkt 2-3 (Actions, grenbeskyttelse).
- Q-43 (hvilke «masterplaner»: repoet har v2.1 og v4.0; HF2-PDF og HF6 mangler; HF3-HF5 er ikke nevnt).
- Ny D: adopsjon av v4.0 / autonomi-graduering (DoD §28 pkt 7, 8, 10, 12).
- Q-68 pkt 6 (tillat developers.google.com / developers.facebook.com i byggemiljøet) = nøkkelen til å verifisere leverandørfakta (D-41) for AUTH2/FIN2/P3/I2.
- Q-61/62 (off-site holdbarhet, RPO/RTO), Q-64/Q-76 (AI-kost = finans?), Q-72/73/74/75 (jus, bil-leverandør, kamera), Q-78.

## 4. Eierens/ekstern handling (kategori C/D): NAS-oppdatering til main (backup, `migrate --plan`, migrasjoner 102-140+, `nas-hf1-hf2-gate`, så ETT flagg om gangen), credentials (aldri i chat), Apple/HA/kamera/GPU, jus (DPIA, markedsføringslov), betaling. ≈130 NAS-/live-trinn i runbookene er `NOT VERIFIED` til eieren kjører dem.

## 5. Skal IKKE bygges (E): selvmodifikasjon/selvkoding/autonom reparasjon (D-397 frosset), WP-S1 uten D, EV-11/13-15/18/20/22-23 utover registrering, D-64-porter (bil, e-sign, Pieces, sanntids-stack, møte-bot, HR/Recruiting, Procurement), fasenes «Bygges IKKE», biometrisk ansiktsgjenkjenning/kontinuerlig rå video/rå lyd/stemmeprofil som eneste autentisering, autonom Jarvis-initiert utsendelse, Telnyx-kall, eldre `*.notify` under policy utover G1c g5, browser click/fill_form/submit, lokalagent med filtilgang, down-migrasjoner.
