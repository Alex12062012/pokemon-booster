import {
  START_BALANCE, TIERS, TIER_ORDER, MODES, JACKPOT_RATE, JACKPOT_MIN, VITRINE_MIN_PRICE,
  buildModel, boosterPrice, openPack, isVitrine, simulate, tierChance, imageUrls, cardmarketUrl,
} from './engine.js';

const STORE_KEY = 'bourse-aux-boosters-v1';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtEur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtInt = new Intl.NumberFormat('fr-FR');
const fmtDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const eur = (x) => fmtEur.format(x);
const signed = (x) => (x > 0.004 ? '+' : x < -0.004 ? '−' : '±') + fmtEur.format(Math.abs(x));
const pct = (x) => new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 }).format(x);
const money = (x) => Math.round(x * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const oneIn = (p) => {
  if (!(p > 0)) return '—';
  const n = 1 / p;
  return n < 1.15 ? 'presque toujours' : `1 sur ${fmtInt.format(n < 10 ? Math.round(n * 10) / 10 : Math.round(n))}`;
};
const apiDate = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split('/').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

let model = null;
let sim = null;
let state = null;
let tab = 'shop';
let vitSort = 'price';
let busy = false;
let resetStep = null;
const view = { idx: 0, up: false };
const preloads = [];
const tearAnims = [];

/* ---------- État sauvegardé sur l'appareil ---------- */

function freshRun() {
  return { opened: 0, spent: 0, sold: 0, startedAt: Date.now() };
}
function freshState() {
  return {
    v: 1, balance: START_BALANCE, mode: 'equilibre', run: freshRun(),
    life: { opened: 0, spent: 0, sold: 0, bankrupt: 0, runs: 1 },
    pulls: {}, vitrine: {}, vitrineSeen: 0, best: null, bestPack: null, last: null, pending: null,
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.v === 1) return { ...freshState(), ...s };
  } catch { /* stockage indisponible : partie non sauvegardée */ }
  return freshState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* idem */ }
}

/* ---------- Outils d'affichage ---------- */

const price = () => boosterPrice(model, state.mode);
const tierVar = (t) => `var(--t-${t})`;
const tierLabel = (x) => {
  if (x.tier === 'jp') return 'Jackpot';
  return x.rev ? `${TIERS[x.tier].label} · Reverse` : TIERS[x.tier].label;
};
const chipHTML = (x) => `<span class="chip${x.tier === 'jp' ? ' jp' : ''}" style="--tc:${tierVar(x.tier)}">${esc(tierLabel(x))}</span>`;

function enrich(pull) {
  const c = model.byId.get(pull.id);
  return { ...pull, name: c?.name || pull.id, img: c?.img || '', set: c?.set?.name || '', rarity: c?.rarity || '' };
}

