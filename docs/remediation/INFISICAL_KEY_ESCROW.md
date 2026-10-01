# Infisical-nøkler: escrow og rotasjon (JARVIS-007)

**Ingen nøkkelverdi står i dette dokumentet eller noe annet sted i repoet.** Dokumentet beskriver *hvor* nøklene bor og *hvordan* de sikres.

## Hva som må sikres

| Nøkkel (i NAS-ens `.env`) | Rolle | Konsekvens ved tap |
|---|---|---|
| `INFISICAL_ENCRYPTION_KEY` | Krypterer hemmelighetene i Infisical-databasen (`ENCRYPTION_KEY` i compose). | Vaultet er **uopprettelig** selv med perfekt database-backup. Alle leverandør-credentials må utstedes på nytt (~40). |
| `INFISICAL_AUTH_SECRET` | Signerer sesjoner/tokens (`AUTH_SECRET` i compose). | Alle Infisical-sesjoner ugyldiggjøres; vaultdata er ikke tapt. |
| `JARVIS_DB_ADMIN_PASSWORD` | Postgres-superbruker. | Kan nullstilles med tilgang til containeren; ikke datatap. |
| Privat age-nøkkel for backup | Dekrypterer backup-settene. | Alle backup-sett er ubrukelige. |

Forrige audit: «Tap av `.env` = re-utstedelse av ~40 leverandør-credentials» – `.env` er i dag **eneste** sted nøklene finnes.

## Escrow-prosedyre (utføres av Tobias – `BLOCKED_EXTERNAL`)

1. Hent verdiene direkte fra NAS-ens `.env` (ikke via chat, ikke via en AI-økt).
2. Lagre `INFISICAL_ENCRYPTION_KEY`, `INFISICAL_AUTH_SECRET` og den private age-nøkkelen i **to uavhengige, offline** lagre (f.eks. passordbehandler med eget hovedpassord + utskrift i forseglet konvolutt hos en annen lokasjon).
3. Oppbevar dem **aldri** i repoet, i backup-mappen på NAS-en, i issue #68, i Telegram eller i en chat.
4. Test at escrowen er lesbar: be om å se nøkkelen *uten* å lese den opp noe sted; sammenlign de siste 4 tegnene mot `.env`.
5. Før dato og lagringssted (ikke verdien) i en privat logg. Gjenta ved enhver endring av nøkkelen.

Gjenoppretting etter totaltap: ny Postgres → restore `infisical`-databasen → start Infisical med **samme** `INFISICAL_ENCRYPTION_KEY` fra escrow. Uten den: nytt, tomt vault og ny utstedelse av alle credentials.

## Rotasjon

**Status: `NOT_VERIFIED_AGAINST_OFFICIAL_DOCS`.** Egress til `infisical.com` var blokkert i denne økten, og D-41-disiplinen forbyr å gjette. Det finnes derfor **ingen** rotasjonsprosedyre her. Regler til den er verifisert:

* **Roter ikke** `INFISICAL_ENCRYPTION_KEY` ad hoc – en feil verdi gjør vaultet uleselig.
* Før en eventuell rotasjon: (a) ta og restore-verifiser en backup, (b) les gjeldende offisiell Infisical-dokumentasjon for selv-hosting, (c) øv på en kopi (scratch-instans fra backup), (d) logg dokumentasjons-URL og dato her.
* `INFISICAL_AUTH_SECRET`-endring antas å logge ut alle – **ikke verifisert**; test på scratch først.
* Rotasjon av leverandør-credentials *inni* vaultet er en egen oppgave (JARVIS-056, senere del).
