# GitHub-styring: CODEOWNERS og regelsett (UTKAST, ikke aktivt)

WP-EV0 (HF2 EV-0, H2-0.1/C1). Dette er **utkast** som eieren (Platform Operator) kan slå på når han/hun vil. Ingenting her er aktivt, ingenting her er verifisert mot en ekte
GitHub-konto (`NOT VERIFIED`), og aktiveringen er en eier-handling utenfor koden (`BLOCKED_EXTERNAL`). Mappen ligger under `ops/security/` fordi `.github/` er en beskyttet sti
(E3): Jarvis kan ikke endre `.github/`, og utkastene kan derfor ikke aktiveres av Jarvis.

## Hva som ligger her

| Fil | Hva |
|---|---|
| `codeowners.mjs` | Generator: lager CODEOWNERS-utkastet fra de beskyttede stiene i det SIGNERTE manifestet (`config/evolution/constitution.v1.json`), så utkastet aldri kan avvike fra det kjøretiden beskytter. `--write` oppdaterer `CODEOWNERS.draft`. |
| `CODEOWNERS.draft` | Generert. Eier-plassholderen er `@PLATFORM-OPERATOR` - bytt den med din egen GitHub-bruker (eller et team) ved aktivering. |
| `ruleset-main.draft.json` | Regelsett for standardgrenen (`enforcement: disabled`): ingen sletting, ingen force-push, PR med kodeeier-review, kun to-forelder merge-commit, påkrevde CI-jobber. |

En test (`ops/security/test/github-governance.test.mjs`) sjekker at CODEOWNERS-utkastet er identisk med generatoren, at hver påkrevd sonde og hver beskyttet sti i manifestet dekkes,
at plassholderen er den eneste eieren, og at regelsettet krever nøyaktig CI-jobbene i `.github/workflows/ci.yml` og ikke tillater squash/rebase.

## Slik aktiverer du (eier-handling)

1. Kjør `node ops/security/github-governance/codeowners.mjs` og se over utdataene (eller bruk `CODEOWNERS.draft`).
2. Kopier utdataene til `.github/CODEOWNERS` i en egen eier-PR, og bytt `@PLATFORM-OPERATOR` med din bruker/team.
3. Importer `ruleset-main.draft.json` under Settings -> Rules -> Rulesets (Import a ruleset). Behold `enforcement: disabled` først; bruk `evaluate` hvis kontoen støtter det, og først
   deretter `active`.
4. Ta stilling til punktene under FØR du setter regelsettet til `active`.

## Fallgruver og forbehold (les før aktivering)

- **En enkelt eier kan låse seg ute.** GitHub lar ikke forfatteren godkjenne sin egen PR. Med `require_code_owner_review` og én eneste kodeeier må en ANNEN godkjenner finnes, eller du
  må legge til en bypass-aktør (repo-admin, `pull_request`-modus) i `bypass_actors`. Utkastet har bevisst `bypass_actors: []`: dette er en eierbeslutning, ikke noe koden velger.
- **Actions er av på det nye repoet** (se PROJECT_STATUS). De påkrevde jobbene (`build-test`, `windows-git-auth`, `gitleaks`) rapporterer ikke før Actions er på, og PR-er blir da
  umulige å merge. Slå på Actions først, eller fjern regelen `required_status_checks`.
- **Merge-protokollen** (CLAUDE.md) krever to-forelder merge-commit: derfor ingen `required_linear_history`, og `allowed_merge_methods` er kun `merge`.
- **Uverifiserte feltnavn og plan-avhengighet** (`unverified`): `allowed_merge_methods`, `~DEFAULT_BRANCH`, `evaluate`-modus og om regelsett/kodeeier-krav er tilgjengelig på din
  kontotype og for dette repoet må kontrolleres mot GitHubs gjeldende dokumentasjon. «Restrict file paths» (push-regelsett) er trolig kun for organisasjoner og er ikke med.
- **CODEOWNERS beskytter ikke mot en eier som godkjenner selv** - det flytter bare kontrollen til GitHub, utenfor Jarvis. Selve sikkerheten (E3: motoren kan aldri endre disse stiene) ligger
  fortsatt i koden (`modules/self-modification`) og i den signerte konstitusjonen; dette er et ekstra, uavhengig lag.
- Utkastet inneholder ingen personnavn, adresser eller kontaktinfo; legg heller ikke slikt inn i `CODEOWNERS` ut over GitHub-brukeren/teamet du velger selv.
