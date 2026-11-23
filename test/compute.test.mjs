// Checks the leaderboard math on a small made-up data set: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute } from '../pipeline/alltime.mjs';

const T = (day, hour = 15) => `${day}T${String(hour).padStart(2, '0')}:00:00Z`; // 15:00 UTC = 10:00 or 11:00 Eastern
const empty = () => ({ prs: {}, issues: {}, comments: {}, reviewComments: {}, commits: {}, files: {}, sync: {} });

function fixture() {
  const sc = empty();
  sc.prs = {
    1: { t: 'Fillet fix', s: 'MERGED', d: false, c: T('2026-11-01'), m: T('2026-11-02'), a: 'Alice', at: 'User', mb: 'bherbruck', mbt: 'User', add: 10, del: 2, ci: 1,
      r: [['bherbruck', 'User', 'APPROVED', T('2026-11-02')], ['Alice', 'User', 'COMMENTED', T('2026-11-02')], ['Bob', 'User', 'PENDING', null]], rt: 3 },
    2: { t: 'Sketch tweak', s: 'MERGED', d: false, c: T('2026-11-02'), m: T('2026-11-02', 18), a: 'alice', at: 'User', mb: 'alice', mbt: 'User', add: 5, del: 5, ci: 0, r: [['Bob', 'User', 'CHANGES_REQUESTED', T('2026-11-02')]], rt: 1 },
    3: { t: 'Docs', s: 'MERGED', d: false, c: T('2026-11-02'), m: T('2026-11-02'), a: 'Bob', at: 'User', mb: 'bherbruck', mbt: 'User', add: 1, del: 0, ci: 0, r: [], rt: 0 },
    4: { t: 'Bump deps', s: 'MERGED', d: false, c: T('2026-11-02'), m: T('2026-11-02'), a: 'dependabot', at: 'Bot', mb: 'bherbruck', mbt: 'User', add: 1, del: 1, ci: 0, r: [], rt: 0 },
    5: { t: 'Open draft', s: 'OPEN', d: true, c: T('2026-11-03'), m: null, a: 'Bob', at: 'User', mb: null, r: [], rt: 0 },
    6: { t: 'Kernel', s: 'MERGED', d: false, c: T('2026-11-03'), m: T('2026-11-03'), a: 'bherbruck', at: 'User', mb: 'bherbruck', mbt: 'User', add: 100, del: 0, ci: 0, r: [], rt: 0 },
    7: { t: 'Kernel 2', s: 'MERGED', d: false, c: T('2026-11-03'), m: T('2026-11-03'), a: 'bherbruck', at: 'User', mb: 'bherbruck', mbt: 'User', add: 100, del: 0, ci: 0, r: [], rt: 0 },
    8: { t: 'Viewport', s: 'MERGED', d: false, c: T('2026-11-03'), m: T('2026-11-03'), a: 'Bob', at: 'User', mb: 'jyviko', mbt: 'User', add: 3, del: 3, ci: 1, r: [], rt: 0 },
  };
  sc.issues = {
    100: { s: 'CLOSED', sr: 'COMPLETED', c: T('2026-11-01'), a: 'Carol', at: 'User' },
    101: { s: 'CLOSED', sr: 'NOT_PLANNED', c: T('2026-11-01'), a: 'Carol', at: 'User' },
    102: { s: 'OPEN', sr: null, c: T('2026-11-04'), a: 'github-actions', at: 'Bot' },
  };
  sc.comments = {
    9001: { u: 'Carol', ut: 'User', c: T('2026-11-01'), n: 100 },
    9002: { u: 'Carol', ut: 'User', c: T('2026-11-01'), n: 100 },
    9003: { u: 'Carol', ut: 'User', c: T('2026-11-05'), n: 101 },
    9004: { u: 'Carol', ut: 'User', c: T('2026-11-05'), n: 1 }, // on a PR: counts as a comment, not an issue commented on
    9005: { u: 'coderabbitai', ut: 'Bot', c: T('2026-11-05'), n: 1 },
  };
  sc.reviewComments = { 7001: { u: 'Bob', ut: 'User', c: T('2026-11-02'), n: 1 } };
  sc.commits = {
    a1: { d: T('2026-11-01'), p: 1, an: 'Alice A', ae: 'alice@example.com', a: 'Alice' },
    a2: { d: T('2026-11-02'), p: 1, an: 'Alice A', ae: 'alice@example.com', a: null }, // same person, email not linked: alias joins it
    m1: { d: T('2026-11-02'), p: 2, an: 'Bob', ae: 'bob@example.com', a: 'Bob' }, // merge commit: not counted
    b1: { d: T('2026-11-03'), p: 1, an: 'Bob', ae: '123+Bob@users.noreply.github.com', a: null }, // noreply names the account
    c1: { d: T('2026-11-03'), p: 1, an: 'Codex', ae: 'codex@openai.com', a: null }, // agent identity: left out
    z1: { d: T('2026-11-04'), p: 1, an: 'Zed', ae: 'zed@example.com', a: null }, // nobody knows who this is
  };
  sc.files = { a1: [2, 'Geometry kernel (SolidCore)'], a2: [1, 'Sketch and constraints'], b1: [3, 'User interface and viewport', 'Docs and planning'], z1: [1, 'Tests and tooling'] };

  const core = empty(); // a mirror: its commits repeat SolidCraft's and must not count again
  core.commits = { a1: { d: T('2026-11-01'), p: 1, an: 'Alice A', ae: 'alice@example.com', a: 'Alice' } };
  core.files = { a1: [2, 'SolidCore'] };
  core.prs = { 1: { t: 'Core PR', s: 'MERGED', d: false, c: T('2026-11-04'), m: T('2026-11-04'), a: 'Alice', at: 'User', mb: 'Alice', mbt: 'User', add: 1, del: 1, ci: 0, r: [], rt: 0 } };
  return { solidcraft: sc, solidcore: core };
}

