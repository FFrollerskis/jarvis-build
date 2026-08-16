// Q-20 HOST RECOVERY #1 (2026-08-16): liten, isolert sjekk av at
// `modules/erasure` faktisk kan resolve sine workspace-avhengigheter -
// kjøres av `modules/core/scripts/q20-host-run.ts` RETT ETTER `pnpm install`,
// FØR selve `q20-erasure-live.ts` startes. Root cause for host-feilen: en NY
// workspace-pakke (`modules/erasure`) ble lagt til i denne branchen, men
// hosten sin `node_modules` var aldri bootstrappet for den (pnpm install ble
// sist kjørt FØR pakken eksisterte) - `@jarvis/core` kunne derfor ikke
// resolves fra `modules/erasure/scripts/q20-erasure-live.ts`.
//
// Skriver KUN et trygt, maskinlesbart PASS/FAIL - ingen secrets.

async function main(): Promise<void> {
  try {
    await import("@jarvis/core");
    await import("@jarvis/knowledge");
    await import("@jarvis/memory");
    await import("@jarvis/policy");
    await import("@jarvis/contracts");
    console.log("erasure_workspace_dependencies=PASS");
  } catch (err) {
    console.log("erasure_workspace_dependencies=FAIL");
    console.error(`[verify-workspace] ${(err as Error).message}`);
    process.exit(1);
  }
}

await main();
