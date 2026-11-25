#!/bin/bash
# Bruk: mk-build-wt.sh <worktree-navn> <ny-gren>   (starter fra origin/main; krever at origin peker på FFrollerskis/jarvis-build)
set -u
N="$1"; BR="$2"
export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH
ROOT=/home/user/jarvisbuild
cd "$ROOT" || exit 1
url=$(git remote get-url origin); [ "$url" = "https://github.com/FFrollerskis/jarvis-build.git" ] || { echo "origin peker feil: $url"; exit 1; }
d="$ROOT/.claude/worktrees/$N"
if [ -e "$d" ]; then echo "FINNES: $d"; exit 1; fi
HOME=/root git worktree add -b "$BR" "$d" origin/main 2>&1 | tail -1
cd "$d" || exit 1
echo "== $N: HEAD $(git rev-parse --short HEAD) install $(date -u +%T)"
pnpm install --frozen-lockfile 2>&1 | tail -n 3
pk=$(ls -d node_modules/.pnpm/@embedded-postgres+linux-x64*/node_modules/@embedded-postgres/linux-x64 2>/dev/null | head -1)
if [ -n "$pk" ]; then (cd "$pk" && node scripts/hydrate-symlinks.js 2>&1 | tail -1); else echo "ADVARSEL: fant ikke embedded-postgres-pakken"; fi
chmod o+w "$d" "$d/node_modules" 2>&1 | tail -1
echo "== $N ferdig $(date -u +%T)"