function starPoints(n, outer, inner) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(2)},${(50 + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function countUp(from, to) {
  const out = $('#balance');
  const wallet = $('#wallet');
  wallet.classList.remove('bump');
  void wallet.offsetWidth;
  wallet.classList.add('bump');
  if (reduced() || Math.abs(to - from) < 0.01) { renderWallet(); return; }
  renderWallet(from);
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - (1 - k) ** 3;
    out.textContent = eur(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
    else renderWallet();
  };
  requestAnimationFrame(step);
}

function preload(pulls) {
  preloads.length = 0;
  for (const p of pulls) {
    const img = new Image();
    img.decoding = 'async';
    img.src = imageUrls(p).large;
    preloads.push(img);
  }
}

/* ---------- En-tête ---------- */

function renderWallet(shown = state.balance) {
  $('#balance').textContent = eur(shown);
  const pl = money(state.balance - START_BALANCE);
  const el = $('#pl');
  el.textContent = `${signed(pl)} sur la partie`;
  el.className = `wallet-pl ${pl > 0.004 ? 'up' : pl < -0.004 ? 'down' : ''}`;
}

function renderBadge() {
  const n = Object.keys(state.vitrine).length - (state.vitrineSeen || 0);
  const b = $('#vit-badge');
  b.hidden = n <= 0;
  b.textContent = n > 9 ? '9+' : String(n);
}

/* ---------- Boutique ---------- */

let shopPanel = 'idle';

function renderShop() {
  const p = state.pending;
  const revealing = !!p && p.revealed < p.pulls.length;
  const panel = !p ? 'idle' : revealing ? 'reveal' : 'summary';
  $('#shop-idle').hidden = panel !== 'idle';
  $('#shop-reveal').hidden = panel !== 'reveal';
  $('#shop-summary').hidden = panel !== 'summary';
  document.body.classList.toggle('revealing', panel === 'reveal');
  if (panel !== shopPanel) {
    shopPanel = panel;
    window.scrollTo(0, 0);
  }
  if (panel === 'idle') renderIdle();
  else if (panel === 'reveal') renderReveal();
  else renderSummary();
}

function renderIdle() {
  const pack = $('#pack');
  tearAnims.splice(0).forEach((a) => a.cancel());
  const pr = price();
  $('#sticker').textContent = eur(pr);
  $('#open-price').textContent = eur(pr);
  $('#n-cards').textContent = fmtInt.format(model.cards.length);
  const broke = state.balance < pr;
  $('#open').disabled = broke;
  pack.disabled = broke;
  $('#broke').hidden = !broke;
  $('#broke-left').textContent = eur(state.balance);
  const every = Math.max(1, Math.round(1 / sim.pVitrine));
  $('#shop-fine').textContent = `Rendement moyen ${pct(model.ev / pr)} hors jackpot. Une carte de vitrine environ tous les ${every} boosters.`;
  const last = $('#last');
  if (state.last) {
    const d = money(state.last.value - state.last.paid);
    last.innerHTML = `Dernier booster <b>${eur(state.last.value)}</b> <span class="${d >= 0 ? 'up' : 'down'}">${signed(d)}</span>`;
    last.hidden = false;
  } else last.hidden = true;
}

async function openBooster() {
  if (busy || state.pending) return;
  const pr = price();
  if (state.balance < pr) return;
  busy = true;
  const pulls = openPack(model).map(enrich);
  state.balance = money(state.balance - pr);
  state.run.opened++;
  state.run.spent = money(state.run.spent + pr);
  state.life.opened++;
  state.life.spent = money(state.life.spent + pr);
  state.pending = { pulls, paid: pr, revealed: 0, at: Date.now() };
  save();
  preload(pulls);
  renderWallet();
  await tearPack();
  view.idx = 0;
  view.up = false;
  renderShop();
  busy = false;
}

async function tearPack() {
  const pack = $('#pack');
  const top = $('.pack-top', pack);
  const body = $('.pack-body', pack);
  const safe = (a) => a.finished.catch(() => {});
  const keep = (a) => { tearAnims.push(a); return a; };
  if (reduced()) {
    await safe(keep(pack.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })));
    return;
  }
  await safe(pack.animate(
    [{ transform: 'rotate(0)' }, { transform: 'rotate(-2.5deg)' }, { transform: 'rotate(2.5deg)' }, { transform: 'rotate(-1.5deg)' }, { transform: 'rotate(0)' }],
    { duration: 340, easing: 'ease-in-out' },
  ));
  keep(top.animate(
    [{ transform: 'none', opacity: 1 }, { transform: 'translate(46px, -150px) rotate(24deg)', opacity: 0 }],
    { duration: 560, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
  ));
  await safe(keep(body.animate(
    [{ transform: 'none', opacity: 1 }, { transform: 'translateY(70px) scale(.9)', opacity: 0 }],
    { duration: 480, delay: 200, easing: 'ease-in', fill: 'forwards' },
  )));
}

/* ---------- Ouverture carte par carte ---------- */

function cardEl(pull) {
  const { small, large } = imageUrls(pull);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'flip';
  b.style.setProperty('--tc', tierVar(pull.tier));
  if (pull.rev) b.classList.add('is-rev');
  if (isVitrine(pull)) b.classList.add('is-hit');
  if (pull.tier === 'jp') b.classList.add('is-jp');
  b.setAttribute('aria-label', 'Retourner la carte');
  b.innerHTML = `<span class="flip-inner">
      <span class="face back" aria-hidden="true"><span class="back-mark"></span><span class="back-word">Bourse aux Boosters</span></span>
      <span class="face front"><img class="lo" alt="" decoding="async"><img class="hi" alt="${esc(pull.name)}" decoding="async"><span class="foil"></span><span class="shine"></span></span>
    </span>`;
  const lo = $('.lo', b);
  const hi = $('.hi', b);
  lo.onerror = () => {
    lo.remove();
    if (!hi.isConnected || !hi.classList.contains('ok')) $('.front', b).insertAdjacentHTML('afterbegin', `<span class="fallback-name">${esc(pull.name)}</span>`);
  };
  hi.onload = () => hi.classList.add('ok');
  hi.onerror = () => hi.remove();
  lo.src = small;
  hi.src = large;
  b.addEventListener('click', advance);
  return b;
}

function renderDots() {
  const p = state.pending;
  $('#rv-dots').innerHTML = p.pulls.map((x, i) => {
    const done = i < p.revealed;
    const cur = i === view.idx && !done;
    return `<span class="dot${done ? ' done' : ''}${cur ? ' cur' : ''}" style="--dc:${tierVar(x.tier)}"></span>`;
  }).join('');
}

function renderRevealHead() {
  const p = state.pending;
  const value = p.pulls.slice(0, p.revealed).reduce((s, x) => s + x.price, 0);
  $('#rv-count').textContent = `Carte ${view.idx + 1} sur ${p.pulls.length}`;
  $('#rv-value').textContent = eur(value);
  $('#rv-paid').textContent = `payé ${eur(p.paid)}`;
  renderDots();
}

function renderInfo(pull) {
  const box = $('#rv-info');
  if (!pull) {
    box.innerHTML = '<span class="rv-wait" aria-hidden="true">?</span>';
    return;
  }
  const big = isVitrine(pull);
  box.innerHTML = `<span class="rv-row">${chipHTML(pull)}
    <span class="rv-price${big ? ' big' : ''}" style="--tc:${tierVar(pull.tier)}">${eur(pull.price)}</span></span>
    <span class="rv-name">${esc(pull.name)}${pull.set ? ` · ${esc(pull.set)}` : ''}</span>`;
}

function renderPrimary() {
  const p = state.pending;
  const last = view.idx >= p.pulls.length - 1;
  $('#rv-next').textContent = !view.up ? 'Retourner la carte' : last ? 'Voir le booster' : 'Carte suivante';
  $('#rv-all').hidden = view.up && last;
}

function renderReveal() {
  const p = state.pending;
  view.idx = Math.min(p.revealed, p.pulls.length - 1);
  view.up = false;
  const stage = $('#stage');
  stage.replaceChildren(cardEl(p.pulls[view.idx]));
  renderRevealHead();
  renderInfo(null);
  renderPrimary();
}

function flipCurrent() {
  const p = state.pending;
  const card = $('#stage .flip');
  if (!card || view.up) return;
  view.up = true;
  card.classList.add('flipped');
  card.setAttribute('aria-label', 'Carte suivante');
  p.revealed = Math.max(p.revealed, view.idx + 1);
  save();
  const pull = p.pulls[view.idx];
  renderRevealHead();
  renderInfo(pull);
  renderPrimary();
  if (isVitrine(pull)) celebrate(pull);
}

function nextCard() {
  const p = state.pending;
  if (view.idx >= p.pulls.length - 1) {
    renderShop();
    return;
  }
  const stage = $('#stage');
  const old = $('.flip', stage);
  view.idx++;
  view.up = false;
  const fresh = cardEl(p.pulls[view.idx]);
  if (!reduced() && old) {
    old.removeEventListener('click', advance);
    old.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'translate(-115%, 4%) rotate(-11deg)', opacity: 0 }],
      { duration: 300, easing: 'ease-in', fill: 'forwards' },
    ).finished.then(() => old.remove(), () => old.remove());
    stage.append(fresh);
    fresh.animate(
      [{ transform: 'translateY(26px) scale(.93)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 320, delay: 90, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' },
    );
  } else {
    stage.replaceChildren(fresh);
  }
  renderRevealHead();
  renderInfo(null);
  renderPrimary();
}

