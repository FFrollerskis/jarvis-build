# EV-0: signere Safety Constitution (eier-handling, OFFLINE)

Gjelder D-406. **Dette gjør kun Tobias, på en maskin Jarvis ikke har tilgang til.** Privatnøkkelen skal aldri inn i repoet, NAS-en, chat eller `.env`.

## 1. Lag nøkkelpar (én gang)
```
node ops/security/sign-constitution.mjs keygen ~/jarvis-constitution.key ~/jarvis-constitution.pub.pem
```
Oppbevar `.key` offline (krypert USB / passordmanager). Verktøyet nekter å overskrive eksisterende filer og skriver ut fingeravtrykket.

## 2. Sett budsjettgrensene, signer manifestet
Før du signerer: se over `budget_caps` i `config/evolution/constitution.v1.json` (utkastverdier fra D-409 - 5 auto-merger/døgn, 3 deploys/døgn, 10 eier-forslag/døgn, 10 000 øre/måned Evolution-kost). Disse er gjetninger; sett dem til det DU vil. Grensene kan ikke heves av Jarvis; å heve dem senere krever at du øker `version` og signerer på nytt. Harde tak i koden: 20 / 10 / 50 / 100 000 øre.

Sett `issued_by` i `config/evolution/constitution.v1.json` til ditt navn (fjern «UNSIGNED-DRAFT…»), øk `version` ved senere endringer, og kjør:
```
node ops/security/sign-constitution.mjs sign ~/jarvis-constitution.key
node ops/security/sign-constitution.mjs verify ~/jarvis-constitution.pub.pem
```
Legg `constitution.v1.sig` og den OFFENTLIGE nøkkelen (`config/evolution/constitution.pub.pem`) i repoet via en eier-PR. Disse stiene er E3 (Jarvis kan ikke endre dem).

## 3. Fest nøkkelen utenfor repoet
```
node ops/security/sign-constitution.mjs fingerprint ~/jarvis-constitution.pub.pem
```
Verdien (64 hex) settes i NAS-`.env` som `JARVIS_CONSTITUTION_PUBKEY_SHA256`. API-et leser den ved oppstart (D-411) og logger `ev0_constitution_boot` (`verified` eller `not_verified` med feilkode) - kun observasjon, ingenting blokkeres, og selvendring er fortsatt frosset. Uten festet nøkkel avviser kjøretiden konstitusjonen (`constitution_key_not_pinned`) - et manifest, en signatur og en nøkkel i repoet er ikke nok alene. Sjekk etter bygg: `docker compose ... logs api | grep ev0_`.

## Feilkoder
`constitution_missing` · `_unsigned` · `_key_not_pinned` · `_key_mismatch` · `_signature_invalid` · `_invalid` · `_weakened` (signert, men fjerner en påkrevd beskyttelse) · `_rollback` (lavere versjon enn kjent).
