// --extra adds a repo from outside the organization (CamCraft lives at NeoTech/Camcraft).
// node --test test/extra.test.mjs
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
const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

test('--extra reads an outside repo under its own owner', async () => {
  const owners = new Set();
  const paths = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    paths.push(url.pathname);
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/orgs/acme/repos') return send([{ name: 'app', fork: false, size: 1, default_branch: 'main' }]);
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(body);
      owners.add(`${variables.owner}/${variables.name}`);
      const rateLimit = { cost: 1, remaining: 4999, resetAt: new Date().toISOString() };
      if (query.includes('pullRequests(')) return send({ data: { repository: { pullRequests: empty }, rateLimit } });
      if (query.includes('issues(')) {
        const nodes = variables.name === 'Tool'
          ? [{ number: 7, state: 'OPEN', stateReason: null, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', closedAt: null, author: { login: 'zed', __typename: 'User' } }]
          : [];
        return send({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }, rateLimit } });
      }
      if (query.includes('history(')) return send({ data: { repository: { defaultBranchRef: { target: { history: empty } } }, rateLimit } });
    }
    if (url.pathname.endsWith('/issues/comments') || url.pathname.endsWith('/pulls/comments')) return send([]);
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'lb-'));
  const env = { ...process.env, GITHUB_TOKEN: 'test', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` };
  try {
    await run('node', [SCRIPT, '--org', 'acme', '--no-git', '--extra', 'other/Tool:main', '--cache', join(dir, 'c'), '--out', join(dir, 'o')], { env, cwd: dir });
    assert.ok(owners.has('other/Tool'), 'GraphQL asked for other/Tool');
    assert.ok(owners.has('acme/app'));
    assert.ok(paths.includes('/repos/other/Tool/issues/comments'), 'comments read from the outside repo');
    const gh = await readFile(join(dir, 'o', 'gh_counts.csv'), 'utf8');
    assert.match(gh, /^zed,1,/m);
  } finally {
    server.close();
  }
});
