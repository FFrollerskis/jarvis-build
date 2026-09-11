# PROJECT STATUS

**Oppdatert:** 2026-09-11 (branch `claude/ua8-personal-digital-twin-core`, base `main=5df11e5add901f3fff10c2ef266c40e3e35e3f48`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Aktiv oppgave: D-131b - TOCTOU-lukking i proof-til-grant-/innrulleringsbindingen (samme PR #79)

Uavhengig arkitektkontroll (repo-eier, ikke Claude selv) av HEAD `72c4d0ebc580258607c33ea94ec8934004ddc1ca`
(D-131a sin autoritets-herding, satt sammen av en ANNEN økt enn denne - se
`git log`/DECISIONS_AND_ASSUMPTIONS.md for den fulle kjeden) fant ÉN gjenstående MERGE BLOCKER:
beviset var ikke bundet til den EKSAKTE enhetsnøkkel-VERSJONEN som faktisk ble verifisert (TOCTOU
mellom `DeviceService.verifyChallenge()` sin egen transaksjon og en SENERE, uavhengig transaksjon som
fingerprintet grantet/innrulleringen mot nøkkelen slik den sto DA). `MERGE_AUTHORIZED=false` - ingen
merge, ingen self-approval.

**Fikset (ÉN sammenhengende runde, identisk mønster på alle tre autoritetsstier):**

1. `DeviceService.verifyChallenge()` returnerer nå `string | null` - fingerprinten (SHA-256 av PEM)
   av NØYAKTIG den nøkkelen som faktisk verifiserte signaturen, ikke lenger en bar boolean. Ny delt
   `fingerprintPem()` erstatter tre uavhengige `sha256Hex()`-kopier.
2. Ny `DeviceService.lockDeviceKeyOn(client, principal)`: `SELECT ... FOR UPDATE` + re-lesing av
   enhetsraden som FØRSTE steg INNE I mutasjonstransaksjonen (`authorizeProvenDevice()` og
   `DeviceEnrollmentService.enroll()` sin `device_proof`-vei), FØR enhver sesjons-/grant-/
   innrullerings-/rotasjonsskriving. Et mismatch mot den bevist fingerprinten (rotert ELLER
   tilbakekalt) avvises identisk med et ugyldig bevis. Låsen holdes til COMMIT/ROLLBACK, så en
   SAMTIDIG rotasjon for samme enhet serialiseres mot autorisasjonen i stedet for å smette imellom.
3. `SessionGrantService.issueOn()` leser ikke lenger `devices` selv - `device_key_fingerprint` er nå
   en PARAMETER fra kallerens nettopp låste/verifiserte lesing (det var selve TOCTOU-hullet).
4. Anvendt identisk på: `authorizeProvenDevice()` (delt av `ChannelSessionAuthority` OG
   `VoiceSessionAuthority`) og `DeviceEnrollmentService.enroll()` (dekker både «autoriser ny enhet»
   og «enheten roterer sin egen nøkkel»).

**Kvalitetsporter - denne runden FAKTISK kjørt lokalt (Linux, ingen Windows-administrator-token-
blokkering denne gangen):**

- `pnpm -w typecheck`: 26/26 pakker grønt.
- `pnpm -w lint` (`eslint .`): 0 feil/advarsler.
- Ny `modules/core/test/d131b-toctou-authority.test.ts` (10 tester, ekte embedded Postgres, ekte
  RLS): deterministisk INJEKSJON (bevis hentet mot gammel nøkkel, nøkkel rotert/tilbakekalt DIREKTE i
  databasen, gammelt bevis presentert for autorisasjons-/innrulleringstransaksjonen - dekker
  grant-utstedelse, innrullering av ny enhet, selv-rotasjon-kappløp; alle verifiserer NULL mutasjon
  via rad-snapshot, ikke bare avslagsresultatet) + EKTE OVERLAPPENDE `pg`-transaksjoner som beviser at
  `FOR UPDATE` FAKTISK blokkerer en samtidig rotasjon (≥300ms bevist blokkert, fullfører først etter
  commit) og at et rullet-tilbake avslag frigjør låsen umiddelbart.
- `modules/core/test/fase8-device.test.ts` oppdatert til den nye `string | null`-kontrakten (var
  skrevet mot den gamle `boolean`-en - dette var den ENESTE eksisterende testen som brøt).
- Full arbeidsområde-testsuite kjørt: **237/237 filer, 3856/3856 tester grønt**, inkl.
  `apps/api/test/d131-authority-hardening-e2e.test.ts` (24 tester fra D-131a-runden, som IKKE hadde
  kjørt lokalt i den forrige økten pga. et Windows-miljøproblem - kjører nå grønt her).
- Manuell hemmelighetsskann av full diff: 0 reelle treff.

**Ikke gjort (bevisst, per oppgavens eksplisitte grenser):** Q-34 gateway-audit, D-108/provider-live,
nye eksterne credentials, merge, deploy, self-approval, ny PR, worker-/automasjonsendring, ny
masterplan-slice.

Full detalj: **D-131b** i DECISIONS_AND_ASSUMPTIONS.md (D-131/D-131a er tidligere runder på samme PR
og står uendret).

## Blokkeringer

Ingen. Denne økten kjørte på Linux uten miljøbegrensningene forrige økt (Windows-administrator-token)
rapporterte - full testsuite er faktisk kjørt og grønn, ikke antatt.

`MERGE_AUTHORIZED=false` fra oppgaven: PR #79 forblir draft og kan ikke merges før en NY uavhengig
arkitektkontroll har godkjent eksakt ny HEAD/base og gitt en separat guarded two-parent mergeordre.

## Neste oppgave

1. Push denne runden, verifiser CI grønt på eksakt ny HEAD, vent på en NY uavhengig arkitektkontroll.
2. Etter godkjent merge + fersk post-merge CI på merge-SHA + bevist trygg lokal main-sync: egen,
   dedikert cross-domene-audit-slice for Q-34 FØR en generisk `gateway.ts`-fiks vurderes.
3. Deretter: re-derivere neste STØRSTE TRYGGE SAMMENHENGENDE leveranse fra faktisk repo-/masterplan-
   status (ikke anta en fast rekkefølge).
