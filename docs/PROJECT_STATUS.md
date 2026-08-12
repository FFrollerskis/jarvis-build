# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-12 · **Branch:** `claude/fase-0-github-og-statusfiler`

## Aktiv fase og oppgave

**Fase 0 – FULLFØRT.**
Ingen aktiv deloppgave. Ingen applikasjonskode er skrevet (som planlagt).

Ferdig-definisjonen for fase 0 er oppfylt: konsistent dokumenthierarki, privat repo (bekreftet av
Tobias), konsistent vault/secrets-plan (D-16), Q-01 besluttet (D-18), Q-02/A-01–A-06 besluttet
(D-18–D-23), ingen secrets i repoet, ingen applikasjonskode, neste fase tydelig definert.

## Ferdig arbeid

- Masterplan v2.1 konvertert til `docs/input/`; 11 styringsdokumenter i `docs/` (CANONICAL_SPEC autoritativ)
- Kritisk gjennomgang (K-01–K-12); beslutningslogg D-01–D-23; alle antakelser avklart
- Ti-fase implementeringsplan med akseptansekriterier og «Bygges IKKE»-lister
- GitHub etablert: privat repo, SSH deploy-nøkkel, `main`-baseline + arbeidsbranch pushet
- Konsistensopprydding etter ekstern arkitektkontroll (statusfiler, vault-plan, LiteLLM-referanse)
- Ny maskinvareplan innarbeidet (D-20): UGREEN DXP4800 Plus som 24/7-base, PC (RTX 4070) til
  utvikling/GPU, dedikert AI-server senere ved dokumentert behov

## Blokkeringer

1. **Fase 1 er ikke godkjent** – Tobias må eksplisitt skrive at fase 1 er godkjent før implementering starter.

**PR-status:** Ingen fase 0-PR (kan ikke opprettes herfra: `gh` mangler, deploy-nøkkel uten
API-tilgang). Opprettes manuelt ved behov:
https://github.com/tsworkflow/jarvisbuild/pull/new/claude/fase-0-github-og-statusfiler

## Neste oppgave

**Fase 1 – Kjørbart sikkerhets- og prosjektfundament**
Planlagt branch: `claude/fase-1-security-foundation`
Innhold og akseptansekriterier: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) → Fase 1.
Starter først når Tobias eksplisitt godkjenner fase 1.
