import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B: EKSPLISITT
 * git-transport-autentisering for `git clone`/`git push` mot `https://github.com/...`,
 * ALDRI avhengig av ambient vertsmaskin-tilstand (f.eks. en tilfeldigvis
 * konfigurert, aldri tidligere bevist Git Credential Manager). `ProcessSandboxRunner`
 * gir `git clone`/`git push` en REN prosess-env (kun PATH + git-identitet +
 * eksplisitt `jobEnv`) - INGEN `HOME`/`USERPROFILE`/`SSH_AUTH_SOCK` når gjennom,
 * så uten dette ville push STRUKTURELT ALLTID feile mot en ekte GitHub-remote
 * (eller, verre, stille lykkes/feile avhengig av uverifisert vertstilstand).
 *
 * Mekanisme: et EPHEMERT `GIT_ASKPASS`-skript. Selve SKRIPTFILEN inneholder
 * ALDRI token-verdien - kun logikk som leser den fra SIN EGEN prosess-env ved
 * kjøretid (`JARVIS_GIT_ASKPASS_TOKEN`, satt KUN som `extraEnv` på selve
 * `git clone`/`git push`-kallet via `Sandbox.exec()`s nye fjerde parameter -
 * ALDRI i sandboxens vedvarende `jobEnv`, ALDRI synlig for `ClaudeCodeAgent`s
 * `exec()`-kall, som fortsatt kun bruker basis-enven fra `sandbox.create()`).
 * `GIT_TERMINAL_PROMPT=0` tvinger git til å bruke askpass eller feile rent -
 * ALDRI en interaktiv/ambient-avhengig fallback-prompt. Skriptet skrives i en
 * EGEN, dedikert temp-katalog - ALDRI inne i `sandbox.workdir` (som
 * `git clone <url> .` krever TOM for å ikke feile). Se `buildAskpassEnvValue()`
 * for HVORDAN `GIT_ASKPASS` faktisk settes sammen - formatet er
 * PLATTFORM-BETINGET (D-103 HOST-FIX, se under), IKKE en enkel felles streng.
 *
 * D-103 HOST-FIX (2026-08-21, "d103-host-git-auth-isolation-repair"): en ekte
 * Windows-kjøring viste at GIT_ASKPASS ALENE er UTILSTREKKELIG. Root cause,
 * bevist mot git sin egen dokumenterte oppførsel (gitcredentials(7)): git sin
 * credential-subsystem spør FØRST alle konfigurerte `credential.helper`-
 * kjeder (system+global+repo-config, akkumulert i den rekkefølgen) om de kan
 * fylle brukernavn/passord - GIT_ASKPASS/`core.askPass` er en RENT
 * PROMPT-FALLBACK som KUN kalles når INGEN helper allerede har svart. Windows
 * Git for Windows-installasjoner har som oftest Git Credential Manager
 * konfigurert som en slik ambient `credential.helper` (system- eller
 * global-scope) - den svarte FØR askpass i det hele tatt ble konsultert, med
 * et cached, syntaktisk gyldig, men FEIL innlogget credential ("post-ops" i
 * stedet for den tiltenkte JARVIS_GITHUB_TOKEN-identiteten). GIT_ASKPASS
 * hadde derfor ALDRI en reell sjanse til å bli brukt for push - dette er
 * IKKE en bug i selve askpass-skriptet, men en strukturell prioritetsfeil i
 * hvordan git sin credential-oppløsning fungerer.
 *
 * Fiks del 1 (ambient helper-prioritet): nullstill `credential.helper`-kjeden
 * PROSESS-LOKALT for AKKURAT clone/push-kallet, via git sin EGEN dokumenterte
 * kommandolinje-mekanisme `-c credential.helper=` (git-config(1): en tom
 * verdi NULLSTILLER hele den akkumulerte helper-listen - `-c`/kommandolinje-
 * config har ALLTID høyest presedens, over system/global/repo-filer, UANSETT
 * hva som står i dem). Dette er PORTABELT (samme git-kommandolinjeflagg på
 * Windows og Linux), MUTERER INGEN fil (verken repo/global/system git-config),
 * og inneholder INGEN hemmelighet (verdien er tom streng - selve NAVNET på
 * konfignøkkelen er ikke sensitivt). Når helper-kjeden er tom og
 * `GIT_TERMINAL_PROMPT=0` hindrer interaktiv terminal-prompting, faller git
 * STRUKTURELT tilbake til `GIT_ASKPASS`.
 *
 * Fiks del 2 (selve askpass-invokeringen var LATENT ØDELAGT): EMPIRISK bevist
 * i denne reparasjonen (mot ekte git 2.43.0 og en ekte lokal smart-HTTP-
 * git-server, se `git-credential-isolation.test.ts`) at git IKKE kommando-
 * linje-parser `GIT_ASKPASS`-verdien på POSIX i det hele tatt - HELE
 * miljøvariabel-strengen sendes UENDRET til `execvp()` som ÉN opaque sti. Den
 * opprinnelige `"<node>" "<skript>"`-anførselstegn-formen var derfor en
 * LATENT BUG helt siden D-103s første merge - git prøvde å `execvp()` den
 * BOKSTAVELIGE anførselstegn-strengen (inkl. selve anførselstegn-tegnene) som
 * ETT filnavn og feilet med ENOENT ("cannot exec '\"...\" \"...\"'"). Dette
 * ble ALDRI fanget av eksisterende tester fordi ALLE brukte lokale bare-repo-
 * kloner (fil-sti-transport) - en transportklasse som ALDRI trigger git sin
 * credential-oppløsning i det hele tatt (ingen autentisering er meningsfull
 * for en lokal filsti), så askpass-skriptet ble ALDRI faktisk INVOKERT AV GIT
 * i noen tidligere test, kun (korrekt) generert og plassert i `extraEnv`.
 * `buildAskpassEnvValue()` fikser dette PLATTFORM-BETINGET: på POSIX er
 * `GIT_ASKPASS` en BAR, UANFØRSELSTEGNET sti til askpass-skriptet selv (kjørt
 * direkte via dets shebang-linje + `chmod 0o700`, se `createGitAuthHandle()`)
 * - INGEN node-binær-prefiks, INGEN anførselstegn (POSIX-`execvp()` trenger
 * ingen shell-lik ord-splitting for én sti, og en bokstavelig anførselstegn-
 * karakter ville selv blitt en del av "filnavnet" den prøver å kjøre). Windows
 * sin `CreateProcess()` forstår derimot IKKE shebang-linjer i det hele tatt,
 * så en `.cjs`-fil kan ALDRI kjøres direkte der - `createGitAuthHandle()`
 * skriver DERFOR en egen `.cmd`-wrapper-fil PÅ WINDOWS (se
 * `generateAskpassWindowsWrapper()`) som eksplisitt kaller node med skriptet
 * som argument, og `GIT_ASKPASS` peker på DENNE `.cmd`-filen i stedet -
 * anførselstegnet (Windows sin kommandolinje-konvensjon STØTTER og TRENGER
 * anførselstegn rundt en sti med mellomrom, i motsetning til POSIX-`execvp()`).
 */
