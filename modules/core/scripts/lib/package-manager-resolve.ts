// Q-20 HOST RECOVERY #2 (2026-08-16): Node sin `child_process.spawnSync`/
// `execFileSync` UTEN `shell: true` gjør IKKE Windows sin PATHEXT-baserte
// utvidelsesoppløsning (`.CMD`/`.EXE`/`.BAT`) - kun cmd.exe/PowerShell gjør
// det. `pnpm` er normalt installert som `pnpm.cmd` (eller et Corepack-shim)
// på Windows - et rått `spawnSync("pnpm", ...)`-kall feiler derfor med
// `ENOENT` selv om `pnpm` fungerer helt fint fra Tobias sin egen PowerShell.
// Dette er IKKE unix-oppførsel (der `execFileSync("pnpm", ...)` allerede
// gjør korrekt PATH-oppslag via execvp).
//
// Rene, testbare funksjoner - ingen side-effekter, ingen prosess-spawning
// her (det gjør selve `q20-host-run.ts`). Alle avhengigheter (PATH/PATHEXT/
// filsystem-eksistens/plattform) injiseres eksplisitt for testbarhet uten
// en ekte Windows-vert.

export interface PathLookupEnv {
  platform: NodeJS.Platform;
  /** `process.env.PATH` (POSIX) eller `process.env.Path`/`PATH` (Windows - case kan variere). */
  pathEnv: string;
  /** `process.env.PATHEXT` (kun relevant på Windows). Standard Windows-default hvis mangler. */
  pathExt: string;
  exists: (path: string) => boolean;
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Finner en kjørbar fil på PATH. På Windows prøves hver PATHEXT-utvidelse
 * (samme rekkefølge cmd.exe selv ville brukt); på andre plattformer letes
 * det etter det bare navnet direkte (unix trenger ingen utvidelse).
 * Returnerer den FULLSTENDIGE stien til første treff, eller `undefined`.
 */
export function findExecutableOnPath(name: string, env: PathLookupEnv): string | undefined {
  const sep = env.platform === "win32" ? ";" : ":";
  const dirs = env.pathEnv.split(sep).filter((d) => d.length > 0);
  const extensions = env.platform === "win32" ? (env.pathExt || DEFAULT_WINDOWS_PATHEXT).split(";").filter(Boolean) : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      // join() unngås bevisst (holder denne fila fri for `node:path`-importen -
      // triviell, plattform-uavhengig sti-sammenslåing er trygg nok her, og
      // gjør testene enklere å skrive med rene streng-fixtures).
      const separator = dir.endsWith("/") || dir.endsWith("\\") ? "" : env.platform === "win32" ? "\\" : "/";
      const candidate = `${dir}${separator}${name}${ext}`;
      if (env.exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface PinnedPackageManager {
  name: string;
  version: string;
}

/** Leser `packageManager`-feltet fra root `package.json` (f.eks. `"pnpm@9.15.9"`). */
export function readPinnedPackageManager(packageJsonContent: string): PinnedPackageManager | undefined {
  const parsed = JSON.parse(packageJsonContent) as { packageManager?: string };
  if (!parsed.packageManager) {
    return undefined;
  }
  const match = /^([^@]+)@(.+)$/.exec(parsed.packageManager);
  if (!match) {
    return undefined;
  }
  return { name: match[1]!, version: match[2]! };
}

export interface ResolvedPackageManager {
  driver: "pnpm" | "pnpm.cmd" | "corepack";
  /** Absolutt sti til den kjørbare filen som faktisk skal spawnes. */
  command: string;
  /** Argumenter som må stå FØR de faktiske pnpm-kommandoargumentene (f.eks. `pnpm@9.15.9` for Corepack). */
  argsPrefix: string[];
  /** `true` KUN når `command` er et Windows batch-shim (`.cmd`/`.bat`) som MÅ tolkes av cmd.exe for å kjøres i det hele tatt (native `.exe`/`.com` trenger det ALDRI). */
  requiresCmdWrapper: boolean;
}

/**
 * Deterministisk oppløsningsrekkefølge (§3 i BO-en):
 *  1. `pnpm` (evt. `pnpm.cmd` på Windows) direkte på PATH.
 *  2. Ellers `corepack` (evt. `corepack.cmd`) på PATH - påkalt med
 *     EKSPLISITT pinnet versjon (`corepack pnpm@<versjon> ...`) - krever
 *     ALDRI `corepack enable` (som kan trenge forhøyede rettigheter).
 *  3. Ellers: fail-closed med en tydelig, handlingsrettet feilmelding.
 *
 * `command` er ALLTID en sti funnet på filsystemet (aldri brukerstyrt input).
 */
export function resolvePackageManager(env: PathLookupEnv, pinned: PinnedPackageManager): ResolvedPackageManager {
  const pnpmPath = findExecutableOnPath("pnpm", env);
  if (pnpmPath) {
    const isWindows = env.platform === "win32";
    return { driver: isWindows ? "pnpm.cmd" : "pnpm", command: pnpmPath, argsPrefix: [], requiresCmdWrapper: isWindows && isBatchShim(pnpmPath) };
  }

  const corepackPath = findExecutableOnPath("corepack", env);
  if (corepackPath) {
    const isWindows = env.platform === "win32";
    return {
      driver: "corepack",
      command: corepackPath,
      argsPrefix: [`${pinned.name}@${pinned.version}`],
      requiresCmdWrapper: isWindows && isBatchShim(corepackPath)
    };
  }

  throw new Error(
    "package_manager_resolution=FAIL: fant verken pnpm eller corepack på PATH. " +
      "Installer pnpm (https://pnpm.io/installation/) - IKKE nødvendig å kjøre 'corepack enable' " +
      "eller endre PATH manuelt utover det en normal Node/pnpm-installasjon allerede gjør."
  );
}

function isBatchShim(resolvedPath: string): boolean {
  return /\.(cmd|bat)$/i.test(resolvedPath);
}

export interface SpawnInvocation {
  command: string;
  args: string[];
}

const DEFAULT_COMSPEC = "C:\\Windows\\System32\\cmd.exe";

/**
 * DEP0190-sikker invokasjon (Q-20 HOST RECOVERY #3): Node advarer/vil
 * fjerne støtte for å kombinere `shell: true` med et args-array (nettopp
 * fordi Node da selv må gjette hvordan de skal escapes - en reell
 * injeksjonsrisiko for VARIABEL input). Løsningen her bruker ALDRI
 * `shell: true`: et Windows `.cmd`/`.bat`-shim kan strukturelt ikke
 * kjøres direkte av `CreateProcess` (kun cmd.exe kan tolke batch-filer),
 * så vi kaller cmd.exe SELV som en helt vanlig, ikke-shell barneprosess med
 * et EKSPLISITT, internt kontrollert argv-array (`/d /s /c <sti> <args>`)
 * - identisk mønster til det etablerte `cross-spawn`-biblioteket bruker for
 * nøyaktig dette problemet. `command`/`args` her stammer UTELUKKENDE fra
 * filsystem-oppløsning (`resolvePackageManager`) og statiske, repo-egne
 * argumenter - ALDRI fra ubetrodd/brukerstyrt input.
 */
export function buildSpawnInvocation(
  resolved: ResolvedPackageManager,
  args: string[],
  comSpec: string = process.env["ComSpec"] || process.env["COMSPEC"] || DEFAULT_COMSPEC
): SpawnInvocation {
  const fullArgs = [...resolved.argsPrefix, ...args];
  if (!resolved.requiresCmdWrapper) {
    return { command: resolved.command, args: fullArgs };
  }
  // /d: hopp over AutoRun-registeret (ingen uventet, brukerkonfigurert kode
  // kjøres). /s: korrigerer cmd.exe sin sitat-parsing slik at STIEN til
  // .cmd-filen (som kan inneholde mellomrom, f.eks. "C:\Program Files\...")
  // tolkes som ETT argument, ikke delt opp.
  return { command: comSpec, args: ["/d", "/s", "/c", resolved.command, ...fullArgs] };
}
