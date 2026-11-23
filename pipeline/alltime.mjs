#!/usr/bin/env node
// All-time contributor leaderboard for every public repo in a GitHub organization.
//
// Usage:
//   GITHUB_TOKEN=$(gh auth token) node scripts/alltime.mjs
//
// Options:
//   --org <login>        organization (default tangency-labs)
//   --repos a,b,c        only these repos (default: every public, non-fork repo)
//   --cache <dir>        where clones and API data are kept between runs (default .cache)
//   --out <dir>          where results are written (default out)
//   --offline            don't fetch anything; rebuild results from the cache
//   --no-git             skip git (no commits, streak days from commits or areas)
//   --no-api             skip GitHub's API (git only; needs a repo list in the cache or --repos)
//   --max-pages <n>      stop each API listing after n pages (for quick tests)
//   --extra owner/name:branch,...  also include repos outside the organization (e.g. NeoTech/Camcraft:main)
//
// Sources, and why each is used:
//   git (blobless clone)  files each commit changed, for areas. Free and exact.
//   GraphQL               PRs (author, merged by, reviews, closed issues, lines), issues,
//                         and the GitHub account behind every commit. Needs a token.
//   REST                  every issue and PR comment, and every inline review comment,
//                         listed per repo with ?since= so later runs fetch only new ones.
// After the first run only items updated since the previous run are fetched.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

// ---------- configuration ----------

const ARGS = parseArgs(process.argv.slice(2));
const ORG = ARGS.org || 'tangency-labs';
const CACHE = ARGS.cache || '.cache';
const OUT = ARGS.out || 'out';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''); // set by Actions; also lets tests use a fake server
const MAX_PAGES = ARGS['max-pages'] ? Number(ARGS['max-pages']) : Infinity;
const TZ = 'America/New_York'; // same day boundaries as the official daily leaderboard
const MAINTAINERS = ['bherbruck', 'jyviko', 'NeoTech']; // shown on their own line, like the daily board

// Which product each repo belongs to. Anything not listed is "Other".
const PRODUCTS = {
  solidcraft: 'SolidCraft',
  solidcore: 'SolidCore',
  fieldcraft: 'FieldCraft',
  pcbcraft: 'PCBCraft',
  'pcbcraft-gpl': 'PCBCraft',
  'pcbcraft-app': 'PCBCraft',
  Camcraft: 'CamCraft',
};
// Repos outside the organization, added with --extra, and who owns them.
const OWNERS = {};
const ownerOf = (repo) => OWNERS[repo] || ORG;
// Repos whose commits are copies of another repo's commits. Their commits are not counted
// again; their own PRs, issues and comments still are.
const MIRRORS = { solidcore: 'solidcraft' };
// Repos to leave out entirely (forks of outside code are skipped automatically).
const EXCLUDE = new Set(['smlib']);

// Parts of SolidCraft, by folder. Other repos count as one area each (their product name).
function solidcraftArea(path) {
  const p = path.split('/');
  const top = p[0];
  const sub = p[1] || '';
  if (top === 'solidcore' || path.startsWith('tests/kernel-cases') ||
      (top === 'crates' && (sub.startsWith('solidcore') || ['kernel', 'smlib', 'geom', 'goldens', 'difftest'].includes(sub)))) {
    return 'Geometry kernel (SolidCore)';
  }
  if (top === 'crates' && sub === 'sketch') return 'Sketch and constraints';
  if (top === 'crates' && ['engine', 'doc', 'dynamics', 'derive', 'display-units', 'space'].includes(sub)) return 'Modeling engine and document';
  if (top === 'assets' || (top === 'crates' && (sub.startsWith('ui') || sub.startsWith('viewport') ||
      ['render', 'gpu', 'look', 'theme', 'panel-layout', 'color', 'views', 'control-egui', 'control', 'space-mouse', 'threedx-client'].includes(sub)))) {
    return 'User interface and viewport';
  }
  if (top === 'crates' && (['io', 'format'].includes(sub) || sub.startsWith('step'))) return 'File import and export';
  if ((top === 'crates' && (sub.startsWith('mcp') || sub.startsWith('craft-plugin'))) || (top === 'apps' && sub.includes('cli')) ||
      top === 'skills' || ['docs/mcp.md', 'docs/control-protocol.md', 'docs/plugins.md', 'docs/agent-chat.md'].includes(path)) {
    return 'MCP / CLI / plugins';
  }
  if (top === 'apps' || top === 'site') return 'Desktop and web apps';
  if (['docs', 'plan', 'reports', 'attribution'].includes(top) || (p.length === 1 && /\.(md|txt)$/.test(path))) return 'Docs and planning';
  return 'Tests and tooling';
}
const NON_CODE_AREAS = new Set(['Docs and planning', 'Tests and tooling']);
const KERNEL_AREA = 'Geometry kernel (SolidCore)';