export const GIT_ASKPASS_TOKEN_ENV = "JARVIS_GIT_ASKPASS_TOKEN";

/**
 * D-103 HOST-FIX: git-argv-prefiks som må stå FØRST i argv (før subkommandoen
 * `clone`/`push`) på AKKURAT de to nettverks-autentiserte git-kallene, for å
 * hindre en ambient `credential.helper` (Windows Git Credential Manager,
 * eller enhver annen system/global-konfigurert helper) fra å svare FØR
 * `GIT_ASKPASS` i det hele tatt konsulteres. Se doc-kommentaren over for full
 * begrunnelse. `-c credential.helper=` er git sin EGEN, dokumenterte
 * "nullstill helper-kjeden for denne ene prosessen"-mekanisme - IKKE en
 * Jarvis-oppfunnet mekanisme. Eksportert (ikke bare hardkodet i coding.ts)
 * slik at testene kan verifisere AKKURAT denne argv-prefiksen er tilstede,
 * og slik at den kun defineres ÉN plass.
 */
export const GIT_CREDENTIAL_ISOLATION_ARGS = ["-c", "credential.helper="] as const;

/**
 * Ren, testbar innholdsgenerator - ALDRI hemmeligheten selv, kun logikken som
 * leser den fra `process.env[GIT_ASKPASS_TOKEN_ENV]` ved kjøretid. Git kaller
 * skriptet med ÉN argv-verdi (prompt-teksten, f.eks. "Username for '...': "
 * eller "Password for '...': ") - token vises ALDRI i argv, KUN i stdout som
 * svar på et password-prompt.
 */