function advance() {
  if (!state.pending || busy) return;
  if (!view.up) flipCurrent();
  else nextCard();
}

function revealAll() {
  const p = state.pending;
  if (!p) return;
  p.revealed = p.pulls.length;
  save();
  renderShop();
}

function celebrate(pull) {
  try { navigator.vibrate?.(pull.tier === 'jp' ? [70, 50, 140] : 45); } catch { /* vibreur absent */ }
  if (reduced()) return;
  setTimeout(() => {
    const stage = $('#stage');
    const n = pull.tier === 'jp' ? 40 : pull.tier === 'sir' || pull.tier === 'sr' ? 30 : 20;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'spark';
      s.style.setProperty('--tc', pull.tier === 'jp' ? ['#ff9bd2', '#ffd36e', '#a6f7c9', '#8fd3ff', '#b9a2ff'][i % 5] : tierVar(pull.tier));
      stage.append(s);
      const a = Math.random() * Math.PI * 2;
      const d = 110 + Math.random() * 120;
      s.animate(
        [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) scale(.2)`, opacity: 0 }],
        { duration: 700 + Math.random() * 600, easing: 'cubic-bezier(.15,.7,.3,1)' },
      ).finished.then(() => s.remove(), () => s.remove());
    }
  }, 260);
}

/* ---------- Bilan et revente ---------- */

function thumbEl(item, { badge = '', showName = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'thumb';
  b.style.setProperty('--tc', tierVar(item.tier));
  if (item.rev) b.classList.add('is-rev');
  if (isVitrine(item)) b.classList.add('is-hit');
  b.setAttribute('aria-label', `${item.name}, ${tierLabel(item)}, ${eur(item.price)}`);
  b.innerHTML = `<span class="thumb-img" data-name="${esc(item.name)}"><img alt="" loading="lazy" decoding="async"></span>
    <span class="thumb-price">${eur(item.price)}</span>${showName ? `<span class="thumb-name">${esc(item.name)}</span>` : ''}${badge ? `<span class="thumb-badge">${esc(badge)}</span>` : ''}`;
  const img = $('img', b);
  img.onerror = () => { img.remove(); $('.thumb-img', b).classList.add('broken'); };
  img.src = imageUrls(item).small;
  b.addEventListener('click', () => openDetail(item));
  return b;
}

function packValue(p) {
  return money(p.pulls.reduce((s, x) => s + x.price, 0));
}

function renderSummary() {
  const p = state.pending;
  const value = packValue(p);
  const d = money(value - p.paid);
  $('#sum-value').textContent = eur(value);
  $('#sum-delta').innerHTML = `<b class="${d >= 0 ? 'up' : 'down'}">${signed(d)}</b> par rapport aux ${eur(p.paid)} payés`;
  const best = p.pulls.reduce((b, x, i) => (x.price > p.pulls[b].price ? i : b), 0);
  $('#sum-grid').replaceChildren(...p.pulls.map((x, i) => {
    const t = thumbEl(x);
    if (i === best) t.classList.add('is-best');
    return t;
  }));
  $('#sum-sell').textContent = `Revendre les 10 cartes · +${eur(value)}`;
}

function addVitrine(x) {
  const key = x.rev ? `${x.id}#rev` : x.id;
  const now = Date.now();
  const v = state.vitrine[key];
  if (v) {
    v.n++;
    v.last = now;
    v.price = x.price;
  } else {
    state.vitrine[key] = { id: x.id, rev: x.rev, tier: x.tier, price: x.price, name: x.name, img: x.img, set: x.set, rarity: x.rarity, n: 1, first: now, last: now };
  }
}

function sellPack() {
  const p = state.pending;
  if (!p || busy) return;
  const value = packValue(p);
  const before = state.balance;
  state.balance = money(before + value);
  state.run.sold = money(state.run.sold + value);
  state.life.sold = money(state.life.sold + value);
  let newRare = 0;
  for (const x of p.pulls) {
    const key = x.rev ? 'rev' : x.tier;
    state.pulls[key] = (state.pulls[key] || 0) + 1;
    if (isVitrine(x)) {
      addVitrine(x);
      newRare++;
    }
    if (!state.best || x.price > state.best.price) state.best = { ...x, at: Date.now() };
  }
  if (!state.bestPack || value > state.bestPack.value) state.bestPack = { value, paid: p.paid, at: Date.now() };
  state.last = { value, paid: p.paid };
  state.pending = null;
  save();
  countUp(before, state.balance);
  showToast(`+${eur(value)} crédités${newRare ? ` · ${newRare} carte${newRare > 1 ? 's' : ''} en vitrine` : ''}`);
  renderShop();
  renderBadge();
}

function restartRun(bankrupt) {
  state.balance = START_BALANCE;
  state.run = freshRun();
  state.life.runs = (state.life.runs || 1) + 1;
  if (bankrupt) state.life.bankrupt++;
  state.pending = null;
  state.last = null;
  save();
  renderAll();
}

/* ---------- Vitrine ---------- */

function renderVitrine() {
  const items = Object.values(state.vitrine);
  items.sort(vitSort === 'price' ? (a, b) => b.price - a.price || b.last - a.last : (a, b) => b.last - a.last);
  const grid = $('#vit-grid');
  grid.replaceChildren(...items.map((x) => thumbEl(x, { badge: x.n > 1 ? `×${x.n}` : '', showName: true })));
  const every = Math.max(1, Math.round(1 / sim.pVitrine));
  $('#vit-sub').textContent = items.length
    ? `${fmtInt.format(items.length)} carte${items.length > 1 ? 's' : ''} rare${items.length > 1 ? 's' : ''} trouvée${items.length > 1 ? 's' : ''} : Full Art, Secrètes, Illustrations Spéciales, jackpots et toute carte à ${eur(VITRINE_MIN_PRICE)} ou plus.`
    : `Les Full Art, Secrètes, Illustrations Spéciales, jackpots et toute carte à ${eur(VITRINE_MIN_PRICE)} ou plus.`;
  const empty = $('#vit-empty');
  empty.hidden = items.length > 0;
  empty.textContent = `Aucune carte rare pour l'instant. Il en sort une environ tous les ${every} boosters.`;
  $$('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === vitSort)));
  state.vitrineSeen = items.length;
  save();
  renderBadge();
}

/* ---------- Statistiques ---------- */

function kpi(label, value, cls = '') {
  return `<div class="kpi"><span class="kpi-label">${esc(label)}</span><span class="kpi-value ${cls}">${value}</span></div>`;
}

function renderStats() {
  const r = state.run;
  const pendingPaid = state.pending ? state.pending.paid : 0;
  const settled = money(r.spent - pendingPaid);
  const bilan = money(r.sold - settled);
  const rendement = settled > 0 ? r.sold / settled : null;
  $('#stats-sub').textContent = `Partie commencée le ${fmtDate.format(new Date(r.startedAt))}.`;
  $('#kpis').innerHTML = [
    kpi('Boosters ouverts', fmtInt.format(r.opened)),
    kpi('Rendement réel', rendement == null ? '—' : pct(rendement), rendement == null ? '' : rendement >= 1 ? 'up' : 'down'),
    kpi('Dépensé', eur(r.spent)),
    kpi('Revendu', eur(r.sold)),
    kpi('Bilan', signed(bilan), bilan > 0.004 ? 'up' : bilan < -0.004 ? 'down' : ''),
    kpi('Solde', eur(state.balance)),
  ].join('');

  const rec = $('#records');
  rec.replaceChildren();
  if (state.best) {
    const row = document.createElement('div');
    row.className = 'record';
    row.append(thumbEl(state.best));
    row.insertAdjacentHTML('beforeend', `<div><p class="record-label">Meilleure carte</p><p class="record-value" style="color:${tierVar(state.best.tier)}">${eur(state.best.price)}</p><p class="record-name">${esc(state.best.name)}${state.best.set ? ` · ${esc(state.best.set)}` : ''}</p></div>`);
    rec.append(row);
  }
  if (state.bestPack) {
    const d = money(state.bestPack.value - state.bestPack.paid);
    rec.insertAdjacentHTML('beforeend', `<div class="kpis">${kpi('Meilleur booster', eur(state.bestPack.value))}${kpi('Gain sur ce booster', signed(d), d >= 0 ? 'up' : 'down')}</div>`);
  }
  if (!state.best && !state.bestPack) rec.innerHTML = '<p class="empty">Ouvre un premier booster pour établir tes records.</p>';

  const rows = [...TIER_ORDER.slice(0, 3), 'rev', ...TIER_ORDER.slice(3)];
  const counts = rows.map((t) => state.pulls[t] || 0);
  const max = Math.max(1, ...counts);
  $('#bars').innerHTML = rows.map((t, i) => {
    const n = counts[i];
    const w = n ? Math.max(3, (Math.log10(n + 1) / Math.log10(max + 1)) * 100) : 0;
    const label = t === 'rev' ? 'Reverse' : TIERS[t].label;
    return `<div class="bar-row" style="--tc:${tierVar(t)}"><span class="tl"><span class="tdot"></span><span>${esc(label)}</span></span><span class="bar"><i style="width:${w.toFixed(1)}%"></i></span><span class="bar-n">${fmtInt.format(n)}</span></div>`;
  }).join('');

  const l = state.life;
  const lifeBilan = money(l.sold - (l.spent - pendingPaid));
  $('#life').innerHTML = [
    kpi('Parties', fmtInt.format(l.runs || 1)),
    kpi('Faillites', fmtInt.format(l.bankrupt)),
    kpi('Boosters ouverts', fmtInt.format(l.opened)),
    kpi('Bilan total', signed(lifeBilan), lifeBilan > 0.004 ? 'up' : lifeBilan < -0.004 ? 'down' : ''),
  ].join('');
}

/* ---------- Infos ---------- */

function renderInfos() {
  const pr = price();
  const mode = MODES[state.mode] || MODES.equilibre;
  $('#price-expl').innerHTML = `Valeur moyenne d'un booster, hors jackpot : <b>${eur(model.ev)}</b>. En mode ${esc(mode.label.toLowerCase())}, le booster coûte <b>${eur(pr)}</b>, soit un rendement moyen de <b>${pct(model.ev / pr)}</b>. Les jackpots ajoutent en moyenne ${eur(model.jackpotEV)} par booster.`;
  $('#modes').innerHTML = Object.entries(MODES).map(([key, m]) =>
    `<button type="button" data-mode="${key}" aria-pressed="${key === state.mode}">${esc(m.label)}<small>${eur(boosterPrice(model, key))}</small></button>`).join('');
  $('#mode-hint').textContent = mode.hint;

  const head = '<tr><th>Rareté</th><th class="r">Chance</th><th class="r">Cartes</th><th class="r">Cote moy.</th></tr>';
  const line = (t, label, chance, n, mean) =>
    `<tr style="--tc:${tierVar(t)}"><td><span class="tl"><span class="tdot"></span><span>${esc(label)}</span></span></td><td class="r">${chance}</td><td class="r">${fmtInt.format(n)}</td><td class="r">${eur(mean)}</td></tr>`;
  const s = model.stats;
  const body = [
    line('c', 'Commune', '×4', s.c.n, s.c.mean),
    line('u', 'Peu commune', '×3', s.u.n, s.u.mean),
    line('rev', 'Reverse', '×1 ou 2', s.rev.n, s.rev.mean),
    ...['r', 'h', 'ur', 'fa', 'sr', 'sir', 'jp'].filter((t) => t !== 'jp' || s[t].n).map((t) => line(t, TIERS[t].label, oneIn(tierChance(t)), s[t].n, s[t].mean)),
  ];
  $('#odds').innerHTML = `<thead>${head}</thead><tbody>${body.join('')}</tbody>`;
  $('#jackpot-expl').textContent = `Chances par booster : ×4 signifie quatre cartes de ce type dans chaque booster.${s.jp.n
    ? ` Un booster sur ${Math.round(1 / JACKPOT_RATE)} remplace sa carte rare par une carte cotée ${eur(JACKPOT_MIN)} ou plus, tirée parmi ${fmtInt.format(s.jp.n)} cartes.`
    : ''}`;

  const c = model.counts || {};
  const upd = apiDate(model.pricesUpdated?.main || model.pricesUpdated?.max);
  $('#data-expl').innerHTML = `<b>${fmtInt.format(model.cards.length)}</b> cartes jouables${model.sets.length ? `, des séries ${esc(model.sets[0].name)} à ${esc(model.sets.at(-1).name)}` : ''}, avec leur vraie photo et leur cote Cardmarket${upd ? ` relevée le <b>${fmtDate.format(upd)}</b>` : ''}.`
    + (c.api ? ` Sur ${fmtInt.format(c.api)} cartes répertoriées, ${fmtInt.format(c.noPrice || 0)} n'ont pas de cote et ${fmtInt.format(c.noRarity || 0)} ne sortent pas en booster : elles sont écartées.` : '');
  const stale = upd && Date.now() - upd.getTime() > 45 * 86400000;
  $('#data-fine').textContent = `Cote = médiane de la moyenne sur 30 jours, de la tendance et du prix moyen de vente sur Cardmarket. Photos et cotes : pokemontcg.io.${stale ? ' Ces cotes ont plus d\'un mois : la source ne les a pas actualisées depuis.' : ''} Jeu non officiel, sans lien avec The Pokémon Company ni Cardmarket.`;
  renderReset();
}

function renderReset() {
  const zone = $('#reset-zone');
  if (resetStep === 'run') {
    zone.innerHTML = `<div class="confirm"><p>Ton solde repart à ${eur(START_BALANCE)}. La vitrine et les records sont gardés.</p><div class="confirm-row"><button class="btn btn-primary" type="button" data-reset="run-ok">Recommencer</button><button class="btn btn-ghost" type="button" data-reset="cancel">Annuler</button></div></div>`;
  } else if (resetStep === 'all') {
    zone.innerHTML = `<div class="confirm"><p>Tout est effacé : solde, vitrine, records et statistiques.</p><div class="confirm-row"><button class="btn btn-danger" type="button" data-reset="all-ok">Tout effacer</button><button class="btn btn-ghost" type="button" data-reset="cancel">Annuler</button></div></div>`;
  } else {
    zone.innerHTML = `<div class="confirm"><button class="btn btn-ghost" type="button" data-reset="run">Recommencer à ${eur(START_BALANCE)}</button><button class="btn btn-danger" type="button" data-reset="all">Tout effacer, vitrine comprise</button></div>`;
  }
}

/* ---------- Fiche d'une carte ---------- */

function openDetail(item) {
  const d = $('#detail');
  const { small, large } = imageUrls(item);
  const lo = $('#d-lo');
  const hi = $('#d-hi');
  hi.classList.remove('ok');
  hi.onload = () => hi.classList.add('ok');
  hi.onerror = () => hi.classList.remove('ok');
  lo.src = small;
  hi.src = large;
  hi.alt = item.name;
  const tier = $('#d-tier');
  tier.textContent = tierLabel(item);
  tier.className = `chip${item.tier === 'jp' ? ' jp' : ''}`;
  tier.style.setProperty('--tc', tierVar(item.tier));
  $('#d-name').textContent = item.name;
  $('#d-set').textContent = [item.set, item.rarity].filter(Boolean).join(' · ');
  $('#d-price').textContent = eur(item.price);
  $('#d-extra').textContent = item.n
    ? `Obtenue ${item.n} fois${item.first ? `, la première fois le ${fmtDate.format(new Date(item.first))}` : ''}.`
    : item.rev ? 'Cote de la version reverse.' : '';
  $('#d-cm').href = cardmarketUrl(item);
  if (typeof d.showModal === 'function') d.showModal();
  else d.setAttribute('open', '');
}

function closeDetail() {
  const d = $('#detail');
  if (typeof d.close === 'function') d.close();
  else d.removeAttribute('open');
}

/* ---------- Navigation ---------- */

function setTab(next) {
  tab = next;
  for (const v of $$('[data-view]')) v.hidden = v.dataset.view !== next;
  for (const b of $$('.tab')) {
    if (b.dataset.tab === next) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (next !== 'infos') resetStep = null;
  renderTab();
  window.scrollTo(0, 0);
}

function renderTab() {
  if (tab !== 'shop') document.body.classList.remove('revealing');
  if (tab === 'shop') renderShop();
  else if (tab === 'vitrine') renderVitrine();
  else if (tab === 'stats') renderStats();
  else renderInfos();
}

function renderAll() {
  renderWallet();
  renderBadge();
  renderTab();
}

function bindEvents() {
  $('#open').addEventListener('click', openBooster);
  $('#pack').addEventListener('click', openBooster);
  $('#restart').addEventListener('click', () => restartRun(true));
  $('#rv-next').addEventListener('click', advance);
  $('#rv-all').addEventListener('click', revealAll);
  $('#sum-sell').addEventListener('click', sellPack);
  for (const b of $$('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of $$('[data-sort]')) b.addEventListener('click', () => { vitSort = b.dataset.sort; renderVitrine(); });
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    save();
    renderInfos();
  });
  $('#reset-zone').addEventListener('click', (e) => {
    const b = e.target.closest('[data-reset]');
    if (!b) return;
    const a = b.dataset.reset;
    if (a === 'run' || a === 'all') resetStep = a;
    else if (a === 'cancel') resetStep = null;
    else if (a === 'run-ok') { resetStep = null; restartRun(false); showToast(`Nouvelle partie à ${eur(START_BALANCE)}`); return; }
    else if (a === 'all-ok') { resetStep = null; state = freshState(); save(); renderAll(); showToast('Tout a été effacé'); return; }
    renderReset();
  });
  $('#d-close').addEventListener('click', closeDetail);
  $('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });
  document.addEventListener('keydown', (e) => {
    if ($('#detail').open || tab !== 'shop' || !state.pending) return;
    if (e.target.closest?.('button, a, input')) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (state.pending.revealed < state.pending.pulls.length || view.up) advance();
    }
  });
}

/* ---------- Démarrage ---------- */

async function boot() {
  $('#pack-emblem').innerHTML = `<polygon points="${starPoints(16, 50, 38)}"/>`;
  const msg = $('#boot-msg');
  const retry = $('#boot-retry');
  try {
    retry.hidden = true;
    msg.textContent = 'Chargement des cartes et de leurs cotes…';
    const res = await fetch('cards.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    model = buildModel(data);
    if (!model.cards.length) throw new Error('aucune carte');
    sim = simulate(model, 12000);
    state = load();
    if (!MODES[state.mode]) state.mode = 'equilibre';
    if (state.pending) preload(state.pending.pulls);
    const first = model.sets.find((s) => s.date)?.date?.slice(0, 4);
    const lastYear = model.sets.at(-1)?.date?.slice(0, 4);
    if (first && lastYear) $('#pack-eyebrow').innerHTML = `Toutes époques<br>${first} – ${lastYear}`;
    bindEvents();
    renderAll();
    $('#boot').hidden = true;
  } catch (e) {
    console.error(e);
    msg.textContent = 'Impossible de charger les cartes. Vérifie ta connexion, puis réessaie.';
    retry.hidden = false;
  }
}

$('#boot-retry').addEventListener('click', boot);
boot();
