# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-12 · **Branch:** `claude/fase-0-github-og-statusfiler`

## Aktiv fase og oppgave

Fase 0 – spesifikasjon og prosjektetablering. Deloppgave: forenklet rapporteringsprotokoll + GitHub-etablering.
Fase 1 (kjørbart sikkerhets-/prosjektfundament) er **ikke startet** – venter på Tobias sin godkjenning.

## Ferdig arbeid

- Masterplan v2.1 konvertert til `docs/input/`; 11 styringsdokumenter i `docs/` (CANONICAL_SPEC er autoritativ)
- Kritisk gjennomgang: funn K-01–K-12, beslutninger D-01–D-17, antakelser A-01–A-06
- Ti-fase implementeringsplan med akseptansekriterier og «Bygges IKKE»-lister
- Git-repo med remote `https://github.com/tsworkflow/jarvisbuild.git`; alt committet lokalt
- Rapporteringsprotokoll forenklet (kun denne statusfilen; SESSION_LOG/HANDOFF_REPORT fjernet)

## Blokkeringer

1. **GitHub-push 403:** lagret Windows-credential er kontoen `post-ops` uten tilgang til repoet.
   Fiks: gi `post-ops` tilgang, bytt credential i Windows Credential Manager, eller `gh auth login`.
2. **`main`-push:** krever eksplisitt godkjenning fra Tobias (repoet på GitHub er tomt til da).
3. **Privat repo ikke verifisert** (`gh` CLI mangler).
4. **Q-01/Q-02** i [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) ubesvart (kildedokumenter + antakelser).

## Neste oppgave

Tobias: fiks GitHub-tilgang, godkjenn main-push, svar Q-01/Q-02, godkjenn fase 1.
Deretter: fase 1 på `claude/fase-1-security-foundation` per [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