function areasFor(repo, files) {
  const product = PRODUCTS[repo];
  if (product === 'SolidCraft') return files.length ? [...new Set(files.map(solidcraftArea))] : ['Tests and tooling'];
  return [product || 'Website and other repos'];
}

// Same bot rule as the daily leaderboard, plus AI-agent identities that commit without an account.
const isBotLogin = (login, type) =>
  type === 'Bot' || /\[bot\]$/i.test(login || '') || /^(coderabbitai|dependabot|renovate|github-actions|copilot|copilot-swe-agent)$/i.test(login || '');
const isAgentName = (name) => /^(codex|claude|claude code|copilot|devin-ai-integration)$/i.test((name || '').trim());

// ---------- small helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const etDay = (iso) => dayFmt.format(new Date(iso)); // YYYY-MM-DD, US Eastern
function isoWeek(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function longestStreak(days) {
  const sorted = [...days].sort();
  let best = 0, cur = 0, prev = null;
  for (const d of sorted) {
    const t = Date.parse(`${d}T12:00:00Z`);
    cur = prev !== null && t - prev === 86400000 ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = t;
  }
  return best;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function writeJson(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

// ---------- GitHub API ----------

const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': `${ORG}-alltime-leaderboard`,
  'x-github-api-version': '2022-11-28',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function waitForLimit(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
  const remaining = res.headers.get('x-ratelimit-remaining');
  let wait = retryAfter ? retryAfter * 1000 : remaining === '0' && reset ? reset - Date.now() + 1000 : 60000 * (attempt + 1);
  wait = Math.max(wait, 5000);
  log(`  rate limited (${res.status}), waiting ${Math.round(wait / 1000)}s`);
  await sleep(wait);
}

async function rest(path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try { res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(90000) }); }
    catch (e) { log(`  network error (${e.name}), retrying`); await sleep(5000 * (attempt + 1)); continue; }
    if (res.ok) return { body: await res.json(), link: res.headers.get('link') || '' };
    if (res.status === 403 || res.status === 429) { await waitForLimit(res, attempt); continue; }
    if (res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  }
  throw new Error(`GET ${path}: gave up after retries`);
}
const nextLink = (link) => (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1];

let graphqlCost = 0;
async function graphql(query, variables) {
  if (!TOKEN) throw new Error('GraphQL needs GITHUB_TOKEN');
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/graphql`, {
        method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) { log(`  network error (${e.name}), retrying`); await sleep(5000 * (attempt + 1)); continue; }
    if (res.status === 403 || res.status === 429) { await waitForLimit(res, attempt); continue; }
    if (res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const json = await res.json();
    if (json.errors && json.errors.length) {
      const limited = json.errors.some((e) => e.type === 'RATE_LIMITED');
      if (limited) { await waitForLimit(res, attempt); continue; }
      // A large page can time out on GitHub's side; let the caller retry with a smaller page.
      if (json.errors.some((e) => /timeout|something went wrong/i.test(e.message || ''))) throw Object.assign(new Error('graphql timeout'), { retrySmaller: true });
      throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`);
    }
    if (json.data && json.data.rateLimit) graphqlCost += json.data.rateLimit.cost;
    return json.data;
  }
  throw new Error('GraphQL: gave up after retries');
}

