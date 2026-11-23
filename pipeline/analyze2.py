"""All-time contributor stats across Tangency Labs repos.

Inputs (all in this folder):
  logs_<repo>.txt   git log: sha, author name, author email, committer name, committer email, author date, subject
  files_<repo>.txt  git log --name-only: files each commit touched
  aliases_learned.json, aliases_hashed.json, aliases.json  optional email -> GitHub login maps (hashed or plain)
  gh_counts.json    optional: {issues: {login: n}, comments: {login: n}, reviews: {login: n}}
Outputs: people.csv, areas.csv, person_areas.csv
"""
import collections
import csv
import datetime
import json
import os
import re

PRODUCT = {
    'solidcraft': 'SolidCraft', 'fieldcraft': 'FieldCraft',
    'pcbcraft': 'PCBCraft', 'pcbcraft-gpl': 'PCBCraft', 'pcbcraft-app': 'PCBCraft',
    'camcraft': 'CamCraft',  # NeoTech/Camcraft, the CAM app in the SolidCraft suite
}
OTHER_REPOS = ['website', 'models', 'solidcore-goldens', 'design', 'leaderboard', 'solidcraft-library',
               'homebrew-tap', 'solidcraft-app', 'solidcraft-app-rc', 'solidcore-viewer']
REPOS = ['solidcraft', 'fieldcraft', 'pcbcraft', 'pcbcraft-gpl', 'pcbcraft-app', 'camcraft'] + OTHER_REPOS
REPO_OWNERS = {'tangency-labs', 'neotech'}  # branches inside these accounts' own repos name no person
# The solidcore repo is a mirror of SolidCraft's kernel folder (3,742 of its 3,743 commits are the
# same commits), so it is not read again; kernel work is counted from SolidCraft's own paths.

MAINTAINERS = {'bherbruck', 'jyviko', 'neotech'}  # Tangency Labs maintainers and CamCraft's owner, as on the daily board
CUTOFF = datetime.datetime.now(datetime.timezone.utc)
RECENT_DAYS = 7

AGENT_NAMES = {'codex', 'claude', 'claude code', 'copilot', 'devin-ai-integration', 'camcraft gate', 'wb pcb worker', 'adventure agent', "fixer (f')", 'gpt-6.1 terra'}

MANUAL = {}  # moved into aliases_hashed.json

# Commit emails GitHub couldn't tie to an account, matched to their GitHub login. Stored hashed
# (sha256 of the lowercased email) so the published copy contains no email addresses.
import hashlib
aliases = {}
for _f in ('aliases_learned.json', 'aliases_hashed.json', 'aliases.json'):  # later files win
    if os.path.exists(_f):
        for _k, _v in json.load(open(_f)).items():
            _k = _k.strip().lower()
            aliases[_k if re.fullmatch(r'[0-9a-f]{64}', _k) else hashlib.sha256(_k.encode()).hexdigest()] = _v
gh = {'issues': {}, 'comments': {}, 'reviews': {}}
if os.path.exists('gh_counts.json'):
    gh.update(json.load(open('gh_counts.json')))
gh_lower = {k: {l.lower(): v for l, v in d.items()} for k, d in gh.items()}


def ident(name, email):
    """Return (key, display, how) where how is 'account' when tied to a GitHub account."""
    e = email.lower()
    m = re.match(r'^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$', email)
    if m:
        return m.group(1).lower(), m.group(1), 'account'
    h = hashlib.sha256(e.encode()).hexdigest()
    if h in aliases:
        return aliases[h].lower(), aliases[h], 'account'
    if e in MANUAL:
        return MANUAL[e].lower(), MANUAL[e], 'account'
    return 'email:' + e, name, 'email'


def is_bot(name, email):
    n = name.lower()
    return '[bot]' in n or 'bot@' in email.lower() or n in AGENT_NAMES


