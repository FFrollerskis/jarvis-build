# Øvelse av PR-rekkefølgen (lokalt, 2026-11-20): konfliktkart

Metode: temporær worktree `/tmp/rehearse` fra `origin/main` (`ec3e684e`); hver del merget som to-forelder-merge (`--no-ff`) i PR-rekkefølgen, konflikter løst for hånd (union), `git rerere` aktiv. Mellomtilstandene ligger som `refs/rehearsal/NN-*` (aldri pushes). Løserne ligger i `resolve_lib.py` (denne mappen); rerere-cachen i `rr-cache.tgz` (pakk ut i `.git/`).

**Resultat: sluttreet etter siste steg (`7de8924f`) er IDENTISK med treet til `integration/post-merge-test-2` (`95380285`)**, som er full-suite-verifisert (16 649 av 16 654, de fem røde er kjente sandkasse-feil). Å merge delene i denne rekkefølgen, med disse løsningene og de to test-tilpasningene, gir altså akkurat den verifiserte tilstanden.

| # | Merge | Konfliktfiler | Løsning |
|---|-------|---------------|---------|
| 1 | K | ingen | – |
| 2 | H1 | ingen | – |
| 3 | I | ingen | – |
| 4 | H2 | `apps/api/src/control-center/{authority,register}.ts`, `apps/api/src/main.ts` | union: K sin `policyAudit` + H2 sin `autonomyRevoke`/`goldenSuite`/`valueReport` m.fl. |
| 5 | B3 | `control-center/register.ts` | behold B3 sin Evolusjon-blokk (ours var tom) |
| 6 | D3 | `main.ts`, `server.ts`, `infra/local/service-env.mjs` | union (growth-blokk først, deretter B3 sin `evolutionApprovalOn`; `@jarvis/growth`-import; D3-flaggene før B3-flaggene) |
| 7 | B4 | `control-center/register.ts` (2 steder) | union av imports (`ControlRiskClass` + `claudeBudgetConfigFromEnv`) og begge funksjonene (`riskClassOf`, `claudeBudgetFromEnv`) |
| 8 | G1 | `.gitleaksignore`, `main.ts` (2), `server.ts`, `service-env.mjs`, `model-tool-surface.ts`, `tool-manifest.ts` | union; komma etter siste element i listene (`"growth_tiktok",` før `"comms"`) |
| 9 | G2 | `main.ts` (2), `server.ts`, `service-env.mjs`, `tool-manifest.ts` (3) | union; `PRIVATE_NAMESPACES` får både `"comms"` og `"car"`; G2 sin `personal.filterTools(firstWaveTools(` beholdes. **Deretter `git cherry-pick ca13dace` (rent).** |
| 10 | G3 | `.gitleaksignore`, `main.ts`, `server.ts`, `service-env.mjs` | union (G2-blokken før G3-blokken) |
| 11 | G4 | `main.ts` (2), `server.ts`, `service-env.mjs` | G3 sin ferdige visjonsliste (med `JARVIS_VISION_ALLOW_TAILSCALE`) + G4 sine `JARVIS_SITUATION_*`; G2 sin ferdige `createPersonalWiring(... controls ...)` + G4 sin `situationSignals`-blokk. **Deretter `git cherry-pick 87b49a65` (rent).** |
| 12 | docs | ingen | – |

Konsekvenser for PR-dagen:
- Konfliktfiler er stort sett de samme sju (`main.ts`, `server.ts`, `service-env.mjs`, `control-center/register.ts`, `tool-manifest.ts`, `model-tool-surface.ts`, `.gitleaksignore`), og alle løses som union av tillegg. Ingen semantiske konflikter ble funnet.
- Når del N skal inn og `main` inneholder forgjengerne: `git merge origin/main` i del N sin gren gir de samme konfliktene (rerere gjenkjenner sidene uansett retning); ellers bruk `resolve_lib.py`-oppskriftene over.
- Begge test-tilpasningene (`ca13dace`, `87b49a65`) kan plukkes rent (`git cherry-pick`) i riktig steg.
- Mellomtilstandene er IKKE testet (kun typesjekk-/testresultatet for sluttreet via integ2). GitHub CI per PR avgjør mellomtilstandene.
