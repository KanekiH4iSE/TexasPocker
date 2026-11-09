'use strict';
// Оценка покерных комбинаций. Карта — строка из двух символов: ранг + масть ("As", "Td", "7c").

const RANKS = '23456789TJQKA';
const NAMES = [
  'Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит',
  'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш',
];

function parse(c) {
  return { r: RANKS.indexOf(c[0]) + 2, s: c[1] };
}

// Все выборки 5 из n индексов (для 7 карт — 21 комбинация).
const COMBOS = {};
function combos(n) {
  if (COMBOS[n]) return COMBOS[n];
  const out = [];
  (function rec(start, cur) {
    if (cur.length === 5) return out.push(cur.slice());
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return (COMBOS[n] = out);
}

// Число: категория * 15^5 + кикеры в системе счисления 15 — сравнимо обычным >.
function score5(cs) {
  const rs = cs.map((c) => c.r).sort((a, b) => b - a);
  const flush = cs.every((c) => c.s === cs[0].s);
  let straightHigh = 0;
  if (new Set(rs).size === 5) {
    if (rs[0] - rs[4] === 4) straightHigh = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) straightHigh = 5; // колесо A-2-3-4-5
  }
  const counts = {};
  rs.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, n]) => [n, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  let cat; let kick;
  if (straightHigh && flush) { cat = 8; kick = [straightHigh]; }
  else if (groups[0][0] === 4) { cat = 7; kick = [groups[0][1], groups[1][1]]; }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; kick = [groups[0][1], groups[1][1]]; }
  else if (flush) { cat = 5; kick = rs; }
  else if (straightHigh) { cat = 4; kick = [straightHigh]; }
  else if (groups[0][0] === 3) { cat = 3; kick = groups.map((g) => g[1]); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; kick = groups.map((g) => g[1]); }
  else if (groups[0][0] === 2) { cat = 1; kick = groups.map((g) => g[1]); }
  else { cat = 0; kick = rs; }

  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (kick[i] || 0);
  return v;
}

// Лучшая пятёрка из 5–7 карт. Возвращает число (больше — сильнее).
function bestOf(cards) {
  const cs = cards.map(parse);
  let best = -1;
  for (const idx of combos(cs.length)) {
    const s = score5(idx.map((i) => cs[i]));
    if (s > best) best = s;
  }
  return best;
}

function category(score) {
  return Math.floor(score / 15 ** 5);
}

function handName(score) {
  const cat = category(score);
  if (cat === 8 && Math.floor(score / 15 ** 4) % 15 === 14) return 'Роял-флеш';
  return NAMES[cat];
}

module.exports = { bestOf, handName, category, RANKS };
