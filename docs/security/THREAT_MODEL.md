# Jarvis – trusselmodell (fase 1)

> **Dokumentstatus (ADR-001, D-398/JARVIS-100):** utkast som aldri er formelt godkjent og delvis overstyrt de facto av senere D-beslutninger ([ADR-001](../remediation/ADR-001-dokumenthierarki.md) §2.2). Bruk dokumentet som *strengeste-regel*-kilde - ikke som bevis for at noe er bygget, godkjent eller verifisert. Status per funn: [FINDINGS_LEDGER](../remediation/FINDINGS_LEDGER.md).

**Status:** v1.0. Levende dokument; revideres per fase. Tillitszonene er definert i
[SECURITY_MODEL.md](../SECURITY_MODEL.md) §2: Ingestion, Reasoning, Memory, Execution, Secret.

## Trusler, soner og mottiltak

| # | Trussel | Berørte soner | Scenario | Mottiltak (fase implementert) |
|---|---|---|---|---|
| T-01 | **Prompt injection** | Ingestion → Reasoning/Execution | E-post/nettside/GitHub-issue inneholder instruksjoner som får agenten til å handle | Sone-invariant: ubetrodd innhold ⇒ ingen samtidig privat minne + utgående verktøy; skjemavalidert uttrekk; injection-testsuite (fase 7); Policy Gateway foran alle verktøy (fase 1-skjelett ✅) |
| T-02 | **Privilege escalation** | Execution | Agent forsøker handling over sin capability-klasse | Deterministisk klassekontroll i Policy Gateway (fase 1 ✅); mandater for klasse C; signert godkjenning for D (fase 1 ✅) |
| T-03 | **Confused deputy** | Reasoning/Execution | Ubetrodd innhold lurer en privilegert agent til å bruke sine rettigheter på angriperens vegne | Proveniens følger data (trust_level i kontraktene ✅); sesjonens tillitsmodus nedgraderer capabilities (fase 3); parametereksakte godkjenninger (fase 1 ✅) |
| T-04 | **Replay av godkjenninger** | Execution | Gyldig klasse D-godkjenning gjenbrukes | Engangs-nonce forbrukes atomisk etter alle andre kontroller (fase 1 ✅, in-memory; persistent i fase 2); utløpstid (fase 1 ✅) |
| T-05 | **Secret leakage** | Secret | Nøkler havner i kode, logger, prompts eller LLM-kontekst | Ingen secrets i repo (gitleaks i CI ✅); .env git-ignorert ✅; SOPS+age-strategi ✅; vault + kortlivede tokens (senest fase 7); logg-scrubbing (fase 3) |
| T-06 | **Kryss-tenant-/kryss-space-lekkasje** | Memory | Data fra én tenant/space når en annen | RLS i Postgres (fase 2); space-autorisasjon i Context Builder (fase 3); minne-eval med null-lekkasje-krav (fase 4); memory space i identitetskontrakten (fase 1 ✅) |
| T-07 | **Ondsinnet verktøyoutput** | Ingestion → Memory | MCP-/verktøysvar inneholder skadelig innhold som blir «sannhet» | Karantene i skriveflyten (fase 4); tillitsklasse på alle events (kontrakt fase 1 ✅); MCP-skjemalåsing (fase 7) |
| T-08 | **Ubetrodd ingestion** | Ingestion | Dokument/e-post med skadelig innhold ved import | Ingestion Zone-merking; skjemavalidert uttrekk før Reasoning (fase 4/7); aldri direkte til autoritativt minne (fase 4) |
| T-09 | **Kompromittert worker/jobb** | Execution | Kodeagent i sandbox forsøker eksfiltrering eller skade | Kastbar container per jobb, nettverksallowlist, jobbspesifikke tokens, ingen hovednøkler (fase 6); merge-gate (fase 6); jobbkontrakt med tillatte verktøy/mål (kontrakt fase 1 ✅) |
| T-10 | **Approval spoofing** | Execution/Secret | Falsk eller manipulert godkjenning for kritisk handling | Ed25519-signatur over kanonisk payload, enhetsregister, eksakt handlings-/parametermatch (fase 1 ✅); enhetsnøkler i Secure Enclave (fase 8); LLM kan aldri opprette godkjenninger (arkitekturinvariant) |
| T-11 | **Audit tampering** | alle | Angriper (eller agent) skjuler spor | Append-only audit utenfor agentprosessen (fase 2); alle policybeslutninger logges (fase 1 ✅ in-memory sink); audit på egen node (fase 10) |
| T-12 | **Kostnadseksplosjon/løpsk agent** | Execution | Løkke eller misbruk brenner budsjett | Budsjett/maks steg i jobbkontrakt (fase 1-kontrakt ✅); håndhevede kostnadsgrenser i Model Gateway (fase 3); kill switch (fase 1-skjelett ✅); watchdog (fase 10) |

## Antagelser i fase 1

- Kun én bruker (Tobias) og testdata; ingen eksterne integrasjoner, ingen ubetrodd ingestion ennå.
- In-memory nonce-lager og enhetsregister er akseptabelt fordi ingenting kjører i produksjon;
  begge bak grensesnitt som byttes til persistent lagring i fase 2.
- Angrepsflaten er i praksis repoet selv (secrets, tampering) – derfor gitleaks + privat repo + branch-vern.

## Restrisiko (akseptert i fase 1)

- Ingen persistent audit (kommer fase 2). Risiko: lav – ingen reelle handlinger utføres.
- Ingen rate limiting (kommer fase 3 med Tool Gateway). Risiko: lav – ingen eksterne verktøy.
- WSL2-sandboxens grenser er uverifisert (K-06/Q-06, testes i fase 6).
