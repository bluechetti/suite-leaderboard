#!/usr/bin/env bash
# Rebuild the leaderboard's data from git history and put it in site/data/.
#
# Works in ./work (kept between runs by the Actions cache): bare clones without file contents,
# the rank snapshot used for movement arrows, and the GitHub activity counts once they're synced.
# Needs git and python3. Takes about a minute from scratch, seconds after that.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W="$ROOT/work"
mkdir -p "$W/state" "$W/repos" "$ROOT/site/data"
cd "$W"
export GIT_LFS_SKIP_SMUDGE=1

cp "$ROOT/pipeline/analyze2.py" "$ROOT/pipeline/aliases_hashed.json" "$ROOT/pipeline/gh_counts.json" .
if [ -f state/aliases_learned.json ]; then cp state/aliases_learned.json .; else rm -f aliases_learned.json; fi

# Rank movement is measured against the last build of the previous UTC day.
TODAY=$(date -u +%F)
if [ -f state/snap.csv ] && [ "$(cat state/snap.day 2>/dev/null)" != "$TODAY" ]; then
  cp state/snap.csv state/prev.csv
  cp state/snap.at state/prev.at
fi
if [ -f state/prev.csv ]; then
  cp state/prev.csv people_prev.csv; cp state/prev.at people_prev.at
else
  cp "$ROOT/pipeline/people_prev.csv" people_prev.csv; printf '2026-11-23T01:45:29Z' > people_prev.at
fi

# name, GitHub repo, branch. Every public tangency-labs repo with history, plus CamCraft.
# The solidcore repo is left out: it copies SolidCraft's kernel commits.
REPOS=(
  "solidcraft tangency-labs/solidcraft main"
  "fieldcraft tangency-labs/fieldcraft develop"
  "pcbcraft tangency-labs/pcbcraft main"
  "pcbcraft-gpl tangency-labs/pcbcraft-gpl main"
  "pcbcraft-app tangency-labs/pcbcraft-app main"
  "camcraft NeoTech/Camcraft main"
  "solidcore-viewer tangency-labs/solidcore-viewer main"
  "website tangency-labs/website main"
  "models tangency-labs/models main"
  "solidcore-goldens tangency-labs/solidcore-goldens main"
  "design tangency-labs/design main"
  "leaderboard tangency-labs/leaderboard main"
  "solidcraft-library tangency-labs/solidcraft-library main"
  "homebrew-tap tangency-labs/homebrew-tap main"
  "solidcraft-app tangency-labs/solidcraft-app main"
  "solidcraft-app-rc tangency-labs/solidcraft-app-rc main"
)
for entry in "${REPOS[@]}"; do
  read -r name slug branch <<<"$entry"
  dir="repos/$name"
  if [ -d "$dir" ]; then
    git -C "$dir" fetch -q --filter=blob:none origin "+refs/heads/$branch:refs/heads/$branch" || echo "fetch failed: $name (using what's saved)"
  else
    git clone -q --bare --filter=blob:none --single-branch --branch "$branch" "https://github.com/$slug.git" "$dir" || { echo "clone failed: $name"; rm -rf "$dir"; continue; }
  fi
  git -C "$dir" log "$branch" --format='%H%x1f%aN%x1f%aE%x1f%cN%x1f%cE%x1f%aI%x1f%s%x1f%cI%x1e' > "logs_$name.txt"
  git -C "$dir" log "$branch" --format='%x1e%H' --name-only --no-renames > "files_$name.txt"
  git -C "$dir" log "$branch" --format='%H %P' > "parents_$name.txt"
  echo "$name: $(git -C "$dir" rev-list --count "$branch") commits"
done

python3 -I analyze2.py

# Issue, triage and review counts: the synced ones when available, else the starting copy.
if [ -f state/gh_counts.csv ]; then cp state/gh_counts.csv gh_counts.csv; fi

python3 -I - "$TODAY" <<'EOF'
import csv, json, sys
m = json.load(open('meta.json'))
with open('meta.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['generated_at', 'people', 'prs_merged', 'commits', 'previous_from'])
    w.writerow([m['generated_at'], m['people'], m['prs_merged'], m['commits'], m.get('previous_from', '')])
# Today's ranks, for tomorrow's movement arrows.
with open('state/snap.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['login', 'name', 'rank'])
    for r in csv.DictReader(open('people.csv')):
        if r['rank']:
            w.writerow([r['login'], r['name'], r['rank']])
open('state/snap.at', 'w').write(m['generated_at'])
open('state/snap.day', 'w').write(sys.argv[1])
EOF

cp people.csv areas.csv person_areas.csv gh_counts.csv meta.csv "$ROOT/site/data/"
echo "done: $(tail -1 meta.csv)"
