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

1. **Q-01/Q-02** i [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) ubesvart (kildedokumenter + antakelser
   A-01–A-06) – spørsmålene er stilt til Tobias; fase 0 kan ikke markeres fullført før de er besluttet.
2. **Fase 1 ikke godkjent** av Tobias ennå.

**Løst:** Repo-synlighet – Tobias har eksplisitt bekreftet (2026-08-12) at repoet er satt til
**privat**; visibility-blokkeringen er lukket. (Innstillingen er endret av Tobias, ikke herfra.)

**PR-status:** Ingen fase 0-PR eksisterer. Kan ikke opprettes herfra (`gh` mangler; deploy-nøkkel
uten API-tilgang). Opprettes manuelt ved behov:
https://github.com/tsworkflow/jarvisbuild/pull/new/claude/fase-0-github-og-statusfiler

GitHub-tilgang er løst: SSH deploy-nøkkel (ed25519) registrert; `main` (baseline, godkjent av Tobias)
og arbeidsbranchen er pushet.

## Neste oppgave

Tobias: avklar repo-synlighet (punkt 1), opprett/godkjenn fase 0-PR, svar Q-01/Q-02, godkjenn fase 1.
Deretter: fase 1 på `claude/fase-1-security-foundation` per [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
