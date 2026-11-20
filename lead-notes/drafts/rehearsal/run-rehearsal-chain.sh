#!/bin/bash
# Full suite per mellomtilstand i PR-rekkefølgen. KUN lokalt. Gjenopptakbar (markørfiler). Én worktree gjenbrukes.
export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH
REPO=/home/user/jarvisbuild
W=$REPO/.claude/worktrees/rh
L=/tmp/lead/logs
CHAIN=$L/rehearsal-chain.log
STATES="${STATES:-04-h2 06-d3-growth-writes 07-b4-claude-budget-pacing 08-g1-comms 09b-g2-test-adapt 10-g3-vision}"
mkdir -p "$L"
cd "$REPO" || exit 1
first=$(echo $STATES | awk '{print $1}')
if [ ! -d "$W" ]; then git worktree add --detach "$W" "refs/rehearsal/$first" >/dev/null 2>&1 || { echo "worktree feilet" >> $CHAIN; exit 1; }; fi
for s in $STATES; do
  [ -f "$L/rehearsal-$s.done" ] && { echo "== $s hoppet over (ferdig)" >> $CHAIN; continue; }
  cd "$W" || exit 1
  echo "== $s start $(date -u +%FT%TZ)" >> $CHAIN
  git checkout -q --detach "refs/rehearsal/$s" || { echo "$s: checkout FEILET" >> $CHAIN; continue; }
  echo "$s: HEAD $(git rev-parse --short HEAD) tre $(git rev-parse --short HEAD^{tree})" >> $CHAIN
  pnpm install --frozen-lockfile > "$L/rehearsal-$s-install.log" 2>&1; echo "$s: install exit=$?" >> $CHAIN
  chmod o+w "$W" "$W/node_modules" 2>/dev/null
  EP=$(ls -d "$W"/node_modules/.pnpm/@embedded-postgres+linux-x64*/node_modules/@embedded-postgres/linux-x64 2>/dev/null | head -n1)
  [ -n "$EP" ] && (cd "$EP" && node scripts/hydrate-symlinks.js >/dev/null 2>&1)
  pnpm -r --workspace-concurrency=2 run typecheck > "$L/rehearsal-$s-static.log" 2>&1; echo "$s: typecheck exit=$?" >> $CHAIN
  pnpm lint >> "$L/rehearsal-$s-static.log" 2>&1; echo "$s: lint exit=$?" >> $CHAIN
  pnpm check:containment >> "$L/rehearsal-$s-static.log" 2>&1; echo "$s: containment exit=$?" >> $CHAIN
  flock /tmp/fullsuite.lock su postgres -s /bin/bash -c "export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:\$PATH; cd $W && pnpm exec vitest run --maxWorkers=2 --exclude '**/embedded-postgres-ipv4-contention*'" > "$L/rehearsal-$s-suite.log" 2>&1
  echo "$s: suite exit=$? $(date -u +%T)" >> $CHAIN
  grep -a -E "^ +(Test Files|Tests) " "$L/rehearsal-$s-suite.log" | sed "s/^ */$s: /" >> $CHAIN
  grep -a -E "^ *(FAIL|×) " "$L/rehearsal-$s-suite.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-170 | sort -u | head -n 30 | sed "s/^/$s: /" >> $CHAIN
  touch "$L/rehearsal-$s.done"
  echo "== $s ferdig $(date -u +%FT%TZ)" >> $CHAIN
done
echo "ALL_DONE $(date -u +%FT%TZ)" >> $CHAIN