// Page through a GraphQL connection, newest-updated first, stopping once items are older than `since`.
async function pageConnection({ query, vars, pick, since, pageSize, onNode }) {
  let cursor = null, pages = 0, size = pageSize;
  for (;;) {
    let data;
    try { data = await graphql(query, { ...vars, cursor, size }); }
    catch (e) { if (e.retrySmaller && size > 10) { size = Math.floor(size / 2); continue; } throw e; }
    const conn = pick(data);
    if (!conn) return;
    let reachedOld = false;
    for (const n of conn.nodes) {
      if (since && n.updatedAt && n.updatedAt < since) { reachedOld = true; break; }
      onNode(n);
    }
    pages++;
    if (reachedOld || !conn.pageInfo.hasNextPage || pages >= MAX_PAGES) return;
    cursor = conn.pageInfo.endCursor;
  }
}

const PR_QUERY = `query($owner:String!,$name:String!,$cursor:String,$size:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(first:$size,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title state isDraft createdAt updatedAt mergedAt additions deletions changedFiles
        author{login __typename} mergedBy{login __typename}
        closingIssuesReferences(first:1){totalCount}
        reviews(first:40){totalCount nodes{author{login __typename} state submittedAt}}
      }
    }
  }
  rateLimit{cost remaining resetAt}
}`;
const MORE_REVIEWS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{author{login __typename} state submittedAt}}
  }}
  rateLimit{cost remaining resetAt}
}`;
const ISSUE_QUERY = `query($owner:String!,$name:String!,$cursor:String,$size:Int!){
  repository(owner:$owner,name:$name){
    issues(first:$size,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{number state stateReason createdAt updatedAt closedAt author{login __typename}}
    }
  }
  rateLimit{cost remaining resetAt}
}`;
const HISTORY_QUERY = `query($owner:String!,$name:String!,$cursor:String,$size:Int!,$since:GitTimestamp){
  repository(owner:$owner,name:$name){defaultBranchRef{target{... on Commit{
    history(first:$size,after:$cursor,since:$since){
      pageInfo{hasNextPage endCursor}
      nodes{oid authoredDate parents{totalCount} author{name email user{login}}}
    }
  }}}}
  rateLimit{cost remaining resetAt}
}`;

const reviewTuple = (r) => [r.author ? r.author.login : null, r.author ? r.author.__typename : null, r.state, r.submittedAt];

async function syncPullRequests(repo, store) {
  const since = store.sync.prs;
  const started = new Date().toISOString();
  let n = 0;
  const needMore = [];
  await pageConnection({
    query: PR_QUERY, vars: { owner: ownerOf(repo), name: repo }, pageSize: 50, since,
    pick: (d) => d.repository && d.repository.pullRequests,
    onNode: (p) => {
      store.prs[p.number] = {
        t: p.title, s: p.state, d: p.isDraft, c: p.createdAt, u: p.updatedAt, m: p.mergedAt,
        a: p.author ? p.author.login : null, at: p.author ? p.author.__typename : null,
        mb: p.mergedBy ? p.mergedBy.login : null, mbt: p.mergedBy ? p.mergedBy.__typename : null,
        add: p.additions, del: p.deletions, f: p.changedFiles, ci: p.closingIssuesReferences.totalCount,
        r: p.reviews.nodes.map(reviewTuple), rt: p.reviews.totalCount,
      };
      if (p.reviews.totalCount > p.reviews.nodes.length) needMore.push(p.number);
      n++;
    },
  });
  for (const number of needMore) {
    const all = [];
    let cursor = null;
    for (;;) {
      const d = await graphql(MORE_REVIEWS_QUERY, { owner: ownerOf(repo), name: repo, number, cursor });
      const c = d.repository.pullRequest.reviews;
      all.push(...c.nodes.map(reviewTuple));
      if (!c.pageInfo.hasNextPage) break;
      cursor = c.pageInfo.endCursor;
    }
    store.prs[number].r = all;
  }
  if (MAX_PAGES === Infinity) store.sync.prs = started;
  log(`  ${repo}: ${n} PRs updated${needMore.length ? `, ${needMore.length} with extra reviews` : ''}`);
}

async function syncIssues(repo, store) {
  const since = store.sync.issues;
  const started = new Date().toISOString();
  let n = 0;
  await pageConnection({
    query: ISSUE_QUERY, vars: { owner: ownerOf(repo), name: repo }, pageSize: 100, since,
    pick: (d) => d.repository && d.repository.issues,
    onNode: (i) => {
      store.issues[i.number] = { s: i.state, sr: i.stateReason, c: i.createdAt, u: i.updatedAt, cl: i.closedAt, a: i.author ? i.author.login : null, at: i.author ? i.author.__typename : null };
      n++;
    },
  });
  if (MAX_PAGES === Infinity) store.sync.issues = started;
  log(`  ${repo}: ${n} issues updated`);
}

async function syncHistory(repo, store) {
  // History has no "updated" order, so `since` (commit date) bounds it; a week of overlap
  // catches commits whose dates are older than when they landed.
  const since = store.sync.history ? new Date(Date.parse(store.sync.history) - 7 * 86400000).toISOString() : null;
  const started = new Date().toISOString();
  let n = 0;
  await pageConnection({
    query: HISTORY_QUERY, vars: { owner: ownerOf(repo), name: repo, since }, pageSize: 100, since: null,
    pick: (d) => d.repository && d.repository.defaultBranchRef && d.repository.defaultBranchRef.target.history,
    onNode: (c) => {
      const prev = store.commits[c.oid] || {};
      store.commits[c.oid] = { ...prev, d: c.authoredDate, p: c.parents.totalCount, an: c.author.name, ae: c.author.email || '', a: c.author.user ? c.author.user.login : null };
      n++;
    },
  });
  if (MAX_PAGES === Infinity) store.sync.history = started;
  log(`  ${repo}: ${n} commits checked against GitHub accounts`);
}

async function syncComments(repo, store, kind) {
  // kind "comments": every comment on issues and PRs. kind "reviewComments": inline code review comments.
  const path = kind === 'comments' ? 'issues/comments' : 'pulls/comments';
  const since = store.sync[kind];
  const started = new Date().toISOString();
  let url = `/repos/${ownerOf(repo)}/${repo}/${path}?per_page=100&sort=updated&direction=asc${since ? `&since=${since}` : ''}`;
  let n = 0, pages = 0;
  while (url && pages < MAX_PAGES) {
    const { body, link } = await rest(url);
    for (const c of body) {
      const number = Number(((kind === 'comments' ? c.issue_url : c.pull_request_url) || '').split('/').pop());
      store[kind][c.id] = { u: c.user ? c.user.login : null, ut: c.user ? c.user.type : null, c: c.created_at, n: number };
      n++;
    }
    pages++;
    url = nextLink(link);
  }
  if (!url) store.sync[kind] = started;
  log(`  ${repo}: ${n} ${kind === 'comments' ? 'comments' : 'review comments'} updated${url ? ' (stopped early)' : ''}`);
}

// ---------- git ----------

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' }, ...opts });
}

function syncGit(repo, branch, store) {
  const dir = join(CACHE, 'git', repo);
  if (!existsSync(join(dir, 'HEAD')) && !existsSync(join(dir, '.git'))) {
    log(`  ${repo}: cloning history (no file contents)`);
    git(['clone', '--quiet', '--bare', '--filter=blob:none', '--single-branch', '--branch', branch, `https://github.com/${ownerOf(repo)}/${repo}.git`, dir]);
  } else {
    git(['-C', dir, 'fetch', '--quiet', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`]);
  }
  // Only commits we haven't read yet need their file lists.
  const known = new Set(Object.keys(store.files));
  const out = git(['-C', dir, 'log', branch, '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%P', '--name-only', '--no-renames']);
  let added = 0;
  for (const rec of out.split('\x1e')) {
    const lines = rec.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const [sha, name, email, date, parents] = lines[0].split('\x1f');
    if (!store.commits[sha]) store.commits[sha] = {};
    const c = store.commits[sha];
    c.an = c.an || name; c.ae = c.ae || email || ''; c.d = c.d || date;
    c.p = c.p !== undefined ? c.p : (parents ? parents.split(' ').length : 0);
    if (!known.has(sha)) {
      const files = lines.slice(1);
      store.files[sha] = [files.length, ...areasFor(repo, files)];
      added++;
    }
  }
  log(`  ${repo}: ${added} new commits read from git`);
}

// ---------- the numbers ----------

export function compute(repos, stores, aliases = {}) {
  const people = new Map();
  const maintainers = new Set(MAINTAINERS.map((m) => m.toLowerCase()));
  const person = (key, display, identity) => {
    if (!people.has(key)) {
      people.set(key, {
        key, name: display, identity, prs: 0, prsOpened: 0, prsBy: {}, commits: 0, kernel: 0, files: 0, closes: 0,
        add: 0, del: 0, landed: 0, reviews: 0, reviewedPrs: new Set(), approvals: 0, comments: 0, commentedIssues: new Set(),
        reviewComments: 0, issuesOpened: 0, issuesCompleted: 0, days: new Set(), mergedDays: {}, mergedWeeks: {},
        areas: {}, products: new Set(), titles: 0,
      });
    }
    const p = people.get(key);
    if (identity === 'GitHub account' && p.identity !== 'GitHub account') { p.identity = identity; p.name = display; }
    return p;
  };
  // Logins straight from GitHub's API carry the account's real capitalization; prefer them.
  const byLogin = (login, fromApi = true) => {
    const p = person(login.toLowerCase(), login, 'GitHub account');
    if (fromApi && !p.apiName) { p.name = login; p.apiName = true; }
    return p;
  };
  const mergedByDay = {}; // day -> key -> merged PRs, for daily titles
  // Issue, triage and review counts per repo, so the page can count only the repos a viewer picks.
  const perRepo = (p, repo) => ((p.byRepo = p.byRepo || {})[repo] = p.byRepo[repo] || { io: 0, ic: new Set(), rv: new Set() });

  for (const repo of repos) {
    const s = stores[repo];
    const product = PRODUCTS[repo] || 'Other';
    const prNumbers = new Set(Object.keys(s.prs).map(Number));

    for (const [num, pr] of Object.entries(s.prs)) {
      if (!pr.a || isBotLogin(pr.a, pr.at)) continue;
      const p = byLogin(pr.a);
      if (!pr.d) { p.prsOpened++; p.days.add(etDay(pr.c)); }
      if (pr.m) {
        p.prs++; p.prsBy[product] = (p.prsBy[product] || 0) + 1; p.products.add(product);
        p.add += pr.add || 0; p.del += pr.del || 0; p.closes += pr.ci ? 1 : 0;
        const day = etDay(pr.m);
        p.days.add(day);
        p.mergedDays[day] = (p.mergedDays[day] || 0) + 1;
        const wk = isoWeek(day);
        p.mergedWeeks[wk] = (p.mergedWeeks[wk] || 0) + 1;
        (mergedByDay[day] = mergedByDay[day] || {})[p.key] = (mergedByDay[day][p.key] || 0) + 1;
        if (pr.mb && pr.mb.toLowerCase() !== pr.a.toLowerCase() && !isBotLogin(pr.mb, pr.mbt)) byLogin(pr.mb).landed++;
      }
      for (const [login, type, state, at] of pr.r || []) {
        if (!login || isBotLogin(login, type) || login.toLowerCase() === pr.a.toLowerCase() || state === 'PENDING') continue;
        const r = byLogin(login);
        r.reviews++; r.reviewedPrs.add(`${repo}#${num}`); perRepo(r, repo).rv.add(num);
        if (state === 'APPROVED') r.approvals++;
        if (at) r.days.add(etDay(at));
      }
    }
    for (const is of Object.values(s.issues)) {
      if (!is.a || isBotLogin(is.a, is.at)) continue;
      const p = byLogin(is.a);
      p.issuesOpened++;
      perRepo(p, repo).io++;
      if (is.sr === 'COMPLETED') p.issuesCompleted++;
      p.days.add(etDay(is.c));
    }
    for (const c of Object.values(s.comments)) {
      if (!c.u || isBotLogin(c.u, c.ut)) continue;
      const p = byLogin(c.u);
      p.comments++;
      if (!prNumbers.has(c.n)) { p.commentedIssues.add(`${repo}#${c.n}`); perRepo(p, repo).ic.add(c.n); }
      p.days.add(etDay(c.c));
    }
    for (const c of Object.values(s.reviewComments)) {
      if (!c.u || isBotLogin(c.u, c.ut)) continue;
      const p = byLogin(c.u);
      p.reviewComments++;
      p.days.add(etDay(c.c));
    }
    if (MIRRORS[repo]) continue; // commits already counted in the repo they were copied from
    for (const [sha, c] of Object.entries(s.commits)) {
      if (!c.d || c.p > 1) continue; // merge commits aren't authored work
      // A GitHub noreply address names its account, so it is as good as a linked commit.
      const email = (c.ae || '').toLowerCase();
      const noreply = (c.ae || '').match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
      const login = c.a || aliases[email] || (noreply ? noreply[1] : null);
      if (login && isBotLogin(login)) continue;
      if (!login && isAgentName(c.an)) continue;
      const p = login ? byLogin(login, Boolean(c.a)) : person(`email:${email}`, c.an || email, 'Email only');
      p.commits++; p.products.add(product); p.days.add(etDay(c.d));
      const f = s.files[sha];
      if (f) {
        p.files += f[0];
        for (const area of f.slice(1)) {
          p.areas[area] = (p.areas[area] || 0) + 1;
          if (area === KERNEL_AREA) p.kernel++;
        }
      }
    }
  }

  // Daily titles: who had the most merged PRs each Eastern day, maintainers left out, like the daily board.
  const winners = [];
  for (const [day, counts] of Object.entries(mergedByDay)) {
    const entries = Object.entries(counts).filter(([k]) => !maintainers.has(k));
    if (!entries.length) continue;
    const top = Math.max(...entries.map(([, n]) => n));
    for (const [k, n] of entries) if (n === top) { people.get(k).titles++; winners.push({ day, login: people.get(k).name, merged_prs: n }); }
  }
  winners.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.login.localeCompare(b.login)));

  // Area leaders.
  const areaTotals = {};
  for (const p of people.values()) for (const [a, n] of Object.entries(p.areas)) (areaTotals[a] = areaTotals[a] || []).push([p, n]);
  const areas = Object.entries(areaTotals).map(([area, list]) => {
    list.sort((x, y) => y[1] - x[1]);
    const total = list.reduce((s, [, n]) => s + n, 0);
    return {
      area, commits: total, people: list.length, leader: list[0][0].name, leader_commits: list[0][1],
      leader_share: Math.round((100 * list[0][1]) / total), second: list[1] ? list[1][0].name : '', second_commits: list[1] ? list[1][1] : 0,
    };
  }).sort((a, b) => b.commits - a.commits);

  const rows = [];
  const personAreas = [];
  const repoCounts = [];
  for (const p of people.values()) {
    const days = [...p.days].sort();
    if (!days.length && !p.landed) continue;
    const bestDay = Object.entries(p.mergedDays).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] || ['', 0];
    const bestWeek = Object.entries(p.mergedWeeks).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] || ['', 0];
    const areaList = Object.entries(p.areas).sort((a, b) => b[1] - a[1]);
    const code = areaList.filter(([a]) => !NON_CODE_AREAS.has(a));
    const main = code[0] || areaList[0] || ['', 0];
    const areaSum = areaList.reduce((s, [, n]) => s + n, 0);
    const products = [...p.products].filter((x) => x !== 'Other').sort();
    rows.push({
      name: p.name, login: p.identity === 'GitHub account' ? p.name : '', identity: p.identity,
      maintainer: maintainers.has(p.key) ? 'yes' : 'no',
      prs_merged: p.prs, prs_opened: p.prsOpened, commits: p.commits,
      solidcraft_prs: p.prsBy.SolidCraft || 0, solidcore_prs: p.prsBy.SolidCore || 0, fieldcraft_prs: p.prsBy.FieldCraft || 0,
      pcbcraft_prs: p.prsBy.PCBCraft || 0, other_prs: p.prsBy.Other || 0,
      kernel_commits: p.kernel, products: products.length, product_list: [...p.products].sort().join(' / '),
      issues_fixed: p.closes, prs_naming_issue: p.closes, lines_added: p.add, lines_deleted: p.del,
      landed_for_others: p.landed, reviews: p.reviews, prs_reviewed: p.reviewedPrs.size, approvals: p.approvals,
      comments: p.comments, issues_commented: p.commentedIssues.size, review_comments: p.reviewComments,
      issues_opened: p.issuesOpened, issues_completed: p.issuesCompleted,
      active_days: days.length, longest_streak: longestStreak(days),
      best_day: bestDay[1], best_day_date: bestDay[0], best_week: bestWeek[1], best_week_id: bestWeek[0],
      daily_titles: p.titles, first_day: days[0] || '', last_day: days[days.length - 1] || '',
      main_area: main[0], main_area_share: areaSum ? Math.round((100 * main[1]) / areaSum) : 0, files_touched: p.files,
    });
    for (const [area, n] of areaList) personAreas.push({ name: p.name, area, commits: n });
    if (p.identity === 'GitHub account') {
      for (const [repo, c] of Object.entries(p.byRepo || {})) {
        if (c.io || c.ic.size || c.rv.size) repoCounts.push({ login: p.name, repo, issues_opened: c.io, issues_commented: c.ic.size, prs_reviewed: c.rv.size });
      }
    }
  }
  rows.sort((a, b) => b.prs_merged - a.prs_merged || b.commits - a.commits || a.name.localeCompare(b.name));
  return { rows, areas, personAreas, winners, repoCounts };
}