def sol_area(path):
    p = path.split('/')
    top = p[0]
    sub = p[1] if len(p) > 1 else ''
    if top == 'solidcore' or (top == 'crates' and (sub.startswith('solidcore') or sub in ('kernel', 'smlib', 'geom', 'goldens', 'difftest'))) or path.startswith('tests/kernel-cases'):
        return 'Geometry kernel (SolidCore)'
    if top == 'crates' and sub == 'sketch':
        return 'Sketch and constraints'
    if top == 'crates' and sub in ('engine', 'doc', 'dynamics', 'derive', 'display-units', 'space'):
        return 'Modeling engine and document'
    if top == 'crates' and (sub.startswith('ui') or sub.startswith('viewport') or sub in ('render', 'gpu', 'look', 'theme', 'panel-layout', 'color', 'views', 'control-egui', 'control', 'space-mouse', 'threedx-client')) or top == 'assets':
        return 'User interface and viewport'
    if top == 'crates' and (sub in ('io', 'format') or sub.startswith('step')):
        return 'File import and export'
    if top == 'crates' and (sub.startswith('mcp') or sub.startswith('craft-plugin')) or (top == 'apps' and 'cli' in sub) or top == 'skills' or path in ('docs/mcp.md', 'docs/control-protocol.md', 'docs/plugins.md', 'docs/agent-chat.md'):
        return 'MCP / CLI / plugins'
    if top == 'apps' or top == 'site':
        return 'Desktop and web apps'
    if top in ('docs', 'plan', 'reports', 'attribution') or (len(p) == 1 and path.endswith(('.md', '.txt'))):
        return 'Docs and planning'
    return 'Tests and tooling'


def areas_for(repo, files):
    prod = PRODUCT.get(repo)
    if prod == 'SolidCraft':
        return {sol_area(f) for f in files} or {'Tests and tooling'}
    if prod:
        return {prod}
    return {'Website and other repos'}


def load(repo):
    logs = {}
    for rec in open(f'logs_{repo}.txt', encoding='utf-8', errors='replace').read().split('\x1e'):
        p = rec.strip('\n').split('\x1f')
        if len(p) >= 7:
            logs[p[0]] = dict(sha=p[0], an=p[1], ae=p[2], cn=p[3], ce=p[4], date=p[5], s=p[6], landed=p[7] if len(p) > 7 and p[7] else p[5])
    files = {}
    for rec in open(f'files_{repo}.txt', encoding='utf-8', errors='replace').read().split('\x1e'):
        lines = [l for l in rec.strip().split('\n') if l]
        if lines:
            files[lines[0]] = lines[1:]
    parents = {}
    if os.path.exists(f'parents_{repo}.txt'):
        for line in open(f'parents_{repo}.txt'):
            p = line.split()
            if p:
                parents[p[0]] = p[1:]
    return logs, files, parents


def new_person():
    return dict(display=collections.Counter(), how=set(), commits=0, prs=0, prs_by=collections.Counter(),
                commits_by=collections.Counter(), naming_issue=0, landed=0, days=collections.Counter(),
                weeks=collections.Counter(), areas=collections.Counter(), files=0, recent=0)


people = collections.defaultdict(new_person)

# Names used on commits that GitHub ties to an account. An unlinked email whose author name was
# used by exactly one account is counted for that account (for example a laptop's local address).
name_accounts = collections.defaultdict(set)
for _repo in REPOS:
    if not os.path.exists(f'logs_{_repo}.txt'):
        continue
    for _rec in open(f'logs_{_repo}.txt', encoding='utf-8', errors='replace').read().split('\x1e'):
        _p = _rec.strip('\n').split('\x1f')
        if len(_p) >= 7 and len(_p[1].split()) >= 2:
            _k, _d, _h = ident(_p[1], _p[2])
            if _h == 'account':
                name_accounts[_p[1].strip().lower()].add((_k, _d))


def ident_or_name(name, email):
    k, d, h = ident(name, email)
    if h == 'email':
        acc = name_accounts.get(name.strip().lower())
        if acc and len(acc) == 1:
            k, d = next(iter(acc))
            return k, d, 'account'
    return k, d, h
area_people = collections.defaultdict(collections.Counter)
login_display = {}