export function generateAskpassScriptContent(): string {
  return [
    "#!/usr/bin/env node",
    "const prompt = process.argv[2] || \"\";",
    "if (/username/i.test(prompt)) {",
    "  process.stdout.write(\"x-access-token\");",
    "} else {",
    `  process.stdout.write(process.env[${JSON.stringify(GIT_ASKPASS_TOKEN_ENV)}] || "");`,
    "}",
    ""
  ].join("\n");
}

/**
 * D-103 HOST-FIX: Windows kan ikke kjøre `askpass.cjs` direkte (ingen shebang-
 * støtte i `CreateProcess()`) - denne minimale `.cmd`-batch-wrapperen kaller
 * node EKSPLISITT med skriptet som argument. `%*` videresender ALLE argumenter
 * git gir (den ene prompt-tekst-argv-verdien) uendret. INGEN hemmelighet her -
 * kun stier (node-binær + skriptfil), som begge allerede er lokale, ikke-
 * sensitive filsystem-plasseringer.
 */
export function generateAskpassWindowsWrapper(nodeExecPath: string, scriptPath: string): string {
  return `@"${nodeExecPath}" "${scriptPath}" %*\r\n`;
}

/**
 * D-103 HOST-FIX: bygger den FAKTISKE `GIT_ASKPASS`-verdien, PLATTFORM-
 * BETINGET (se doc-kommentaren over `GIT_ASKPASS_TOKEN_ENV` for full
 * empirisk begrunnelse). `askpassPath` er allerede den RIKTIGE artefakten
 * for plattformen (bare `.cjs`-sti på POSIX, `.cmd`-wrapper-sti på Windows) -
 * denne funksjonen avgjør KUN om verdien skal anførselstegnes. Ren/testbar
 * uten filsystem-tilgang: tar plattform som eksplisitt parameter i stedet
 * for å lese `process.platform` selv, slik at begge grener kan testes
 * deterministisk uavhengig av CI-plattformen testen faktisk kjører på.
 */
export function buildAskpassEnvValue(platform: NodeJS.Platform, askpassPath: string): string {
  return platform === "win32" ? `"${askpassPath}"` : askpassPath;
}

export interface GitAuthHandle {
  /** Ekstra prosess-env KUN for git clone/push - aldri agentens/øvrige git-kall. */
  readonly env: Readonly<Record<string, string>>;
  /** Fjerner det ephemere askpass-skriptet. MÅ kalles i `finally`, uavhengig av `sandbox.dispose()`. */
  cleanup(): Promise<void>;
}

export async function createGitAuthHandle(token: string): Promise<GitAuthHandle> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-git-askpass-"));
  const scriptPath = join(dir, "askpass.cjs");
  await writeFile(scriptPath, generateAskpassScriptContent(), "utf8");
  // POSIX: gjør skriptet direkte kjørbart via dets shebang-linje - dette ER
  // den faktiske invokeringsmekanismen på POSIX nå (se fiks del 2 over), ikke
  // bare en "hyggelig å ha"-rettighet. No-op (og ufarlig å ignorere) på
  // Windows, som ikke har et tilsvarende filrettighets-konsept.
  await chmod(scriptPath, 0o700).catch(() => undefined);

  let askpassPath = scriptPath;
  if (process.platform === "win32") {
    askpassPath = join(dir, "askpass.cmd");
    await writeFile(askpassPath, generateAskpassWindowsWrapper(process.execPath, scriptPath), "utf8");
  }

  return {
    env: {
      GIT_ASKPASS: buildAskpassEnvValue(process.platform, askpassPath),
      GIT_TERMINAL_PROMPT: "0",
      [GIT_ASKPASS_TOKEN_ENV]: token
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
