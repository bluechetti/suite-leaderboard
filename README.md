# SolidCraft suite: all-time leaderboard

Everyone who has worked on SolidCraft, SolidCore, FieldCraft, PCBCraft and CamCraft is ranked here by merged PRs, kernel work, triage, reviews, streaks and more. The page is static and served by GitHub Pages. A GitHub Actions workflow rebuilds it every hour from public git history and GitHub's API.

## Set it up (about 5 minutes)

1. Create a **public** repo, e.g. `suite-leaderboard`, and push this folder to its `main` branch.
2. In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Go to **Actions → Leaderboard → Run workflow** (the run started by your first push fails if Pages wasn't on yet; that's fine). The page goes live at `https://<owner>.github.io/<repo>/` when the build step finishes, about two minutes after the run starts.
4. Optional, but it speeds up the first sync of issue, triage and review counts: create a fine-grained personal token with read-only access to public repos. Save it as the repo secret `LEADERBOARD_TOKEN` under **Settings → Secrets and variables → Actions**.

After that it runs every hour by itself. To run it every 15 minutes, change the `cron` line in `.github/workflows/leaderboard.yml` to `*/15 * * * *`. GitHub pauses scheduled workflows in repos with no commits for 60 days; if that happens, re-enable the workflow from the Actions tab.

## How it works

| Step | Source | Gives |
|---|---|---|
| `pipeline/build.sh` → `pipeline/analyze2.py` | Blobless git clones of every public tangency-labs repo plus NeoTech/Camcraft | Merged PRs per product, commits, kernel commits, last 7 days, streaks, best day, areas, rankings, rank movement |
| `pipeline/alltime.mjs` | GitHub GraphQL and REST, fetching only what changed since the last run | Issues opened, issues commented on (triage), PRs reviewed, and the GitHub account behind each commit email |
| `pipeline/learn-aliases.mjs` | The API data above | Ties commits made with a non-GitHub email to the right person |
| `site/index.html` + `site/shim.js` | `site/data/*.csv` | The page |

Clones, API data and the daily rank snapshot are kept between runs in the Actions cache (`work/`). Nothing personal is published: commit emails are only ever stored as sha256 hashes (`pipeline/aliases_hashed.json`), and the page shows names and GitHub logins only.

Merged PRs are counted from what landed on each repo's main branch. SolidCraft and FieldCraft squash each PR into one commit ending in `(#n)`. PCBCraft and CamCraft keep merge commits, credited to the branch owner. Maintainers (bherbruck, jyviko, NeoTech) are listed separately, as on the official daily board. The page's "rules" section defines every stat and how certain it is.

## Run it locally

```sh
bash pipeline/build.sh                        # git stats → site/data/
GITHUB_TOKEN=$(gh auth token) node pipeline/alltime.mjs --extra NeoTech/Camcraft:main --no-git --cache work/api-cache --out work/counts
python3 -m http.server -d site 8000           # open http://localhost:8000
npm test                                      # tests for the API sync
```

## Changing what's counted

- **Repos:** the `REPOS` list in `pipeline/build.sh`, and `--extra` in the workflow for outside repos' API counts.
- **Maintainers, bots, product names, code areas:** at the top of `pipeline/analyze2.py`.
- **Commit email that isn't tied to a GitHub account:** add `"<sha256 of the lowercased email>": "login"` to `pipeline/aliases_hashed.json`. A plain `{"email": "login"}` in `pipeline/aliases.json` also works, but it publishes the email in the repo.