for repo in REPOS:
    if not os.path.exists(f'logs_{repo}.txt'):
        continue
    logs, files, parents = load(repo)
    prod = PRODUCT.get(repo, 'Other')
    for c in logs.values():
        merge_m = re.match(r'^Merge pull request #(\d+) from ([^/\s]+)/', c['s'])
        if merge_m:
            # Merge-commit style (PCBCraft): the PR belongs to the branch owner, the merge to whoever pressed it.
            login = merge_m.group(2)
            k = login.lower()
            disp_name, how = login, 'account'
            if login.lower() in REPO_OWNERS:
                # Branch inside the org repo: credit the author of the branch's last commit.
                tip = (parents.get(c['sha']) or [None, None])
                tip = logs.get(tip[1]) if len(tip) > 1 else None
                if not tip or is_bot(tip['an'], tip['ae']):
                    continue
                k, disp_name, how = ident_or_name(tip['an'], tip['ae'])
            st = people[k]
            st['display'][disp_name] += 1
            st['how'].add(how)
            st['org_branch_prs'] = st.get('org_branch_prs', 0) + (1 if login.lower() in REPO_OWNERS else 0)
            st['prs'] += 1
            st['prs_by'][prod] += 1
            if (CUTOFF - datetime.datetime.fromisoformat(c['landed'])).days < RECENT_DAYS:
                st['recent'] += 1
            if not is_bot(c['an'], c['ae']):
                mk, md, mh = ident_or_name(c['an'], c['ae'])
                if mk != k:
                    people[mk]['landed'] += 1
                    people[mk]['display'][md] += 1
                    people[mk]['how'].add(mh)
            continue
        if c['s'].startswith('Merge ') and len(files.get(c['sha'], [])) == 0:
            continue
        if is_bot(c['an'], c['ae']):
            continue
        k, disp, how = ident_or_name(c['an'], c['ae'])
        st = people[k]
        st['display'][disp] += 1
        st['how'].add(how)
        if how == 'account':
            login_display.setdefault(k, disp if not re.search(r'\s', disp) else login_display.get(k, ''))
        st['commits'] += 1
        st['commits_by'][prod] += 1
        fl = files.get(c['sha'], [])
        st['files'] += len(fl)
        squash = re.search(r'\(#(\d+)\)\s*$', c['s'])
        if squash:
            st['prs'] += 1
            st['prs_by'][prod] += 1
            if (CUTOFF - datetime.datetime.fromisoformat(c['landed'])).days < RECENT_DAYS:
                st['recent'] += 1
            rest = c['s'][:squash.start()]
            if re.search(r'#\d+', rest):
                st['naming_issue'] += 1
        d = datetime.datetime.fromisoformat(c['date']).astimezone(datetime.timezone.utc).date()
        st['days'][d] += 1
        iso = d.isocalendar()
        st['weeks'][f'{iso[0]}-W{iso[1]:02d}'] += 1
        for a in areas_for(repo, fl):
            st['areas'][a] += 1
            area_people[a][k] += 1
        # Pushed or rebased someone else's commit onto main (not GitHub's merge button).
        if c['cn'] != 'GitHub' and not is_bot(c['cn'], c['ce']) and 'noreply@github.com' != c['ce'].lower():
            ck, cd, ch = ident_or_name(c['cn'], c['ce'])
            if ck != k:
                people[ck]['landed'] += 1
                people[ck]['display'][cd] += 1
                people[ck]['how'].add(ch)


def streak(days):
    best = cur = 0
    prev = None
    for d in sorted(days):
        cur = cur + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, cur)
        prev = d
    return best


def display_name(st):
    names = [n for n, _ in st['display'].most_common()]
    return names[0] if names else '?'


