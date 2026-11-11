import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync(process.argv[2], 'utf8');
const results = [];
const check = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + extra}`); };
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ymd(new Date());
const YESTERDAY = ymd(new Date(Date.now() - 864e5));
const TOMORROW = ymd(new Date(Date.now() + 864e5));
const tick = () => new Promise(r => setTimeout(r, 0));

function open(seed = {}, patch = () => {}) {
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', e => errors.push('jsdom: ' + e.message));
  vc.on('error', e => errors.push('console: ' + String(e)));
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
      w.__downloads = [];
      w.HTMLAnchorElement.prototype.click = function () { w.__downloads.push(this.download); };
      for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);
      patch(w);
    } });
  dom.errors = errors; return dom;
}
const q = (w, s) => w.document.querySelector(s);
const qa = (w, s) => [...w.document.querySelectorAll(s)];
const click = (w, el) => { if (!el) throw new Error('element missing'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const submit = (w, f) => f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const change = (w, el) => el.dispatchEvent(new w.Event('change', { bubbles: true }));
const input = (w, el) => el.dispatchEvent(new w.Event('input', { bubbles: true }));
const key = (w, k) => w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const st = w => JSON.parse(JSON.stringify(w.eval('S')));
const idOf = (w, list, name) => w.eval(`S.${list}.find(x => (x.name ?? x.title) === ${JSON.stringify(name)}).id`);
const tab = (w, name) => click(w, q(w, `nav button[data-tab="${name}"]`));
const toastText = w => q(w, '#toast').textContent;
const isErr = w => q(w, '#toast').className.includes('err');
const inv = w => { try { w.eval('invariants(S)'); return true; } catch { return false; } };
async function act(w, el) {                       // click, then confirm the modal if one opened
  click(w, el); await tick();
  const yes = q(w, '[data-act="modal-ok"]');
  if (yes) { click(w, yes); await tick(); }
}
async function addTask(w, { title, difficulty = 'easy', reward = '10', due = '' }) {
  tab(w, 'tasks');
  const f = q(w, 'form[data-form="task"]');
  f.elements.title.value = title; f.elements.difficulty.value = difficulty;
  f.elements.reward.value = reward; f.elements.due.value = due;
  submit(w, f); await tick();
}

(async () => {
  // 1. Fresh load & legacy migration
  const dom = open(); const w = dom.window;
  check('fresh load: no errors', dom.errors.length === 0, dom.errors.join('|'));
  check('defaults: RTL, XP 0, no achievements', w.document.documentElement.dir === 'rtl' && st(w).xp === 0 && st(w).achievements.length === 0);
  check('weekly chart renders 7 bars', qa(w, '#app svg rect').length === 7);
  check('Arabic digits parse; bad amounts rejected', w.eval("toP('٥٠') === 5000 && toP('-5') === null && toP('1.234') === null"));
  const legacy = open({ 'earnit.v1': JSON.stringify({ v:1, balance:0, savings:0, lifetime:0, spending:0, tasks:[], rewards:[], purchases:[], goals:[], ledger:[], used:{} }) });
  check('v1 saved data migrates (xp, achievements defaults)', legacy.window.eval('S.xp === 0 && S.achievements.length === 0'));

  // 2. Completion, undo, re-completion, duplicate guard
  await addTask(w, { title: 'قراءة فصل <img src=x onerror=alert(1)>', difficulty: 'medium', reward: '42.50', due: TODAY });
  check('task saved with reward 4250', st(w).tasks.length === 1 && st(w).tasks[0].reward === 4250);
  check('HTML in title is escaped', q(w, '#app img') === null);
  const tid = st(w).tasks[0].id;
  await act(w, q(w, `button[data-act="complete"][data-id="${tid}"]`));
  check('complete credits reward and 25 XP', st(w).balance === 4250 && st(w).xp === 25);
  check('first achievement unlocked and announced in toast', st(w).achievements.includes('first') && toastText(w).includes('أولى الخطوات'), toastText(w));
  check('streak is 1 after completing today', w.eval('streakOf(S)') === 1);
  await act(w, q(w, '#toast .tbtn'));
  check('undo reverses reward, XP and status', st(w).balance === 0 && st(w).xp === 0 && st(w).tasks[0].status === 'pending' && st(w).ledger.some(e => e.type === 'reversal'));
  check('invariants hold after undo', inv(w));
  await act(w, q(w, `button[data-act="complete"][data-id="${tid}"]`));
  check('completing again after undo nets exactly one reward for this task', st(w).balance === 4250 && st(w).ledger.filter(e => e.ref === tid).reduce((a, e) => a + e.amount, 0) === 4250);
  check('direct re-complete refused, no double reward', w.eval(`completeTask('${tid}')`) === null && st(w).balance === 4250);

  // 3. Edit, Escape, duplicate, postpone, search, sort, overdue
  await addTask(w, { title: 'Edit me', reward: '10' });
  const eid = st(w).tasks[0].id;
  await act(w, q(w, `button[data-act="edit"][data-id="${eid}"]`));
  const ef = q(w, 'form[data-form="edit"]');
  check('edit dialog opens prefilled', ef !== null && ef.elements.title.value === 'Edit me');
  ef.elements.title.value = 'Edited'; ef.elements.reward.value = '15';
  submit(w, ef); await tick();
  check('edit saves and closes dialog', st(w).tasks[0].title === 'Edited' && st(w).tasks[0].reward === 1500 && q(w, '#modal').hidden);
  await act(w, q(w, `button[data-act="edit"][data-id="${eid}"]`));
  key(w, 'Escape');
  check('Escape closes dialog without changes', q(w, '#modal').hidden && st(w).tasks[0].title === 'Edited');

  await addTask(w, { title: 'Beta', reward: '5', due: '2030-01-05' });
  await addTask(w, { title: 'Alpha', reward: '50', due: '2030-01-02' });
  const alpha = st(w).tasks.find(t => t.title === 'Alpha');
  await act(w, q(w, `button[data-act="dup"][data-id="${alpha.id}"]`));
  check('duplicate creates a pending copy', st(w).tasks.filter(t => t.title.startsWith('Alpha')).length === 2);
  await act(w, q(w, `button[data-act="postpone"][data-id="${alpha.id}"]`));
  check('postpone shifts due date by one day', st(w).tasks.find(t => t.id === alpha.id).due === '2030-01-03');
  const titles = () => qa(w, '#tlist > .row > div:first-child > b').map(b => b.textContent);
  let si = q(w, '#q'); si.value = 'beta'; input(w, si);
  check('search filters the list live', JSON.stringify(titles()) === '["Beta"]', JSON.stringify(titles()));
  si = q(w, '#q'); si.value = ''; input(w, si);
  const sel = q(w, '#sort'); sel.value = 'reward'; change(w, sel);
  check('sort by reward puts the highest first', titles()[0] === w.eval('S.tasks.slice().sort((a,b)=>b.reward-a.reward)[0].title'), titles().join('|'));
  await addTask(w, { title: 'Late', reward: '0', due: YESTERDAY });
  check('overdue task counted in stats', w.eval('stats().overdue') === 1);
  const b1 = st(w).balance;
  await act(w, q(w, `button[data-act="complete"][data-id="${eid}"]`));
  check('completing the edited task credits 15 EGP', st(w).balance === b1 + 1500);

  // 4. Shop: confirmation, idempotency, refund, redeem
  tab(w, 'shop');
  { const f = q(w, 'form[data-form="reward"]'); f.elements.name.value = 'Console'; f.elements.price.value = '100000'; submit(w, f); await tick(); }
  const cid = idOf(w, 'rewards', 'Console');
  check('unaffordable reward has disabled buy button', q(w, `button[data-act="buy"][data-id="${cid}"]`).disabled);
  { const f = q(w, 'form[data-form="reward"]'); f.elements.name.value = 'Coffee'; f.elements.price.value = '1'; submit(w, f); await tick(); }
  const coffee = idOf(w, 'rewards', 'Coffee');
  const b2 = st(w).balance;
  await act(w, q(w, `button[data-act="buy"][data-id="${coffee}"]`));
  check('purchase goes through confirmation and debits 1 EGP', st(w).balance === b2 - 100 && st(w).purchases.length === 1);
  await act(w, q(w, '#toast .tbtn'));
  check('undo refunds the purchase and restores balance', st(w).balance === b2 && st(w).purchases[0].status === 'refunded' && st(w).spending === 0);
  const K = 'k-dup-0000001';
  const a1 = w.eval(`buy('${coffee}','${K}')`), a2 = w.eval(`buy('${coffee}','${K}')`);
  check('same idempotency key charges exactly once', a1 && a2 && a2.replayed === true && st(w).balance === b2 - 100, JSON.stringify([st(w).balance, a2]));
  tab(w, 'shop');
  const pid = st(w).purchases.find(p => p.status === 'purchased').id;
  await act(w, q(w, `button[data-act="redeem"][data-id="${pid}"]`));
  check('redeem marks purchase redeemed', st(w).purchases.find(p => p.id === pid).status === 'redeemed');

  // 5. Savings
  tab(w, 'savings');
  { const f = q(w, 'form[data-form="goal"]'); f.elements.name.value = 'Laptop'; f.elements.target.value = '50000'; submit(w, f); await tick(); }
  const gid = idOf(w, 'goals', 'Laptop');
  const amt = id => q(w, `.goal button[data-act="dep"][data-id="${id}"]`).closest('.goal').querySelector('input');
  amt(gid).value = String(Math.floor(st(w).balance / 100) + 100);      // more than the balance
  await act(w, q(w, `button[data-act="dep"][data-id="${gid}"]`));
  check('deposit above available balance refused', st(w).savings === 0 && isErr(w));
  { const f = q(w, 'form[data-form="goal"]'); f.elements.name.value = 'Small'; f.elements.target.value = '3'; submit(w, f); await tick(); }
  const sid = idOf(w, 'goals', 'Small');
  amt(sid).value = '3';
  await act(w, q(w, `button[data-act="dep"][data-id="${sid}"]`));
  check('reaching target completes goal and unlocks "saver"', st(w).goals.find(g => g.name === 'Small').status === 'completed' && st(w).achievements.includes('saver'));
  amt(sid).value = '1';
  await act(w, q(w, `button[data-act="wd"][data-id="${sid}"]`));
  check('withdraw reactivates completed goal', st(w).goals.find(g => g.name === 'Small').status === 'active');
  check('savings equal sum of goals; invariants hold', w.eval('S.goals.reduce((a,g)=>a+g.saved,0) === S.savings') && inv(w));

  // 6. Level-up boundary
  tab(w, 'tasks');
  await addTask(w, { title: 'Level task', reward: '0' });
  w.eval('S.xp = 49');
  const lt = st(w).tasks.find(t => t.title === 'Level task').id;
  await act(w, q(w, `button[data-act="complete"][data-id="${lt}"]`));
  check('crossing 50 XP levels up and announces it', st(w).xp === 59 && toastText(w).includes('مستواك'), toastText(w));

  // 7. CSV, shortcuts, language, theme
  tab(w, 'tasks');
  await addTask(w, { title: '=1+1', reward: '1' });
  await act(w, q(w, `button[data-act="complete"][data-id="${st(w).tasks[0].id}"]`));
  tab(w, 'wallet');
  let csvBlob = null;
  w.URL.createObjectURL = b => { csvBlob = b; return 'blob:csv'; };
  click(w, q(w, 'button[data-act="csv"]')); await tick();
  const csvText = csvBlob ? await new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(csvBlob); }) : '';
  check('CSV export: text/csv blob and earn-it-ledger.csv download', csvBlob?.type.startsWith('text/csv') && w.__downloads.includes('earn-it-ledger.csv'), JSON.stringify(w.__downloads));
  const bytes = csvBlob ? new Uint8Array(await new Promise(res => { const fr = new w.FileReader(); fr.onload = () => res(fr.result); fr.readAsArrayBuffer(csvBlob); })) : new Uint8Array();
  check('CSV neutralises spreadsheet formula injection', csvText.includes(`"'=1+1"`), csvText.slice(-120));
  check('CSV starts with a UTF-8 BOM for Excel Arabic support', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, Array.from(bytes.slice(0, 3)).join(','));
  check('wallet table lists every ledger row', qa(w, 'table tbody tr').length === st(w).ledger.length);
  tab(w, 'dashboard');
  key(w, 'n');
  check('N opens tasks and focuses the title field', w.document.activeElement?.name === 'title');
  key(w, '/');
  check('/ focuses the search field', w.document.activeElement?.id === 'q');
  click(w, q(w, '#langBtn'));
  check('English: LTR and English navigation', w.document.documentElement.dir === 'ltr' && q(w, 'nav').textContent.includes('Dashboard'));
  click(w, q(w, '#themeBtn'));
  check('theme toggles to light', w.document.documentElement.dataset.theme === 'light');

  // 8. Persistence
  const reload = open({ 'earnit.v1': w.localStorage.getItem('earnit.v1'), 'earnit.prefs': w.localStorage.getItem('earnit.prefs') }).window;
  check('state (balance, XP, achievements) survives reload',
    reload.eval('S.xp') === w.eval('S.xp') && reload.eval('S.achievements.length') === w.eval('S.achievements.length') && reload.eval('S.balance') === w.eval('S.balance'));
  check('language and theme preferences survive reload', reload.document.documentElement.dir === 'ltr' && reload.document.documentElement.dataset.theme === 'light');

  // 9. Failure modes
  const bad = open({ 'earnit.v1': '{"balance":"oops"}' }).window;
  check('corrupt data: banner shown and backup kept',
    bad.document.querySelector('.banner') !== null &&
    Array.from({ length: bad.localStorage.length }, (_, i) => bad.localStorage.key(i)).some(k => k.startsWith('earnit.v1.backup.')));
  const broke = open({}, w2 => { w2.Storage.prototype.setItem = () => { throw new Error('quota'); }; }).window;
  await addTask(broke, { title: 'will fail' });
  check('storage failure: error shown, nothing changed', st(broke).tasks.length === 0 && isErr(broke));

  check('each achievement is unlocked at most once', new Set(st(w).achievements).size === st(w).achievements.length, JSON.stringify(st(w).achievements));
  // 10. Cosmetics store
  await addTask(w, { title: 'Bonus', reward: '200' });
  w.eval('S.xp = 800');                                     // level 5
  await act(w, q(w, `button[data-act="complete"][data-id="${st(w).tasks[0].id}"]`));
  tab(w, 'shop');
  check('default look: Royal Gold colour, no title, no backdrop', w.document.documentElement.style.getPropertyValue('--gold').trim() === '#d4af37' && q(w, '#ctitle').textContent === '' && w.document.body.dataset.amb === 'amb_none');
  check('locked backdrop shows a lock instead of a buy button', q(w, '[data-act="cosbuy"][data-id="amb_stars"]') === null && q(w, '.cos') !== null && qa(w, '.cos').some(c => c.textContent.includes('🔒')));
  check('engine refuses a locked cosmetic', w.eval("buyCosmetic('amb_stars','k-cos-lock-01')") === null && !st(w).cos.owned.includes('amb_stars'));
  const b0 = st(w).balance;
  await act(w, q(w, '[data-act="cosbuy"][data-id="pal_emerald"]'));
  check('buying an unlocked palette debits 40 EGP and marks it owned', st(w).balance === b0 - 4000 && st(w).cos.owned.includes('pal_emerald'));
  await act(w, q(w, '[data-act="coseq"][data-id="pal_emerald"]'));
  check('equipping a palette recolours the app live', w.document.documentElement.style.getPropertyValue('--gold').trim() === '#2fbf71');
  await act(w, q(w, '[data-act="cosbuy"][data-id="t_disciplined"]'));
  check('title purchase is owned', st(w).cos.owned.includes('t_disciplined'));
  await act(w, q(w, '#toast .tbtn'));
  check('undo refunds the cosmetic and restores the balance', !st(w).cos.owned.includes('t_disciplined') && st(w).balance === b0 - 4000);
  await act(w, q(w, '[data-act="cosbuy"][data-id="t_disciplined"]'));
  await act(w, q(w, '[data-act="coseq"][data-id="t_disciplined"]'));
  check('equipped title appears in the header (current language)', q(w, '#ctitle').textContent === w.eval("T('cos.t_disciplined')"), q(w, '#ctitle').textContent);
  await act(w, q(w, '[data-act="coseq"][data-id="t_disciplined"]'));
  check('equipping the same title again removes it', q(w, '#ctitle').textContent === '');
  w.eval('S.xp = 2450');                                    // level 8
  tab(w, 'shop');
  await act(w, q(w, '[data-act="cosbuy"][data-id="amb_aurora"]'));
  await act(w, q(w, '[data-act="coseq"][data-id="amb_aurora"]'));
  check('backdrop applied to the body', w.document.body.dataset.amb === 'amb_aurora');
  const bb = st(w).balance;
  const r1 = w.eval("buyCosmetic('t_saver','k-cos-0000001')"), r2 = w.eval("buyCosmetic('t_saver','k-cos-0000001')");
  check('same idempotency key for a cosmetic charges once', r1 && r2 && r2.replayed === true && st(w).balance === bb - 3000, JSON.stringify([st(w).balance, bb]));
  check('buying an already-owned cosmetic is refused', w.eval("buyCosmetic('t_saver','k-cos-0000002')") === null);
  check('cosmetic purchases keep the ledger and invariants consistent', inv(w) && w.eval("S.cos.owned.filter(x => x === 't_saver').length") === 1);
  const reload2 = open({ 'earnit.v1': w.localStorage.getItem('earnit.v1'), 'earnit.prefs': w.localStorage.getItem('earnit.prefs') }).window;
  check('ownership and equipped backdrop survive reload', reload2.eval("S.cos.owned.includes('t_saver') && S.cos.eq.ambient === 'amb_aurora'") && reload2.document.body.dataset.amb === 'amb_aurora');
  // 11. Recurring tasks
  tab(w, 'tasks');
  await addTask(w, { title: 'Funding', reward: '500' });
  await act(w, q(w, `button[data-act="complete"][data-id="${st(w).tasks[0].id}"]`));
  { const f = q(w, 'form[data-form="task"]'); f.elements.title.value = 'Daily walk'; f.elements.freq.value = 'daily'; f.elements.reward.value = '3'; submit(w, f); await tick(); }
  const rid = idOf(w, 'tasks', 'Daily walk');
  const R = () => st(w).tasks.find(t => t.id === rid);
  check('recurring task starts due today', R().due === TODAY && R().freq === 'daily');
  const rb = st(w).balance;
  await act(w, q(w, `button[data-act="complete"][data-id="${rid}"]`));
  check('completing a daily occurrence pays once and moves due to tomorrow', st(w).balance === rb + 300 && R().due === TOMORROW && R().history.length === 1 && R().status === 'pending');
  await act(w, q(w, '#toast .tbtn'));
  check('undo restores the occurrence and reverses its reward', R().due === TODAY && R().history.length === 0 && st(w).balance === rb);
  await act(w, q(w, `button[data-act="complete"][data-id="${rid}"]`));
  check('future occurrence cannot be completed early', w.eval(`completeTask('${rid}')`) === null && st(w).balance === rb + 300);
  check('invariants hold for recurring rewards', inv(w));
  { const f = q(w, 'form[data-form="task"]'); f.elements.title.value = 'Weekly review'; f.elements.freq.value = 'weekly'; f.elements.reward.value = '5'; f.elements.due.value = YESTERDAY; submit(w, f); await tick(); }
  const wid = idOf(w, 'tasks', 'Weekly review');
  const W = () => st(w).tasks.find(t => t.id === wid);
  await act(w, q(w, `button[data-act="complete"][data-id="${wid}"]`));
  check('overdue weekly occurrence advances from today by 7 days', W().due === w.eval('addDays(today(), 7)') && W().history.length === 1);
  check('recurring task with history cannot be deleted', w.eval(`deleteTask('${wid}')`) === null && W() !== undefined);

  // 12. Focus mode
  tab(w, 'focus');
  check('focus view shows 25:00 by default', q(w, '#ftime').textContent === '25:00');
  w.eval('focusStart()');
  check('timer is running', w.eval('FOCUS.timer !== null'));
  click(w, q(w, '[data-act="fstart"]')); await tick();
  check('pressing the button pauses and keeps the remaining time', w.eval('FOCUS.timer === null') && w.eval('FOCUS.left') > 0 && w.eval('FOCUS.left') <= 1500);
  const f0 = st(w).focus.length, x0 = st(w).xp;
  w.eval(`FOCUS.tid = '${rid}'`);
  w.eval('focusFinish()');
  check('finishing a session logs it, links the task and awards 15 XP', st(w).focus.length === f0 + 1 && st(w).focus[0].tid === rid && st(w).xp === x0 + 15);
  check('after finishing, the timer resets to the chosen length', w.eval('FOCUS.left') === 25 * 60);
  for (let i = 0; i < 4; i++) w.eval('focusFinish()');
  check('five sessions unlock the "focus" achievement', st(w).achievements.includes('focus'));
  check('focus sessions keep invariants', inv(w));

  // 13. Completion effects and expanded store
  w.eval("S.cos.owned.push('fx_confetti'); S.cos.eq.fx = 'fx_confetti'; render();");
  await addTask(w, { title: 'Party', reward: '0' });
  await act(w, q(w, `button[data-act="complete"][data-id="${st(w).tasks[0].id}"]`));
  check('completion triggers the equipped confetti effect', qa(w, '#fx .p').length > 0);
  w.eval('S.xp = 6050'); tab(w, 'shop');
  await act(w, q(w, '[data-act="cosbuy"][data-id="pal_obsidian"]'));
  await act(w, q(w, '[data-act="coseq"][data-id="pal_obsidian"]'));
  check('new palette from the expanded store recolours the app', w.document.documentElement.style.getPropertyValue('--gold').trim() === '#cbd5e1');
  check('store catalogue lists the new items', qa(w, '.cos').length >= 16);

  // 14. Missions & challenges
  tab(w, 'dashboard');
  check('missions card lists claimable daily task mission (done earlier today)', q(w, '[data-act="claim"][data-id="d_tasks3"]') !== null);
  const bClaim = st(w).balance;
  await act(w, q(w, '[data-act="claim"][data-id="d_tasks3"]'));
  check('claiming a mission pays its reward once and records the claim', st(w).balance === bClaim + 3000 && st(w).claims.some(c => c.startsWith('d_tasks3@')));
  check('claiming the same period again is refused', w.eval("claimMission('d_tasks3')") === null && st(w).balance === bClaim + 3000);
  check('an unfinished monthly challenge cannot be claimed', w.eval("claimMission('m_focus600')") === null && isErr(w));
  check('invariants hold after mission rewards', inv(w));

  // 15. Calendar: day, week, month, projection of recurring tasks, navigation
  tab(w, 'calendar');
  w.eval(`ui.cal.mode = 'day'; ui.cal.date = '${TOMORROW}'; render();`);
  check('day view projects tomorrow\'s recurring occurrence', q(w, '#app').textContent.includes('Daily walk') && q(w, '#app .chip.due') !== null);
  click(w, q(w, '[data-act="calmode"][data-m="week"]'));
  check('week view renders seven day cells', qa(w, '.wk .cell').length === 7);
  click(w, q(w, '[data-act="calmode"][data-m="month"]'));
  check('month view renders a 42-cell grid', qa(w, '.wk .cell').length === 42);
  const before = w.eval('ui.cal.date');
  click(w, q(w, '[data-act="calnav"][data-dir="1"]'));
  check('next navigates to the following month', w.eval('ui.cal.date') !== before);
  click(w, q(w, '[data-act="calnav"][data-dir="0"]'));
  click(w, qa(w, 'button.cell[data-act="calday"]')[0]);
  check('clicking a month cell opens that day', w.eval('ui.cal.mode') === 'day');
  check('calendar logic is consistent with the stored calendar', w.eval("calEvents(today(), today()) !== null"));

  // 16. Analytics: time filters and category charts
  tab(w, 'analytics');
  check('analytics default range shows seven trend bars', qa(w, '#app svg rect').length === 7);
  click(w, q(w, '[data-act="range"][data-r="30"]'));
  check('30-day filter shows thirty trend bars and marks the choice', qa(w, '#app svg rect').length === 30 && q(w, '[data-act="range"][data-r="30"]').getAttribute('aria-current') === 'true');
  check('earnings-by-difficulty chart has data from today\'s completions', w.eval('analyticsData(30).byDiff.length') >= 1);
  check('analytics totals are numbers derived from the ledger', typeof w.eval('analyticsData(90).earned') === 'number' && w.eval('analyticsData(90).earned') === w.eval('reportOf(rangeBounds(90).a, rangeBounds(90).b).earned'));

  // 17. Profile, avatar, frames, reports
  tab(w, 'profile');
  check('profile shows the notification status for this browser', q(w, '#app').textContent.includes(w.eval('T("notifUnsupported")')));
  { const f = q(w, 'form[data-form="profile"]'); f.elements.name.value = 'Ahmed'; submit(w, f); await tick(); }
  check('account name is saved and shown in the header avatar', st(w).profile.name === 'Ahmed' && q(w, '#hav').textContent.trim() === 'A');
  w.eval("saveAvatar('data:image/png;base64,iVBORw0KGgo=')");
  await tick();
  check('a valid photo replaces the initial inside the animated avatar', q(w, '.avatar img') !== null);
  check('a non-image URL is refused and the photo is unchanged', w.eval("saveAvatar('javascript:alert(1)')") === null && st(w).profile.avatar.startsWith('data:image/png'));
  check('reports card shows weekly and monthly toggles', qa(w, 'section.card [data-act="rep"]').length === 2);
  click(w, q(w, '[data-act="rep"][data-r="month"]'));
  check('monthly report is selected', w.eval('ui.rep') === 'month' && q(w, '[data-act="rep"][data-r="month"]').getAttribute('aria-current') === 'true');
  check('six report cards are displayed', qa(w, '.grid > .card.stat').length === 6);

  tab(w, 'tasks');
  await addTask(w, { title: 'Fund3', reward: '500' });
  await act(w, q(w, `button[data-act="complete"][data-id="${st(w).tasks[0].id}"]`));
  tab(w, 'shop');
  await act(w, q(w, '[data-act="cosbuy"][data-id="frame_gold"]'));
  await act(w, q(w, '[data-act="coseq"][data-id="frame_gold"]'));
  check('animated gold frame is bought and equipped around the avatar', q(w, '#hav .frame.f-gold') !== null && q(w, '#hav .frame.f-gold .avatar') !== null);
  const rp = open({ 'earnit.v1': w.localStorage.getItem('earnit.v1'), 'earnit.prefs': w.localStorage.getItem('earnit.prefs') }).window;
  check('profile name, photo, and frame survive reload', rp.eval("S.profile.name === 'Ahmed' && S.cos.eq.frame === 'frame_gold'") && rp.document.querySelector('#hav .frame.f-gold') !== null);
  const legacy2 = open({ 'earnit.v1': JSON.stringify({ v:1, balance:0, savings:0, lifetime:0, spending:0, tasks:[], rewards:[], purchases:[], goals:[], ledger:[], used:{} }) }).window;
  check('older saves gain profile, claims, and frame defaults', legacy2.eval("S.profile.name === '' && Array.isArray(S.claims) && S.cos.eq.frame === 'frame_none'"));
  check('manifest is linked for installation', w.document.querySelector('link[rel="manifest"]') !== null);
  check('invariants hold after profile and store actions', inv(w));

  check('no script or console errors during the whole journey', dom.errors.length === 0, dom.errors.join(' | '));
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
