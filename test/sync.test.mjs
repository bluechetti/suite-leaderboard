// Runs the whole script against a fake GitHub API: paging, incremental runs and rate-limit retries.
// node --test test/sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = new URL('../pipeline/alltime.mjs', import.meta.url).pathname;

function fakeGitHub(state) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (state.rateLimitOnce && !state.limited) { state.limited = true; return send(403, { message: 'rate limit' }, { 'retry-after': '1' }); }
    if (url.pathname === '/orgs/acme/repos') return send(200, [{ name: 'app', fork: false, size: 1, default_branch: 'main' }, { name: 'forked', fork: true, size: 1, default_branch: 'main' }]);
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(body);
      const rateLimit = { cost: 1, remaining: 4999, resetAt: new Date().toISOString() };
      const pageOf = (items, size) => {
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const nodes = items.slice(start, start + size);
        return { pageInfo: { hasNextPage: start + size < items.length, endCursor: String(start + size) }, nodes };
      };
      if (query.includes('pullRequests(')) return send(200, { data: { repository: { pullRequests: pageOf(state.prs, variables.size) }, rateLimit } });
      if (query.includes('issues(')) return send(200, { data: { repository: { issues: pageOf(state.issues, variables.size) }, rateLimit } });
      if (query.includes('history(')) return send(200, { data: { repository: { defaultBranchRef: { target: { history: pageOf(state.commits, variables.size) } } }, rateLimit } });
      if (query.includes('pullRequest(number')) return send(200, { data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: false }, nodes: state.extraReviews } } }, rateLimit } });
      return send(400, { errors: [{ message: 'unknown query' }] });
    }
    if (url.pathname === '/repos/acme/app/issues/comments' || url.pathname === '/repos/acme/app/pulls/comments') {
      const list = url.pathname.includes('issues') ? state.comments : state.reviewComments;
      const since = url.searchParams.get('since');
      const items = since ? list.filter((c) => c.updated_at >= since) : list;
      const page = Number(url.searchParams.get('page') || 1);
      const slice = items.slice((page - 1) * 100, page * 100);
      const more = page * 100 < items.length;
      const next = new URL(req.url, `http://${req.headers.host}`); next.searchParams.set('page', String(page + 1));
      return send(200, slice, more ? { link: `<${next}>; rel="next"` } : {});
    }
    send(404, { message: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

const pr = (n, updatedAt, author, extra = {}) => ({
  number: n, title: `PR ${n}`, state: 'MERGED', isDraft: false, createdAt: updatedAt, updatedAt, mergedAt: updatedAt,
  additions: 1, deletions: 1, changedFiles: 1, author: { login: author, __typename: 'User' }, mergedBy: { login: 'boss', __typename: 'User' },
  closingIssuesReferences: { totalCount: 0 }, reviews: { totalCount: 0, nodes: [] }, ...extra,
});
const comment = (id, user, at, n) => ({ id, user: { login: user, type: 'User' }, created_at: at, updated_at: at, issue_url: `https://x/repos/acme/app/issues/${n}`, pull_request_url: `https://x/repos/acme/app/pulls/${n}` });

test('first run pages everything; second run fetches only what changed', async () => {
  const state = {
    rateLimitOnce: true,
    // 120 PRs, newest first (the API orders by UPDATED_AT DESC), so it takes 3 pages of 50.
    prs: Array.from({ length: 120 }, (_, i) => pr(120 - i, new Date(Date.UTC(2026, 10, 1) + (120 - i) * 3600e3).toISOString(), i % 2 ? 'ann' : 'Ben')),
    issues: [{ number: 500, state: 'OPEN', stateReason: null, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', closedAt: null, author: { login: 'cat', __typename: 'User' } }],
    commits: [],
    comments: Array.from({ length: 250 }, (_, i) => comment(i + 1, 'cat', `2026-11-0${1 + (i % 5)}T00:00:00Z`, 500)),
    reviewComments: [],
    extraReviews: [],
  };
  // One PR with more reviews than fit in the first request.
  state.prs[0].reviews = { totalCount: 41, nodes: [] };
  state.extraReviews = Array.from({ length: 41 }, () => ({ author: { login: 'dee', __typename: 'User' }, state: 'APPROVED', submittedAt: '2026-11-03T00:00:00Z' }));

  const gh = await fakeGitHub(state);
  const dir = await mkdtemp(join(tmpdir(), 'lb-'));
  const env = { ...process.env, GITHUB_TOKEN: 'test', GITHUB_API_URL: gh.url };
  const args = [SCRIPT, '--org', 'acme', '--no-git', '--cache', join(dir, 'cache'), '--out', join(dir, 'out')];
  try {
    await run('node', args, { env, cwd: dir });
    const prCalls1 = gh.calls.filter((c) => c === 'POST /graphql').length;
    const people = (await readFile(join(dir, 'out', 'people.csv'), 'utf8')).trim().split('\n');
    const header = people[0].split(',');
    const row = (name) => Object.fromEntries(header.map((h, i) => [h, people.find((l) => l.startsWith(`${name},`)).split(',')[i]]));
    assert.equal(Number(row('ann').prs_merged) + Number(row('Ben').prs_merged), 120);
    assert.equal(row('cat').comments, '250'); // three REST pages followed through the Link header
    assert.equal(row('dee').reviews, '41'); // extra reviews fetched in a second query
    assert.equal(row('boss').landed_for_others, '120');
    assert.ok(gh.calls.some((c) => c.includes('page=3')));
    assert.ok(!gh.calls.some((c) => c.includes('/repos/acme/forked')), 'forks are skipped');

    // Second run: one PR changed and one new comment. Only those should come back.
    gh.calls.length = 0;
    const now = new Date(Date.now() + 1000).toISOString();
    state.prs.unshift(pr(121, now, 'ann'));
    state.comments.push(comment(999, 'cat', now, 500));
    await run('node', args, { env, cwd: dir });
    const people2 = (await readFile(join(dir, 'out', 'people.csv'), 'utf8')).trim().split('\n');
    const header2 = people2[0].split(',');
    const row2 = (name) => Object.fromEntries(header2.map((h, i) => [h, people2.find((l) => l.startsWith(`${name},`)).split(',')[i]]));
    assert.equal(Number(row2('ann').prs_merged) + Number(row2('Ben').prs_merged), 121);
    assert.equal(row2('cat').comments, '251');
    const prCalls2 = gh.calls.filter((c) => c === 'POST /graphql').length;
    assert.ok(prCalls2 < prCalls1, `second run made ${prCalls2} GraphQL calls, first made ${prCalls1}`);
    assert.ok(gh.calls.some((c) => c.includes('/issues/comments') && c.includes('since=')), 'comments use since=');
  } finally {
    gh.server.close();
  }
});
