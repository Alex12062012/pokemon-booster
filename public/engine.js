// Bourse aux Boosters — moteur de tirage.
// Partagé entre le site (navigateur) et le script de build (Node), sans dépendance au DOM.

export const START_BALANCE = 100;          // € au début d'une partie
export const JACKPOT_MIN = 200;            // € : une carte à ce prix ou plus ne sort que par le jackpot
export const JACKPOT_RATE = 1 / 250;       // chance qu'un booster cache un jackpot
export const VITRINE_MIN_PRICE = 20;       // € : toute carte à ce prix ou plus entre en vitrine
export const ANOMALY_PRICE = 25000;        // € : au-delà, la cote est considérée comme une erreur

// Niveaux de rareté, du plus courant au plus rare.
export const TIERS = {
  c:   { label: 'Commune' },
  u:   { label: 'Peu commune' },
  r:   { label: 'Rare' },
  h:   { label: 'Rare Holo' },
  ur:  { label: 'Ultra Rare' },
  fa:  { label: 'Full Art' },
  sr:  { label: 'Secrète' },
  sir: { label: 'Illustration Spéciale' },
  jp:  { label: 'Jackpot' },
};
export const TIER_ORDER = ['c', 'u', 'r', 'h', 'ur', 'fa', 'sr', 'sir', 'jp'];
export const VITRINE_TIERS = new Set(['fa', 'sr', 'sir', 'jp']);

// Plus de 40 raretés officielles, toutes époques, rangées dans 8 niveaux.
const RARITY_TIER = {
  'Common': 'c',
  'Uncommon': 'u',
  'Rare': 'r',
  'Rare Holo': 'h', 'Promo': 'h', 'Classic Collection': 'h',
  'Double Rare': 'ur', 'Rare Holo EX': 'ur', 'Rare Holo ex': 'ur', 'Rare Holo GX': 'ur',
  'Rare Holo V': 'ur', 'Holo Rare V': 'ur', 'Rare Holo VMAX': 'ur', 'Holo Rare VMAX': 'ur',
  'Rare Holo VSTAR': 'ur', 'Holo Rare VSTAR': 'ur', 'Rare Holo LV.X': 'ur', 'Rare BREAK': 'ur',
  'Rare Prime': 'ur', 'LEGEND': 'ur', 'Rare Prism Star': 'ur', 'Radiant Rare': 'ur',
  'Amazing Rare': 'ur', 'ACE SPEC Rare': 'ur', 'Rare ACE': 'ur', 'Trainer Gallery Rare Holo': 'ur',
  'Pikachu Rare': 'ur', 'Rare Shiny': 'ur', 'Shiny Rare': 'ur', 'MEGA_ATTACK_RARE': 'ur',
  'Mega Attack Rare': 'ur',
  'Rare Ultra': 'fa', 'Ultra Rare': 'fa', 'Illustration Rare': 'fa', 'Shiny Ultra Rare': 'fa',
  'Rare Shiny GX': 'fa',
  'Rare Secret': 'sr', 'Rare Rainbow': 'sr', 'Hyper Rare': 'sr', 'Rare Holo Star': 'sr',
  'Rare Shining': 'sr', 'Futuristic Rare': 'sr',
  'Special Illustration Rare': 'sir', 'Mega Hyper Rare': 'sir', 'Black White Rare': 'sir',
};

export function isKnownRarity(rarity) {
  return Object.prototype.hasOwnProperty.call(RARITY_TIER, rarity);
}

// Niveau d'une rareté. Les raretés inconnues (nouvelles séries) sont devinées par mots-clés.
const RARITY_LOWER = Object.fromEntries(Object.entries(RARITY_TIER).map(([k, v]) => [k.toLowerCase(), v]));
Object.assign(RARITY_LOWER, { 'holo rare': 'h', 'rare holo': 'h', 'none': null });

export function tierOf(rarity) {
  if (!rarity) return null;
  if (isKnownRarity(rarity)) return RARITY_TIER[rarity];
  const low = rarity.toLowerCase();
  if (low in RARITY_LOWER) return RARITY_LOWER[low];
  const r = rarity.toLowerCase();
  if (r.includes('special illustration')) return 'sir';
  if (/hyper|secret|rainbow|gold/.test(r)) return 'sr';
  if (/illustration|ultra|full art/.test(r)) return 'fa';
  if (/holo|\bex\b|gx|vmax|vstar|shiny|radiant|ace|prism|break|legend|double|mega/.test(r)) return 'ur';
  if (r.includes('rare')) return 'r';
  return null;
}

