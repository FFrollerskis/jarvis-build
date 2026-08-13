# Runtime gates – status og evidens (v4.0 reality check, 2026-08-13)

Statusverdier: NOT_IMPLEMENTED · IMPLEMENTED_NOT_VERIFIED · PARTIAL_RUNTIME · PRODUCTION_VERIFIED · BLOCKED_EXTERNAL

| Gate | Status | Evidens / gap |
|---|---|---|
| D-27 Langfuse | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | LangfuseTraceSink implementert (`modules/model-gateway/src/trace.ts`); krever Docker for kjørende instans |
| D-28 pgvector/HNSW | BLOCKED_EXTERNAL | Portabel `real[]`+cosine i drift (P95<300ms bevist i test); pgvector-migrasjon venter på Docker-image |
| D-30 Voice benchmark | BLOCKED_EXTERNAL | Harness + WER testet; krever ≥100 norske prøver + STT/TTS-nøkler |
| D-32 Worker Docker/GitHub | PARTIAL_RUNTIME + BLOCKED_EXTERNAL | Prosess-sandbox/lease/reclaim/kodejobb bevist (96→128-suiten); container + ekte GitHub-API mangler |
| D-35 Vault + live integrations | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | Alle adaptere/transportskall + SecretProvider klare; krever Infisical (Docker) + OAuth/API-credentials |
| D-36 Apple runtime | BLOCKED_EXTERNAL | Swift-kilde klar; krever Mac/Xcode/Developer-konto (sjekkliste: APPLE_PHASE8_CHECKLIST.md) |
| HA-RUNTIME | BLOCKED_EXTERNAL | HA-verktøy m/D-pipeline testet mot fake; krever HA-instans + token |
| OPS-RUNTIME | PARTIAL_RUNTIME | Watchdog/kill-switch-kriterier/backup+restore målt i test (fase 10); ekstern uptime/off-site backup gjenstår |
| UA0-AUTHORITY | PARTIAL_RUNTIME | **Implementert 2026-08-13:** `resolveAuthorityMode` (SOVEREIGN for owner-tenant, delegat arver aldri), sovereign klasse C/D uten approval, D-pipeline (preflight→state readback→before/after→recovery-snapshot→audit), OwnerControls (pause/freeze/revoke) håndhevet i policy+gateway. Evidens: `modules/tool-gateway/test/ua0-sovereign.test.ts` (pnpm test → 128/128). Live-verifikasjon mot ekte connectors gjenstår |
| UA0-PRIVACY | PARTIAL_RUNTIME | Tenant+space-RLS, karantene, injection-vern bevist i suiten; live-datastrøm gjenstår |
| UA0-RUNRATE | PARTIAL_RUNTIME | cost_events utvidet (provider/model/input_tokens/output_tokens, migrasjon 011) + costReport per kind/tenant/task; sky-/connector-kost mangler live kilder |

**Regel:** Ingen gate settes til PRODUCTION_VERIFIED uten faktisk runtime-evidens (kommando + resultat + dato) logget her.
