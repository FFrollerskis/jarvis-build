# Push fra din egen PC, versjon b (inkluderer WP-N1)

Dette erstatter `local-only-2026-11-22a.bundle` og `PUSH-FRA-PC.md`. Har du allerede pushet de 13 grenene fra a: bruk bare linjene merket «NY» under (resten sier «Everything up-to-date», det er greit). Ingenting er farlig: kommandoene bruker aldri `--force`, og de endrer ikke `main`.

**Du trenger:** filen `local-only-2026-11-22b.bundle` lagret f.eks. i `C:\Temp\`. Ikke kjør i `C:\Users\<deg>` (det er ikke et git-lager): kommandoene under lager en egen klone i `C:\Temp`.

## Lim inn i PowerShell (alle linjene i én omgang; IKKE med de tre bakstrekene)
```
cd C:\Temp
git clone https://github.com/tsworkflow/jarvisbuild.git
cd jarvisbuild
git bundle verify C:\Temp\local-only-2026-11-22b.bundle
git fetch C:\Temp\local-only-2026-11-22b.bundle 'refs/heads/*:refs/remotes/bundle/*'
git push origin refs/remotes/bundle/claude/wp-k-ledger-rester:refs/heads/claude/wp-k-ledger-rester
git push origin refs/remotes/bundle/claude/wp-h1-control-centers:refs/heads/claude/wp-h1-control-centers
git push origin refs/remotes/bundle/claude/wp-i-connector-sdk:refs/heads/claude/wp-i-connector-sdk
git push origin refs/remotes/bundle/claude/wp-h2-control-centers:refs/heads/claude/wp-h2-control-centers
git push origin refs/remotes/bundle/claude/wp-b3-evolution-centers:refs/heads/claude/wp-b3-evolution-centers
git push origin refs/remotes/bundle/claude/wp-d3-growth-writes:refs/heads/claude/wp-d3-growth-writes
git push origin refs/remotes/bundle/claude/wp-b4-claude-budget-pacing:refs/heads/claude/wp-b4-claude-budget-pacing
git push origin refs/remotes/bundle/claude/wp-g1-comms:refs/heads/claude/wp-g1-comms
git push origin refs/remotes/bundle/claude/wp-g2-personal:refs/heads/claude/wp-g2-personal
git push origin refs/remotes/bundle/claude/wp-g3-vision:refs/heads/claude/wp-g3-vision
git push origin refs/remotes/bundle/claude/wp-g4-situation-bridges:refs/heads/claude/wp-g4-situation-bridges
git push origin refs/remotes/bundle/claude/d471-d474-konsolidering:refs/heads/claude/d471-d474-konsolidering
git push origin refs/remotes/bundle/claude/wp-n1-restricted-history:refs/heads/claude/wp-n1-restricted-history
git push origin refs/remotes/bundle/claude/lead-notes-2026-11:refs/heads/claude/lead-notes-2026-11
```
- Har du allerede en klone et annet sted: hopp over de tre første linjene (`cd`, `git clone`, `cd`) og gå inn i klonen med `cd`.
- Står det at mappen `C:\Temp\jarvisbuild` finnes fra før: skriv `cd C:\Temp\jarvisbuild` og lim inn resten fra `git bundle verify` og nedover.
- Første gang spør GitHub om innlogging (nettleservindu): godkjenn det.
- NY i versjon b: `claude/wp-n1-restricted-history` (WP-N1). Den er bygget oppå de andre grenene og er bare en sikkerhetskopi på GitHub; selve PR-en lager jeg etter at de andre er merget.

## Sjekk at det gikk
```
git ls-remote --heads origin "claude/wp-*" "claude/d471-d474-konsolidering" "claude/lead-notes-2026-11"
```
Du skal se 14 grener. Skriv «pushet» til meg etterpå.

## Hva skjer så
- Grenene står på GitHub, så arkitekten kan begynne å lese dem. Rekkefølgen for PR-ene er K, H1, I, H2, B3, D3, B4, G1, G2, G3, G4, docs, N1.
- Draft-PR-ene lager jeg når GitHub-verktøyene mine virker igjen. Vil du ikke vente: åpne dem selv i nettleseren (knappen «Compare & pull request» ved hver gren, huk av «Draft»). Ferdige PR-tekster ligger i grenen `claude/lead-notes-2026-11`, mappen `drafts/` (`pr-01-…` til `pr-13-…`).
- Ikke push `integration/*`-grener og ikke merge noe til `main` ennå: merging skjer først etter arkitektens review.
