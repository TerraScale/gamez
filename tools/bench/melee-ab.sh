#!/usr/bin/env bash
# A/B of the classic melee bench (src/melee.ts): the current checkout against
# BASE (a commit that has melee.ts), interleaved ROUNDS times so both sides
# share the host's load. Each run prints its table and the end hashes, which
# must match between the sides when a change keeps behaviour.
#
# Usage (repo root): tools/bench/melee-ab.sh <base-commit> [rounds]
# On a dev host: ts-heavy-any tools/bench/melee-ab.sh <base> 3 --repo gamez --branch <branch>
set -euo pipefail
base_rev=${1:?usage: melee-ab.sh <base-commit> [rounds]}
rounds=${2:-3}
root=$(pwd)

bootstrap() {
  if [ ! -x node_modules/.bin/vp ]; then
    vp_root="$HOME/.local/share/mise/installs/viteplus/global/node_modules"
    mkdir -p node_modules/.bin
    ln -s "$vp_root/vite-plus" node_modules/vite-plus
    ln -s "$vp_root/.bin/vp" node_modules/.bin/vp
  fi
  node_modules/.bin/vp install --frozen-lockfile >/dev/null
}

base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
git archive "$base_rev" | tar -x -C "$base"
(cd "$base" && bootstrap)
bootstrap

run() {
  (cd "$1" && BENCH_RESULTS="melee-ab-$2" node --experimental-transform-types --no-warnings tools/bench/src/melee.ts | grep '^|')
}

echo "host $(hostname -s), base $base_rev, new $(git rev-parse --short HEAD), $(nproc) cpus"
for i in $(seq 1 "$rounds"); do
  echo "## round $i ($(cut -d' ' -f1-3 /proc/loadavg))"
  if [ $((i % 2)) -eq 1 ]; then
    echo "base:"; run "$base" base
    echo "new:"; run "$root" new
  else
    echo "new:"; run "$root" new
    echo "base:"; run "$base" base
  fi
done
