import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(process.argv[2], 'utf8');
const listeners = {};
const store = new Map();
const cacheOf = name => store.get(name) ?? (store.set(name, new Map()), store.get(name));
const origin = 'http://localhost';
const net = new Map([['./earn-it.html', 'APP-HTML'], ['./manifest.webmanifest', '{}'], ['./icon.svg', '<svg/>']]);
let skipped = false, claimed = false;
const ctx = {
  self: {
    location: { origin },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { skipped = true; return Promise.resolve(); },
    clients: { claim: () => { claimed = true; return Promise.resolve(); } },
  },
  URL,
  caches: {
    open: async name => {
      const c = cacheOf(name);
      return { addAll: async urls => urls.forEach(u => c.set(new URL(u, origin + '/').href, net.get(u))), put: async (req, res) => c.set(req.url, res.body ?? res) };
    },
    keys: async () => [...store.keys()],
    delete: async k => store.delete(k),
    match: async req => { const url = typeof req === 'string' ? new URL(req, origin + '/').href : req.url; for (const c of store.values()) if (c.has(url)) return { body: c.get(url), ok: true }; return undefined; },
  },
  Promise,
  fetch: async req => { if (netDown) throw new Error('offline'); return { ok: true, body: 'LIVE:' + req.url, clone() { return this; } }; },
};
let netDown = false;
vm.createContext(ctx);
vm.runInContext(src, ctx);

const results = [];
const check = (n, c) => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const waitFor = p => p;

await listeners.install({ waitUntil: p => (ctx._installP = p) });
await ctx._installP;
check('install pre-caches the app shell', [...store.get('earnit-v4').keys()].some(k => k.endsWith('/earn-it.html')));
check('install skips waiting so the new worker activates immediately', skipped);

await listeners.activate({ waitUntil: p => (ctx._actP = p) });
await ctx._actP;
check('activate claims open pages', claimed);

let resp;
const req = url => ({ method: 'GET', url: origin + '/' + url.replace('./', '') });
const fetchEvt = (url, method = 'GET') => ({ request: { method, url, clone: undefined }, respondWith: p => (resp = p) });
listeners.fetch({ request: { method: 'GET', url: origin + '/earn-it.html' }, respondWith: p => (resp = p) });
let out = await resp;
check('a cached page is served from the shell cache', out.body === 'APP-HTML');

netDown = true;
listeners.fetch({ request: { method: 'GET', url: origin + '/unknown-page' }, respondWith: p => (resp = p) });
out = await resp;
check('offline navigation falls back to the cached app', out.body === 'APP-HTML');

resp = undefined;
listeners.fetch({ request: { method: 'POST', url: origin + '/x' }, respondWith: p => (resp = p) });
check('non-GET requests are left to the network', resp === undefined);

resp = undefined;
listeners.fetch({ request: { method: 'GET', url: 'https://cdn.example.com/lib.js' }, respondWith: p => (resp = p) });
check('cross-origin requests are not intercepted', resp === undefined);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
