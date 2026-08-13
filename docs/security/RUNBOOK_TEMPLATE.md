# Runbook-mal

> Kopier denne malen til `docs/runbooks/<hendelse>.md` for hver driftshendelse.
> Watchdog-varsler (fase 10) skal lenke til riktig runbook.

# Runbook: <navn på hendelse>

**Alvorlighetsgrad:** kritisk / høy / middels / lav
**Berørte tjenester:** <api / voice-gateway / worker / postgres / ...>
**Eier:** Tobias
**Sist testet:** <dato – en runbook som aldri er øvd på regnes ikke som verifisert>

## Symptomer

- <hva watchdog/bruker ser>

## Precheck (før tiltak)

- [ ] <kontroller som bekrefter diagnosen – ikke handle på antakelse>

## Tiltak (i rekkefølge, reversible først)

1. <minst inngripende tiltak>
2. <neste steg>

**Maks antall forsøk:** <n> · **Timeout per forsøk:** <tid>

## Rollback

- <hvordan tilbakestilles tiltaket hvis det gjør vondt verre>

## Verifisering (etter tiltak)

- [ ] <hvordan bekreftes at hendelsen er løst>

## Eskalering

- <når gis opp automatikk/første tiltak, og hva gjøres da>

## Logg

| Dato | Hva skjedde | Tiltak | Resultat |
|---|---|---|---|