// Composition d'un booster de 10 cartes, calquée sur les boosters récents.
export const PACK_LAYOUT = ['c', 'c', 'c', 'c', 'u', 'u', 'u', 'rev', 'special', 'rare'];
export const SPECIAL_SLOT = [['sir', 0.03], ['fa', 0.075], ['rev', 0.895]];
export const RARE_SLOT = [['sr', 0.02], ['fa', 0.065], ['ur', 0.17], ['h', 0.30], ['r', 0.445]];

// Rendement moyen visé (valeur moyenne d'un booster ÷ son prix), hors jackpot.
export const MODES = {
  reel:      { label: 'Réaliste',  ratio: 0.70, hint: 'Comme souvent en vrai : un booster rapporte moins que son prix.' },
  equilibre: { label: 'Équilibré', ratio: 1.05, hint: 'Tu gagnes un peu en moyenne, mais une mauvaise série peut te ruiner.' },
  genereux:  { label: 'Généreux',  ratio: 1.30, hint: 'Nettement rentable, pour enchaîner les ouvertures.' },
};

// Si un niveau n'a aucune carte, on se rabat sur le niveau inférieur.
const FALLBACK = { jp: 'sir', sir: 'sr', sr: 'fa', fa: 'ur', ur: 'h', h: 'r', r: 'u', u: 'c', c: null };

const meanPrice = (arr, key = 'price') => (arr.length ? arr.reduce((s, c) => s + c[key], 0) / arr.length : 0);

export function buildModel(data) {
  const sets = data.sets.map(([id, name, series, date]) => ({ id, name, series, date }));
  const cards = [];
  const byId = new Map();
  for (const [id, si, name, ri, price, rev, img] of data.cards) {
    const rarity = data.rarities[ri] ?? null;
    const tier = tierOf(rarity);
    if (!tier || !(price > 0)) continue;
    const card = { id, set: sets[si] || null, name, rarity, tier, price, rev: rev > 0 ? rev : 0, img };
    cards.push(card);
    byId.set(id, card);
  }

  const pools = Object.fromEntries(TIER_ORDER.map((t) => [t, []]));
  const revPool = [];
  for (const c of cards) {
    if (c.price >= JACKPOT_MIN) pools.jp.push(c);
    else pools[c.tier].push(c);
    if ((c.tier === 'c' || c.tier === 'u' || c.tier === 'r') && c.rev > 0 && c.rev < JACKPOT_MIN) revPool.push(c);
  }

  const model = { sets, cards, byId, pools, revPool, counts: data.counts || null, pricesUpdated: data.pricesUpdated || null, generatedAt: data.generatedAt || null };
  model.stats = {};
  for (const t of TIER_ORDER) model.stats[t] = { n: pools[t].length, mean: meanPrice(pools[t]) };
  model.stats.rev = { n: revPool.length, mean: meanPrice(revPool, 'rev') };
  model.ev = expectedValue(model);
  model.jackpotEV = JACKPOT_RATE * model.stats.jp.mean;
  return model;
}

export function poolFor(model, tier) {
  let t = tier;
  while (t && !model.pools[t].length) t = FALLBACK[t];
  return t ? model.pools[t] : model.cards;
}

function slotMean(model, tier) {
  if (tier === 'rev') return model.revPool.length ? model.stats.rev.mean : meanPrice(poolFor(model, 'u'));
  return meanPrice(poolFor(model, tier));
}

// Valeur moyenne d'un booster, hors jackpot.
export function expectedValue(model) {
  const table = (rows) => rows.reduce((s, [t, p]) => s + p * slotMean(model, t), 0);
  let ev = 0;
  for (const slot of PACK_LAYOUT) {
    if (slot === 'special') ev += table(SPECIAL_SLOT);
    else if (slot === 'rare') ev += (model.pools.jp.length ? 1 - JACKPOT_RATE : 1) * table(RARE_SLOT);
    else ev += slotMean(model, slot);
  }
  return ev;
}

export function boosterPrice(model, mode) {
  const ratio = (MODES[mode] || MODES.equilibre).ratio;
  return Math.max(0.5, Math.round((model.ev / ratio) * 20) / 20);
}

