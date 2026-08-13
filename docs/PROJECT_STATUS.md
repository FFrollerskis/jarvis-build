# PROJECT STATUS

**Oppdatert:** 2026-08-13 · **Branch:** `claude/v4-sovereign-autonomy`

## Aktiv fase
Masterplan v4.0 «Sovereign Autonomy» — BO-07 fullført: **UA-0 CORE RUNTIME READY.**

## Ferdig (verifisert, se docs/RUNTIME_GATES.md for kommandoer/evidens)
- D-27 Langfuse, D-28 pgvector/HNSW, D-32 Docker-sandbox-worker, D-35 Infisical: alle VERIFIED i Docker-runtime.
- Full compose-stack: postgres → migrate (one-shot) → api (healthy) + worker + langfuse + infisical(+redis).
  Live connectors (Gmail/Calendar/GitHub/Telegram) fra container; scheduler leverte dagens brief (idempotent).
- Restart-, down/up- og failure-injection-tester (postgres/worker/langfuse/infisical/api) PASS.
- 130/130 tester (Node 22), typecheck, lint, gitleaks (59 commits, no leaks) rene.
- Docker Desktop AutoStart=true; HOST_REBOOT_READY_NOT_PHYSICALLY_TESTED (fysisk reboot krever eierordre).

## Blokkeringer
Ingen tekniske for UA-0. Åpne, ikke-blokkerende porter: D-30 Voice (norske prøver + STT/TTS-nøkler),
D-36 Apple (Mac/Xcode), HA-RUNTIME (HA-instans + token).

## Kjente merknader
- Owner-seed (tenants/people/devices/memory_spaces) er idempotent SQL utenfor migrasjonene (én gang per fersk DB).
- Worker i container bruker process-sandbox (containeren er isolasjonsgrensen); Docker-sandbox (D-32) på host.
- Infisical: maskinidentitet + pilot-migrert JARVIS_GITHUB_TOKEN i vault; .env beholdt som fallback/rollback.

## Neste oppgave
Avvent eierordre: neste UA-fase, ev. D-30/D-36/HA-porter, eller fysisk reboot-test av host-autostart.