const run = () => {
  const stores = fixture();
  const out = compute(['solidcraft', 'solidcore'], stores, { 'alice@example.com': 'Alice' });
  const by = Object.fromEntries(out.rows.map((r) => [r.name.toLowerCase(), r]));
  return { ...out, by };
};

test('merged PRs: case-insensitive logins, bots out, drafts not "opened"', () => {
  const { by } = run();
  assert.equal(by.alice.prs_merged, 3); // two SolidCraft (one logged as "alice") + one SolidCore
  assert.equal(by.alice.solidcraft_prs, 2);
  assert.equal(by.alice.solidcore_prs, 1);
  assert.equal(by.bob.prs_merged, 2);
  assert.equal(by.bob.prs_opened, 2); // the draft doesn't count as opened
  assert.equal(by.dependabot, undefined);
  assert.equal(by.alice.name, 'Alice'); // capitalization from GitHub's API wins
});

test('landed for others: merged-by someone other than the author', () => {
  const { by } = run();
  assert.equal(by.bherbruck.landed_for_others, 2); // PRs 1 and 3; the bot's PR and his own don't count
  assert.equal(by.jyviko.landed_for_others, 1);
  assert.equal(by.alice.landed_for_others, 0); // merged her own
});

test('reviews: own reviews and pending drafts left out', () => {
  const { by } = run();
  assert.equal(by.bherbruck.reviews, 1);
  assert.equal(by.bherbruck.approvals, 1);
  assert.equal(by.alice.reviews, 0);
  assert.equal(by.bob.reviews, 1);
  assert.equal(by.bob.prs_reviewed, 1);
  assert.equal(by.bob.review_comments, 1);
});

test('comments and issues', () => {
  const { by } = run();
  assert.equal(by.carol.comments, 4);
  assert.equal(by.carol.issues_commented, 2); // issues 100 and 101; the PR comment isn't an issue
  assert.equal(by.carol.issues_opened, 2);
  assert.equal(by.carol.issues_completed, 1);
  assert.equal(by.coderabbitai, undefined);
});

test('commits: merges, agents and mirror copies left out; aliases and noreply join accounts', () => {
  const { by, rows } = run();
  assert.equal(by.alice.commits, 2); // a1 once (not again from the mirror) + a2 via the alias
  assert.equal(by.alice.kernel_commits, 1);
  assert.equal(by.bob.commits, 1); // b1 via noreply; the merge commit isn't counted
  assert.equal(by.bob.main_area, 'User interface and viewport'); // docs left out of "main code area"
  assert.ok(!rows.some((r) => /codex/i.test(r.name)));
  assert.equal(by.zed.identity, 'Email only');
});

test('PRs that close an issue', () => {
  const { by } = run();
  assert.equal(by.alice.issues_fixed, 1);
  assert.equal(by.bob.issues_fixed, 1);
});

test('days, streaks, best day and daily titles (maintainers left out)', () => {
  const { by, winners } = run();
  assert.equal(by.alice.best_day, 2); // PRs 1 and 2 both merged Nov 2 Eastern
  assert.equal(by.alice.best_day_date, '2026-11-02');
  assert.equal(by.carol.longest_streak, 1); // Nov 1 and Nov 5 aren't consecutive
  assert.equal(by.carol.active_days, 2);
  // Nov 2: Alice 2, Bob 1 -> Alice. Nov 3: bherbruck 2 (maintainer, skipped), Bob 1 -> Bob. Nov 4: Alice (SolidCore).
  assert.equal(by.alice.daily_titles, 2);
  assert.equal(by.bob.daily_titles, 1);
  assert.equal(by.bherbruck.daily_titles, 0);
  assert.equal(by.bherbruck.maintainer, 'yes');
  assert.deepEqual(winners.map((w) => w.day), ['2026-11-02', '2026-11-03', '2026-11-04']);
});

test('Eastern day boundaries: 02:00 UTC belongs to the day before', () => {
  const stores = fixture();
  stores.solidcraft.prs[1].m = '2026-11-03T02:00:00Z'; // Nov 2, 9 pm Eastern
  const { rows } = compute(['solidcraft', 'solidcore'], stores, { 'alice@example.com': 'Alice' });
  const alice = rows.find((r) => r.name === 'Alice');
  assert.equal(alice.best_day_date, '2026-11-02');
});
