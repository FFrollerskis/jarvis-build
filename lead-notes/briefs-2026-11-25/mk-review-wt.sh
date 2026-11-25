#!/bin/bash
# Bruk: mk-review-wt.sh <wp-navn, f.eks. g1c> <gren> <tip-sha>
# Lager to løsrevne review-worktrees (<wp>-rev-a, <wp>-rev-b) på nøyaktig <tip-sha>, installerer avhengigheter,
# hydrerer embedded-postgres-symlinks og gjør mappene skrivbare for brukeren `postgres`. Skriver bare til worktrees (ingen ref-endringer).
set -u
WP="$1"; BR="$2"; TIP="$3"
export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH
ROOT=/home/user/jarvisbuild
cd "$ROOT" || exit 1
git fetch -q origin "$BR" 2>&1 | tail -2
if ! git cat-file -e "$TIP^{commit}" 2>/dev/null; then echo "FEIL: $TIP finnes ikke lokalt"; exit 1; fi
for n in a b; do
  d="$ROOT/.claude/worktrees/$WP-rev-$n"
  if [ -e "$d" ]; then echo "FINNES ALLEREDE: $d (hopper over opprettelse)"; else
    HOME=/root git worktree add --detach "$d" "$TIP" 2>&1 | tail -1
  fi
  cd "$d" || exit 1
  echo "== $n: HEAD $(git rev-parse --short HEAD) install $(date -u +%T)"
  pnpm install --frozen-lockfile 2>&1 | tail -n 3
  pk=$(ls -d node_modules/.pnpm/@embedded-postgres+linux-x64*/node_modules/@embedded-postgres/linux-x64 2>/dev/null | head -1)
  if [ -n "$pk" ]; then (cd "$pk" && node scripts/hydrate-symlinks.js 2>&1 | tail -1); else echo "ADVARSEL: fant ikke embedded-postgres-pakken"; fi
  chmod o+w "$d" "$d/node_modules" 2>&1 | tail -1
  # postgres-brukeren må kunne skrive i selve worktreen (vitest cache, tmp)
  chmod -R o+rX "$d" 2>/dev/null
  echo "== $n ferdig $(date -u +%T)"
  cd "$ROOT" || exit 1
done
echo ALL_DONE
