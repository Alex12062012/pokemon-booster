// Récupère toutes les cartes Pokémon et leurs cotes Cardmarket depuis l'API pokemontcg.io,
// puis écrit public/cards.json (données du jeu) et public/stats.json (contrôles du calcul de prix).
// Lancé par Vercel à chaque mise en ligne : un nouveau déploiement rafraîchit les cotes.
import { access, mkdir, writeFile } from 'node:fs/promises';
import {
  ANOMALY_PRICE, MODES, TIER_ORDER, TIERS,
  bankroll, boosterPrice, buildModel, isKnownRarity, shareAtLeast, simulate, tierOf,
} from '../public/engine.js';

const API = 'https://api.pokemontcg.io/v2';
const KEY = process.env.POKEMONTCG_API_KEY || '';
const HEADERS = KEY ? { 'X-Api-Key': KEY } : {};
const SPACING_MS = KEY ? 250 : 2100; // sans clé : 30 requêtes par minute au maximum
const PAGE = 250;
const WORKERS = 3;
const DEADLINE = Date.now() + 35 * 60 * 1000;
const FIELDS = 'id,name,number,rarity,images,cardmarket';
// Nombre de cartes visé : on prend les séries les plus récentes jusqu'à l'atteindre. 0 = toutes les cartes.
const CARD_LIMIT = Number(process.env.CARD_LIMIT ?? 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const round2 = (x) => Math.round(x * 100) / 100;

let nextStart = 0;
async function throttle() {
  const now = Date.now();
  const start = Math.max(now, nextStart);
  nextStart = start + SPACING_MS;
  if (start > now) await sleep(start - now);
}

async function getJSON(url, tries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (Date.now() > DEADLINE) throw new Error('délai global dépassé');
    await throttle();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (res.status === 429) {
        lastErr = new Error('HTTP 429');
        log(`  limite de débit atteinte, pause (${url})`);
        await sleep(20_000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      log(`  essai ${attempt}/${tries} échoué (${e.name === 'AbortError' ? 'délai dépassé' : e.message}) ${url}`);
      if (attempt < tries) await sleep(Math.min(60_000, 3000 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const cardsUrl = (page, size = PAGE, q = '') =>
  `${API}/cards?page=${page}&pageSize=${size}&select=${FIELDS}${q ? `&q=${encodeURIComponent(q)}` : ''}`;

const setOf = (id) => id.slice(0, id.indexOf('-'));

// Copie publique de la liste des séries, utilisée si l'API ne répond pas.
const SETS_MIRROR = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json';

async function fetchSets() {
  let sets = [];
  try {
    for (let page = 1; ; page++) {
      const r = await getJSON(`${API}/sets?page=${page}&pageSize=250`, 3);
      sets.push(...r.data);
      if (page * 250 >= r.totalCount) break;
    }
  } catch (e) {
    log(`Liste des séries indisponible sur l'API (${e.message}), utilisation de la copie GitHub`);
    const res = await fetch(SETS_MIRROR);
    if (!res.ok) throw new Error(`copie des séries : HTTP ${res.status}`);
    sets = await res.json();
  }
  sets.sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || '') || a.id.localeCompare(b.id));
  return sets;
}

async function fetchRecentSets(sets) {
  const chosen = [];
  let planned = 0;
  for (const s of [...sets].reverse()) {
    if (planned >= CARD_LIMIT) break;
    if (!s.total) continue;
    chosen.push(s);
    planned += s.total;
  }
  log(`Limite de ${CARD_LIMIT} cartes : ${chosen.length} séries les plus récentes (${planned} cartes prévues)`);
  const byId = new Map();
  const queue = [...chosen];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        for (let page = 1; ; page++) {
          const r = await getJSON(cardsUrl(page, PAGE, `set.id:${s.id}`), 4);
          for (const c of r.data) byId.set(c.id, c);
          if (page * PAGE >= r.totalCount) break;
        }
      } catch (e) {
        log(`  série ${s.id} : échec (${e.message})`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { byId, total: planned, failed: [], chosen };
}

async function fetchAllCards() {
  const byId = new Map();
  const add = (list) => { for (const c of list || []) byId.set(c.id, c); };
  const first = await getJSON(cardsUrl(1));
  add(first.data);
  const total = first.totalCount;
  const pages = Math.ceil(total / PAGE);
  log(`API : ${total} cartes annoncées, ${pages} pages de ${PAGE}`);
  const queue = [];
  for (let p = 2; p <= pages; p++) queue.push(p);
  const failed = [];
  let done = 1;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try {
        add((await getJSON(cardsUrl(p))).data);
      } catch {
        log(`  page ${p} : nouvel essai en deux demi-pages`);
        try {
          add((await getJSON(cardsUrl(2 * p - 1, PAGE / 2), 3)).data);
          add((await getJSON(cardsUrl(2 * p, PAGE / 2), 3)).data);
        } catch {
          failed.push(p);
          log(`  page ${p} abandonnée`);
        }
      }
      done++;
      if (done % 10 === 0 || done === pages) log(`  ${done}/${pages} pages, ${byId.size} cartes uniques`);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { byId, total, failed };
}

// L'ordre des pages de l'API n'est pas garanti : on complète série par série ce qui manque.
async function fillMissing(byId, sets) {
  const have = new Map();
  for (const id of byId.keys()) have.set(setOf(id), (have.get(setOf(id)) || 0) + 1);
  const short = sets.filter((s) => (have.get(s.id) || 0) < (s.total || 0));
  if (!short.length) return 0;
  log(`${short.length} séries incomplètes, complément série par série`);
  let added = 0;
  for (const s of short) {
    if (Date.now() > DEADLINE - 90_000) {
      log('  délai presque atteint, arrêt du complément');
      break;
    }
    try {
      for (let page = 1; ; page++) {
        const r = await getJSON(cardsUrl(page, PAGE, `set.id:${s.id}`), 3);
        for (const c of r.data) {
          if (!byId.has(c.id)) {
            byId.set(c.id, c);
            added++;
          }
        }
        if (page * PAGE >= r.totalCount) break;
      }
    } catch (e) {
      log(`  série ${s.id} : échec (${e.message})`);
    }
  }
  return added;
}

const pos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Cote robuste : médiane de la moyenne 30 jours, de la tendance et du prix moyen de vente.
function robust(values) {
  const v = values.filter(pos).sort((a, b) => a - b);
  if (v.length >= 3) return v[1];
  return v.length ? v[0] : 0;
}

function pricesOf(cm) {
  const p = cm?.prices;
  if (!p) return [0, 0];
  let normal = robust([p.avg30, p.trendPrice, p.averageSellPrice]);
  if (!normal && pos(p.lowPrice)) normal = p.lowPrice;
  const rev = robust([p.reverseHoloAvg30, p.reverseHoloTrend, p.reverseHoloSell]);
  const fix = (x) => (x > 0 ? Math.max(0.01, round2(x)) : 0);
  return [fix(normal), fix(rev)];
}

function imgKey(images) {
  const s = images?.small || '';
  const l = images?.large || '';
  let m = s.match(/^https:\/\/images\.pokemontcg\.io\/(.+)\.png$/);
  if (m && l === `https://images.pokemontcg.io/${m[1]}_hires.png`) return m[1];
  m = s.match(/^https:\/\/images\.scrydex\.com\/pokemon\/(.+)\/small$/);
  if (m && l === `https://images.scrydex.com/pokemon/${m[1]}/large`) return `~${m[1]}`;
  return `!${s}|${l}`;
}

const eur = (x) => `${x.toFixed(2)} €`;

// Source de secours : TCGdex (cotes Cardmarket incluses), utilisée si pokemontcg.io ne répond pas.
const TCGDEX = 'https://api.tcgdex.net/v2/en';
async function tcgdexJSON(url, tries = 4) {
  let lastErr;
  for (let a = 1; a <= tries; a++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1000 * a);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchFromTcgdex(limit) {
  const list = await tcgdexJSON(`${TCGDEX}/sets`);
  const sets = [];
  const cardRefs = [];
  for (const brief of [...list].reverse()) {
    if (cardRefs.length >= limit) break;
    let set;
    try { set = await tcgdexJSON(`${TCGDEX}/sets/${encodeURIComponent(brief.id)}`); } catch { continue; }
    if (!set?.cards?.length || set.serie?.id === 'tcgp' || /pocket/i.test(set.serie?.name || '')) continue;
    sets.push({ id: set.id, name: set.name, series: set.serie?.name || '', releaseDate: (set.releaseDate || '').replaceAll('-', '/'), total: set.cards.length });
    for (const c of set.cards) cardRefs.push({ id: c.id, set: set.id });
  }
  log(`TCGdex : ${sets.length} séries récentes, ${cardRefs.length} cartes`);
  const out = new Map();
  const queue = [...cardRefs];
  async function worker() {
    while (queue.length) {
      const ref = queue.shift();
      try {
        const c = await tcgdexJSON(`${TCGDEX}/cards/${encodeURIComponent(ref.id)}`);
        const cm = c.pricing?.cardmarket || {};
        const img = c.image ? `!${c.image}/low.webp|${c.image}/high.webp` : '';
        out.set(c.id, {
          id: c.id, name: c.name, rarity: c.rarity, set: ref.set, img,
          cardmarket: { updatedAt: (cm.updated || '').slice(0, 10).replaceAll('-', '/'), prices: {
            avg30: cm.avg30, trendPrice: cm.trend, averageSellPrice: cm.avg, lowPrice: cm.low,
            reverseHoloAvg30: cm['avg30-holo'], reverseHoloTrend: cm['trend-holo'], reverseHoloSell: cm['avg-holo'],
          } },
        });
      } catch { /* carte ignorée */ }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  sets.reverse();
  return { byId: out, sets };
}

async function main() {
  const t0 = Date.now();
  // Les données sont enregistrées dans le dépôt : une mise en ligne normale les réutilise
  // et prend quelques secondes. Seul le rafraîchissement (REFRESH=1) interroge l'API.
  if (process.env.REFRESH !== '1') {
    try {
      await access('public/cards.json');
      log('Données déjà présentes dans le dépôt : pas de téléchargement (REFRESH=1 pour rafraîchir les cotes).');
      return;
    } catch {
      log('Pas encore de données dans le dépôt : téléchargement complet.');
    }
  }
  log(KEY ? 'Clé API présente' : 'Pas de clé API : débit limité à 30 requêtes par minute');

  const allSets = await fetchSets();
  log(`${allSets.length} séries, de ${allSets[0]?.releaseDate} à ${allSets.at(-1)?.releaseDate}`);

  let byId, total, failed, added = 0, sets = allSets, source = 'api.pokemontcg.io';
  if (CARD_LIMIT > 0) {
    // Simple pagination (la recherche par série de l'API est peu fiable) : les premières pages suffisent.
    byId = new Map();
    failed = [];
    // Les pages profondes de l'API échouent : on trie par date de sortie décroissante et on prend le début.
    const pages = Math.ceil(CARD_LIMIT / PAGE);
    log(`Limite de ${CARD_LIMIT} cartes : ${pages} pages, des séries les plus récentes`);
    for (let p = 1; p <= pages; p++) {
      try {
        const r = await getJSON(`${cardsUrl(p)}&orderBy=-set.releaseDate`, 3);
        for (const c of r.data) byId.set(c.id, c);
        total = r.totalCount;
      } catch (e) {
        failed.push(p);
        log(`  page ${p} abandonnée (${e.message})`);
      }
    }
    const used = new Set([...byId.keys()].map(setOf));
    sets = allSets.filter((s) => used.has(s.id));
    const priced = [...byId.values()].filter((c) => c.rarity && pricesOf(c.cardmarket)[0] > 0).length;
    if (priced < CARD_LIMIT * 0.5) {
      log(`pokemontcg.io n'a fourni que ${priced} cartes cotées : passage à TCGdex`);
      ({ byId, sets } = await fetchFromTcgdex(CARD_LIMIT));
      source = 'api.tcgdex.net';
    }
  } else {
    ({ byId, total, failed } = await fetchAllCards());
    added = await fillMissing(byId, sets);
  }
  const setIdx = new Map(sets.map((s, i) => [s.id, i]));
  log(`${byId.size} cartes récupérées (${added} ajoutées par le complément, ${failed.length} pages perdues)`);

  const rarities = [];
  const rIdx = new Map();
  const rarityCount = new Map();
  const rows = [];
  let noPrice = 0;
  let noRarity = 0;
  let anomalies = 0;
  let minUpd = null;
  let maxUpd = null;
  const updCount = new Map();
  for (const c of byId.values()) {
    if (!c.rarity) { noRarity++; continue; }
    const [price, rev] = pricesOf(c.cardmarket);
    if (!(price > 0)) { noPrice++; continue; }
    if (price > ANOMALY_PRICE) {
      anomalies++;
      log(`  cote écartée : ${c.id} ${c.name} ${eur(price)}`);
      continue;
    }
    const u = c.cardmarket?.updatedAt;
    if (u) {
      if (!minUpd || u < minUpd) minUpd = u;
      if (!maxUpd || u > maxUpd) maxUpd = u;
      updCount.set(u, (updCount.get(u) || 0) + 1);
    }
    if (!rIdx.has(c.rarity)) { rIdx.set(c.rarity, rarities.length); rarities.push(c.rarity); }
    rarityCount.set(c.rarity, (rarityCount.get(c.rarity) || 0) + 1);
    const s = c.set || setOf(c.id);
    rows.push([c.id, setIdx.has(s) ? setIdx.get(s) : -1, c.name, rIdx.get(c.rarity), price, rev, c.img || imgKey(c.images)]);
  }
  rows.sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0], 'en', { numeric: true }));

  if (rows.length < Math.min(5000, CARD_LIMIT > 0 ? CARD_LIMIT * 0.5 : 5000)) throw new Error(`seulement ${rows.length} cartes exploitables : données jugées incomplètes`);

  const mainUpdate = [...updCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || maxUpd;
  const data = {
    v: 1,
    generatedAt: new Date().toISOString(),
    source,
    pricesUpdated: { min: minUpd, max: maxUpd, main: mainUpdate },
    counts: { api: total, fetched: byId.size, kept: rows.length, noPrice, noRarity, anomalies, lostPages: failed.length },
    rarities,
    sets: sets.map((s) => [s.id, s.name, s.series, s.releaseDate]),
    cards: rows,
  };

  await mkdir('public', { recursive: true });
  const json = JSON.stringify(data);
  await writeFile('public/cards.json', json);
  log(`public/cards.json écrit : ${rows.length} cartes, ${(json.length / 1e6).toFixed(2)} Mo`);
  log(`Cartes écartées : ${noPrice} sans cote, ${noRarity} sans rareté (hors boosters), ${anomalies} cotes aberrantes`);
  log(`Cotes Cardmarket relevées entre ${minUpd} et ${maxUpd} (le plus souvent le ${mainUpdate})`);

  log('Raretés :');
  for (const [r, n] of [...rarityCount.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${r.padEnd(28)} ${String(n).padStart(5)}  → ${TIERS[tierOf(r)]?.label || '?'}${isKnownRarity(r) ? '' : ' (devinée)'}`);
  }

  const model = buildModel(data);
  log('Niveaux :');
  for (const t of [...TIER_ORDER, 'rev']) {
    const s = model.stats[t];
    log(`  ${(TIERS[t]?.label || 'Reverse').padEnd(22)} ${String(s.n).padStart(5)} cartes, cote moyenne ${eur(s.mean)}`);
  }
  const top = [...model.cards].sort((a, b) => b.price - a.price).slice(0, 12);
  log('Cartes les plus chères :');
  for (const c of top) log(`  ${eur(c.price).padStart(11)}  ${c.name} (${c.id}, ${c.rarity})`);

  const sim = simulate(model, 100000);
  const modes = {};
  for (const [key, m] of Object.entries(MODES)) {
    const price = boosterPrice(model, key);
    const br = bankroll(model, price, 2000, 200);
    modes[key] = {
      ratio: m.ratio,
      price,
      realReturn: round2((model.ev + model.jackpotEV) / price * 100) / 100,
      returnWithoutJackpot: round2(model.ev / price * 100) / 100,
      shareProfitablePacks: round2(shareAtLeast(sim, price) * 100) / 100,
      ...br,
    };
  }
  const stats = {
    generatedAt: data.generatedAt,
    pricesUpdated: data.pricesUpdated,
    counts: data.counts,
    tiers: Object.fromEntries([...TIER_ORDER, 'rev'].map((t) => [t, { n: model.stats[t].n, mean: round2(model.stats[t].mean) }])),
    evWithoutJackpot: round2(model.ev),
    jackpotEV: round2(model.jackpotEV),
    simulatedPack: { mean: round2(sim.mean), p10: round2(sim.p10), median: round2(sim.median), p90: round2(sim.p90), p99: round2(sim.p99), pVitrine: round2(sim.pVitrine * 1000) / 1000 },
    modes,
    top: top.map((c) => ({ id: c.id, name: c.name, rarity: c.rarity, price: c.price })),
    durationSeconds: Math.round((Date.now() - t0) / 1000),
  };
  await writeFile('public/stats.json', JSON.stringify(stats, null, 2));
  log(`Valeur moyenne d'un booster hors jackpot : ${eur(model.ev)} (jackpot : +${eur(model.jackpotEV)})`);
  log(`Booster simulé : médiane ${eur(sim.median)}, 9 sur 10 sous ${eur(sim.p90)}, 1 sur 100 au-dessus de ${eur(sim.p99)}`);
  for (const [key, m] of Object.entries(modes)) {
    log(`  ${MODES[key].label.padEnd(10)} prix ${eur(m.price)}, boosters rentables ${Math.round(m.shareProfitablePacks * 100)} %, ruine avant 20 boosters ${Math.round(m.pBrokeBy20 * 100)} %, mise doublée ${Math.round(m.pDoubled * 100)} %, durée médiane ${m.medianPacks} boosters`);
  }
  log(`Terminé en ${stats.durationSeconds} s`);
}

main().catch((e) => {
  console.error('ÉCHEC de la préparation des données :', e);
  process.exit(1);
});
