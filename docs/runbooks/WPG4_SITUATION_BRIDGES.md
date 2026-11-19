# WP-G4 (D-466): UA-10 Proactive Situation Engine - samlet hendelsesabonnement, helse-/hjem-/kamera-broer, modellassistert vurdering, simulering og tilbakemelding (runbook)

**Status: `DORMANT` (alt er AV som standard bak `JARVIS_SITUATION_*`) og `NOT VERIFIED` (ingenting er kjørt mot ekte Home Assistant, kamera, helsedata, lokal modell eller en NAS; alt er bevist mot lokale fakes og en ekte embedded Postgres).**
(Under arbeid: denne filen utvides ved hver milepæl; se git-loggen for hva som er ferdig.)

## 1. Flagg

Se `modules/situations/src/flags.ts`. Alle er AV som standard; kun eksakt `on` slår på. Hovedbryter `JARVIS_SITUATION_SIGNALS`; underflagg (`_HOME`, `_VISION`, `_HEALTH`, `_INCIDENTS`, `_MODEL_ASSIST`, `_FEEDBACK`) gjelder kun under hovedbryteren.
Tall: `JARVIS_SITUATION_BUS_INTERVAL_SECONDS` (60; 15-3600), `JARVIS_SITUATION_LOG_RETENTION_DAYS` (30; 7-365). Tilbakerulling = flaggene AV og restart.
