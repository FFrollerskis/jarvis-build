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

1. **Repoet er verifisert OFFENTLIG (`visibility: public`), bekreftet via GitHub API av ekstern
   arkitekt.** Tobias må gjøre repoet privat (eller eksplisitt beslutte noe annet) **før** sensitiv
   Jarvis-kode, secrets-konfigurasjon eller privat data legges inn. Krever Tobias.
2. **Ingen fase 0-PR eksisterer.** PR kan ikke opprettes herfra: `gh` CLI mangler og SSH-nøkkelen er
   en repo-deploy-nøkkel uten API-tilgang. Opprettes manuelt:
   https://github.com/tsworkflow/jarvisbuild/pull/new/claude/fase-0-github-og-statusfiler
3. **Q-01/Q-02** i [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) ubesvart (kildedokumenter + antakelser).
4. **Fase 1 ikke godkjent** av Tobias ennå.

GitHub-tilgang er løst: SSH deploy-nøkkel (ed25519) registrert; `main` (baseline, godkjent av Tobias)
og arbeidsbranchen er pushet.

## Neste oppgave

Tobias: avklar repo-synlighet (punkt 1), opprett/godkjenn fase 0-PR, svar Q-01/Q-02, godkjenn fase 1.
Deretter: fase 1 på `claude/fase-1-security-foundation` per [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
