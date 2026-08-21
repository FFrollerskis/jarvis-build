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
 * ALDRI en interaktiv/ambient-avhengig fallback-prompt. GIT_ASKPASS peker på
 * `"<node-binær>" "<skriptsti>"` (BEGGE segmenter anførselstegnet) - git
 * tolker verdien som en kommandolinje, ikke en bar executable-sti (samme,
 * veldokumenterte kryssplattform-mønster som f.eks. VS Codes git-integrasjon
 * bruker) - fungerer identisk på Windows og Linux uten Tobias-spesifikke
 * stier. Skriptet skrives i en EGEN, dedikert temp-katalog - ALDRI inne i
 * `sandbox.workdir` (som `git clone <url> .` krever TOM for å ikke feile).
 */
export const GIT_ASKPASS_TOKEN_ENV = "JARVIS_GIT_ASKPASS_TOKEN";

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

export interface GitAuthHandle {
  /** Ekstra prosess-env KUN for git clone/push - aldri agentens/øvrige git-kall. */
  readonly env: Readonly<Record<string, string>>;
  /** Fjerner det ephemere askpass-skriptet. MÅ kalles i `finally`, uavhengig av `sandbox.dispose()`. */
  cleanup(): Promise<void>;
}

function quoteForAskpass(value: string): string {
  return `"${value}"`;
}

export async function createGitAuthHandle(token: string): Promise<GitAuthHandle> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-git-askpass-"));
  const scriptPath = join(dir, "askpass.cjs");
  await writeFile(scriptPath, generateAskpassScriptContent(), "utf8");
  // POSIX-only; no-op (og ufarlig å ignorere) på plattformer uten filrettigheter (Windows).
  await chmod(scriptPath, 0o700).catch(() => undefined);
  return {
    env: {
      GIT_ASKPASS: `${quoteForAskpass(process.execPath)} ${quoteForAskpass(scriptPath)}`,
      GIT_TERMINAL_PROMPT: "0",
      [GIT_ASKPASS_TOKEN_ENV]: token
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