// ---------- output ----------

function toCsv(rows, cols) {
  const cell = (v) => String(v === null || v === undefined ? '' : v).replace(/[,\r\n"]/g, ' ');
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

const DEFINITIONS = {
  prs_merged: 'Merged PRs they authored, per GitHub. Exact.',
  landed_for_others: "Other people's PRs they merged, per GitHub's merged-by, including the merge button. Exact.",
  reviews: "Reviews they submitted on other people's PRs (pending drafts left out). Exact.",
  prs_reviewed: "Distinct other people's PRs they reviewed. Exact.",
  comments: 'Comments they posted on issues and PRs. Exact.',
  issues_commented: 'Distinct issues (not PRs) they commented on. Exact.',
  review_comments: 'Inline code comments they left in PR reviews. Exact.',
  issues_opened: 'Issues they opened. Exact.',
  issues_completed: 'Their issues that were closed as completed. Exact.',
  issues_fixed: 'Their merged PRs that GitHub links as closing at least one issue. Exact for links; a fix without a "fixes #n" link is missed.',
  commits: 'Non-merge commits they authored on each default branch, mirrors counted once. Exact; "Email only" means GitHub could not tie the email to an account.',
  kernel_commits: 'Commits that changed the SolidCore geometry kernel folders in SolidCraft. Exact.',
  active_days: 'US Eastern days with any of: a commit, an opened or merged PR, a review, a comment, an opened issue. Exact.',
  longest_streak: 'Most consecutive active days. Exact.',
  best_day: 'Most merged PRs in one US Eastern day. Exact.',
  daily_titles: 'Days they had the most merged PRs, maintainers left out, ties shared. Matches the daily board rules.',
  main_area: 'Code area with the most of their commits by files changed, docs and tests left out. Exact for folders; the folder grouping is a choice.',
};

// ---------- main ----------

async function main() {
  await mkdir(join(CACHE, 'api'), { recursive: true });
  await mkdir(OUT, { recursive: true });
  const aliases = await readJson('aliases.json', {}); // optional: {"email@example.com": "github-login"}
  for (const k of Object.keys(aliases)) aliases[k.toLowerCase()] = aliases[k];

  let repoList = await readJson(join(CACHE, 'repos.json'), null);
  if (!ARGS.offline && !ARGS['no-api']) {
    const { body } = await rest(`/orgs/${ORG}/repos?type=public&per_page=100`);
    repoList = body.filter((r) => !r.fork && !EXCLUDE.has(r.name) && r.size > 0 && r.default_branch)
      .map((r) => ({ name: r.name, branch: r.default_branch }));
    await writeJson(join(CACHE, 'repos.json'), repoList);
  }
  if (!repoList) throw new Error('No repo list in the cache; run once without --offline.');
  for (const spec of String(ARGS.extra || '').split(',').filter(Boolean)) {
    const [full, branch = 'main'] = spec.split(':');
    const [owner, name] = full.split('/');
    if (!owner || !name) throw new Error(`--extra wants owner/name:branch, got ${spec}`);
    OWNERS[name] = owner;
    repoList = repoList.filter((r) => r.name !== name).concat([{ name, branch }]);
  }
  if (ARGS.repos) { const only = new Set(String(ARGS.repos).split(',')); repoList = repoList.filter((r) => only.has(r.name)); }
  if (!TOKEN && !ARGS.offline) log('No GITHUB_TOKEN: skipping GraphQL (PRs, reviews, issues, commit accounts). Comments still load, slowly.');

  const stores = {};
  for (const { name, branch } of repoList) {
    const file = join(CACHE, 'api', `${name}.json`);
    const s = await readJson(file, null) || {};
    for (const k of ['prs', 'issues', 'comments', 'reviewComments', 'commits', 'files', 'sync']) s[k] = s[k] || {};
    stores[name] = s;
    log(`${name}`);
    if (!ARGS.offline) {
      const steps = [];
      if (!ARGS['no-git'] && !MIRRORS[name]) steps.push(() => syncGit(name, branch, s));
      if (TOKEN && !ARGS['no-api']) {
        steps.push(() => syncPullRequests(name, s), () => syncIssues(name, s));
        if (!MIRRORS[name]) steps.push(() => syncHistory(name, s));
      }
      if (!ARGS['no-api']) steps.push(() => syncComments(name, s, 'comments'), () => syncComments(name, s, 'reviewComments'));
      for (const step of steps) { await step(); await writeJson(file, s); }
    }
  }

  const repos = repoList.map((r) => r.name);
  const { rows, areas, personAreas, winners, repoCounts } = compute(repos, stores, aliases);
  const peopleCols = Object.keys(rows[0] || { name: '' });
  await writeFile(join(OUT, 'people.csv'), toCsv(rows, peopleCols));
  await writeFile(join(OUT, 'areas.csv'), toCsv(areas, ['area', 'commits', 'people', 'leader', 'leader_commits', 'leader_share', 'second', 'second_commits']));
  await writeFile(join(OUT, 'person_areas.csv'), toCsv(personAreas, ['name', 'area', 'commits']));
  await writeFile(join(OUT, 'daily_winners.csv'), toCsv(winners, ['day', 'login', 'merged_prs']));
  // Same shape the dashboard's GitHub counts file has always had.
  await writeFile(join(OUT, 'gh_counts.csv'), toCsv(rows.filter((r) => r.login), ['login', 'issues_opened', 'issues_commented', 'prs_reviewed']));
  // The same counts split by repo, for the page's repo filter.
  await writeFile(join(OUT, 'gh_counts_by_repo.csv'), toCsv(repoCounts, ['login', 'repo', 'issues_opened', 'issues_commented', 'prs_reviewed']));
  const totals = {
    people: rows.length, prs_merged: rows.reduce((s, r) => s + r.prs_merged, 0), commits: rows.reduce((s, r) => s + r.commits, 0),
    comments: rows.reduce((s, r) => s + r.comments, 0), reviews: rows.reduce((s, r) => s + r.reviews, 0),
    email_only: rows.filter((r) => r.identity === 'Email only').length,
  };
  await writeJson(join(OUT, 'leaderboard.json'), {
    generated_at: new Date().toISOString(), org: ORG, repos, maintainers: MAINTAINERS, day_boundaries: TZ,
    token_used: Boolean(TOKEN), totals, definitions: DEFINITIONS, people: rows, areas,
  });
  log(`\nDone: ${totals.people} people, ${totals.prs_merged} merged PRs, ${totals.commits} commits, ${totals.comments} comments, ${totals.reviews} reviews.`);
  if (graphqlCost) log(`GraphQL points used this run: ${graphqlCost}`);
  log(`Results in ${OUT}/`);
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
