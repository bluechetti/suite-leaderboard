// A small stand-in for the dashboard runtime the page was first written for: it loads the CSV
// files in data/, works out the derived tables (dash.calc) and fills every [data-draw] element.
(function () {
  const FILES = {
    people: 'data/people.csv', areas: 'data/areas.csv', person_areas: 'data/person_areas.csv',
    gh_counts: 'data/gh_counts.csv', updated: 'data/meta.csv',
  };
  const results = {};
  const calcs = [];
  const draws = {};
  let ready = false;
  const nodesFor = (name) => document.querySelectorAll('[data-draw="' + name + '"]');
  const run = (name) => {
    const fn = draws[name];
    if (!fn) return;
    nodesFor(name).forEach((node) => {
      try { fn(node); } catch (e) { console.error('drawing ' + name + ' failed', e); }
    });
  };
  window.dash = {
    calc(id, spec) { calcs.push([id, spec]); },
    draw(name, fn) { if (fn) draws[name] = fn; run(name); },
    data(id) {
      if (results[id]) return results[id];
      return { status: ready ? 'missing' : 'loading', data: [] };
    },
  };
  // Fill the drawings once the page's own scripts have registered them.
  window.addEventListener('DOMContentLoaded', async () => {
    const bust = '?v=' + Math.floor(Date.now() / 300000); // a fresh copy at least every 5 minutes
    await Promise.all(Object.entries(FILES).map(async ([id, path]) => {
      try {
        const res = await fetch(path + bust, { cache: 'no-cache' });
        if (!res.ok) throw new Error(path + ': ' + res.status);
        const rows = d3.csvParse(await res.text(), (r) => {
          for (const k of Object.keys(r)) if (r[k] === '') r[k] = null;
          return r;
        });
        results[id] = { status: 'ok', data: rows };
      } catch (e) {
        console.error(e);
        results[id] = { status: 'error', data: [], message: String(e.message || e) };
      }
    }));
    for (const [id, spec] of calcs) {
      const inputs = spec.inputs.map((i) => results[i]);
      if (inputs.some((r) => !r || r.status !== 'ok')) { results[id] = { status: 'error', data: null }; continue; }
      try { results[id] = { status: 'ok', data: spec.fn(...inputs.map((r) => r.data)) }; }
      catch (e) { console.error('calc ' + id + ' failed', e); results[id] = { status: 'error', data: null }; }
    }
    ready = true;
    Object.keys(draws).forEach(run);
  });
})();