// Chance qu'un booster contienne au moins une carte de ce niveau (niveaux rares uniquement).
export function tierChance(tier) {
  const inRare = RARE_SLOT.find(([t]) => t === tier)?.[1] || 0;
  const inSpecial = SPECIAL_SLOT.find(([t]) => t === tier)?.[1] || 0;
  if (tier === 'jp') return JACKPOT_RATE;
  const pr = inRare * (1 - JACKPOT_RATE);
  return 1 - (1 - pr) * (1 - inSpecial);
}

function roll(table, rnd) {
  const x = rnd();
  let acc = 0;
  for (const [t, p] of table) {
    acc += p;
    if (x < acc) return t;
  }
  return table[table.length - 1][0];
}

export function openPack(model, rnd = Math.random) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const draw = (tier, slot) => {
    if (tier === 'rev') {
      if (model.revPool.length) {
        const c = pick(model.revPool);
        return { id: c.id, rev: true, price: c.rev, tier: c.tier, slot };
      }
      tier = 'u';
    }
    const c = pick(poolFor(model, tier));
    return { id: c.id, rev: false, price: c.price, tier: tier === 'jp' ? 'jp' : c.tier, slot };
  };
  return PACK_LAYOUT.map((slot) => {
    if (slot === 'special') return draw(roll(SPECIAL_SLOT, rnd), slot);
    if (slot === 'rare') {
      if (model.pools.jp.length && rnd() < JACKPOT_RATE) return draw('jp', slot);
      return draw(roll(RARE_SLOT, rnd), slot);
    }
    return draw(slot, slot);
  });
}

export function isVitrine(pull) {
  return VITRINE_TIERS.has(pull.tier) || pull.price >= VITRINE_MIN_PRICE;
}

// Simulation d'un grand nombre de boosters (contrôles et chiffres affichés dans le jeu).
export function simulate(model, n = 20000, rnd = Math.random) {
  const values = new Float64Array(n);
  let sum = 0;
  let vitrine = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    let hasVitrine = false;
    for (const p of openPack(model, rnd)) {
      v += p.price;
      if (isVitrine(p)) hasVitrine = true;
    }
    values[i] = v;
    sum += v;
    if (hasVitrine) vitrine++;
  }
  values.sort();
  const q = (f) => values[Math.min(n - 1, Math.floor(n * f))];
  return { n, mean: sum / n, p10: q(0.1), median: q(0.5), p90: q(0.9), p99: q(0.99), pVitrine: vitrine / n, values };
}

export function shareAtLeast(sim, x) {
  let lo = 0;
  let hi = sim.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sim.values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return (sim.n - lo) / sim.n;
}

// Parties simulées depuis 100 € : survie et chance de doubler la mise.
export function bankroll(model, price, runs = 2000, maxPacks = 200, rnd = Math.random) {
  let brokeBy20 = 0;
  let doubled = 0;
  const lives = [];
  for (let r = 0; r < runs; r++) {
    let bal = START_BALANCE;
    let n = 0;
    let dbl = false;
    while (bal >= price && n < maxPacks) {
      bal -= price;
      for (const p of openPack(model, rnd)) bal += p.price;
      n++;
      if (bal >= 2 * START_BALANCE) dbl = true;
    }
    const broke = bal < price;
    if (broke && n <= 20) brokeBy20++;
    if (dbl) doubled++;
    lives.push(broke ? n : maxPacks);
  }
  lives.sort((a, b) => a - b);
  return { runs, maxPacks, pBrokeBy20: brokeBy20 / runs, pDoubled: doubled / runs, medianPacks: lives[runs >> 1] };
}

export function imageUrls(card) {
  const k = card.img || '';
  if (k.startsWith('~')) {
    const key = k.slice(1);
    return { small: `https://images.scrydex.com/pokemon/${key}/small`, large: `https://images.scrydex.com/pokemon/${key}/large` };
  }
  if (k.startsWith('!')) {
    const [small, large] = k.slice(1).split('|');
    return { small, large: large || small };
  }
  return { small: `https://images.pokemontcg.io/${k}.png`, large: `https://images.pokemontcg.io/${k}_hires.png` };
}

export function cardmarketUrl(card) {
  return `https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name || card.id)}`;
}