CODE_AREAS_EXCLUDE = {'Docs and planning', 'Tests and tooling'}
rows = []
for k, st in people.items():
    if st['commits'] == 0 and st['prs'] == 0 and st['landed'] == 0:
        continue
    login = (login_display.get(k) or k) if not k.startswith('email:') else ''
    best_day = max(st['days'].items(), key=lambda x: (x[1], x[0])) if st['days'] else (None, 0)
    best_week = max(st['weeks'].items(), key=lambda x: x[1]) if st['weeks'] else ('', 0)
    code_areas = [(a, n) for a, n in st['areas'].most_common() if a not in CODE_AREAS_EXCLUDE]
    main_area, main_n = code_areas[0] if code_areas else (st['areas'].most_common(1)[0] if st['areas'] else ('', 0))
    total_area = sum(st['areas'].values())
    products = sorted(set(list(st['prs_by']) + list(st['commits_by'])))
    rows.append(dict(
        name=display_name(st),
        login=login,
        identity='GitHub account' if login else 'Email only',
        maintainer='yes' if k in MAINTAINERS else 'no',
        prs_merged=st['prs'],
        prs_7d=st['recent'],
        commits=st['commits'],
        solidcraft_prs=st['prs_by'].get('SolidCraft', 0),
        fieldcraft_prs=st['prs_by'].get('FieldCraft', 0),
        pcbcraft_prs=st['prs_by'].get('PCBCraft', 0),
        camcraft_prs=st['prs_by'].get('CamCraft', 0),
        kernel_commits=st['areas'].get('Geometry kernel (SolidCore)', 0),
        products=len([p for p in products if p != 'Other']),
        product_list=' / '.join(p for p in products),
        prs_naming_issue=st['naming_issue'],
        landed_for_others=st['landed'],
        active_days=len(st['days']),
        longest_streak=streak(st['days']) if st['days'] else 0,
        best_day=best_day[1], best_day_date=str(best_day[0]) if best_day[0] else '',
        best_week=best_week[1], best_week_id=best_week[0],
        first_day=str(min(st['days'])) if st['days'] else '',
        last_day=str(max(st['days'])) if st['days'] else '',
        main_area=main_area,
        main_area_share=round(100 * main_n / total_area) if total_area else 0,
        files_touched=st['files'],
    ))
rows.sort(key=lambda r: (-r['prs_merged'], -r['commits'], r['name'].lower()))
prev = {}
prev_from = open('people_prev.at').read().strip() if os.path.exists('people_prev.at') else ''
if os.path.exists('people_prev.csv'):
    for r in csv.DictReader(open('people_prev.csv')):
        if r.get('rank'):
            prev[(r.get('login') or r['name']).lower()] = int(r['rank'])
rank, last = 0, None
for i, r in enumerate([r for r in rows if r['maintainer'] == 'no']):
    if r['prs_merged'] != last:
        rank = i + 1
        last = r['prs_merged']
    r['rank'] = rank
for r in rows:
    if r['maintainer'] == 'yes':
        r['rank'] = ''
    p = prev.get((r['login'] or r['name']).lower())
    r['prev_rank'] = p if p else ''
    r['rank_change'] = (p - r['rank']) if (p and r['rank'] != '') else ''

cols = list(rows[0].keys())
with open('people.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(cols)
    for r in rows:
        w.writerow([str(r[c]).replace(',', ' ').replace('"', '') for c in cols])

names = {k: display_name(st) for k, st in people.items()}
with open('areas.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['area', 'commits', 'people', 'leader', 'leader_commits', 'leader_share', 'second', 'second_commits'])
    for a, c in sorted(area_people.items(), key=lambda x: -sum(x[1].values())):
        tot = sum(c.values())
        top = c.most_common(2)
        (k1, n1) = top[0]
        k2, n2 = top[1] if len(top) > 1 else ('', 0)
        w.writerow([a, tot, len(c), names[k1], n1, round(100 * n1 / tot), names.get(k2, ''), n2])

with open('person_areas.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['name', 'area', 'commits'])
    for k, st in people.items():
        if st['commits'] == 0:
            continue
        for a, n in st['areas'].most_common():
            w.writerow([names[k].replace(',', ' '), a, n])

with open('gh_counts.csv', 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['login', 'issues_opened', 'issues_commented', 'prs_reviewed'])
    for r in rows:
        l = r['login'].lower()
        if r['login'] and (l in gh_lower['issues'] or l in gh_lower['comments'] or l in gh_lower['reviews']):
            w.writerow([r['login'], gh_lower['issues'].get(l, 0), gh_lower['comments'].get(l, ''), gh_lower['reviews'].get(l, '')])
json.dump({'generated_at': CUTOFF.strftime('%Y-%m-%dT%H:%M:%SZ'), 'previous_from': prev_from if prev else '', 'people': len(rows),
           'prs_merged': sum(r['prs_merged'] for r in rows), 'commits': sum(r['commits'] for r in rows),
           'repos': ', '.join(r for r in REPOS if os.path.exists(f'logs_{r}.txt'))}, open('meta.json', 'w'))
print('people', len(rows), 'prs', sum(r['prs_merged'] for r in rows), 'commits', sum(r['commits'] for r in rows))
print('email-only', sum(1 for r in rows if r['identity'] == 'Email only'))
