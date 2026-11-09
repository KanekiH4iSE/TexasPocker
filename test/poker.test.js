'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bestOf, handName } = require('../lib/hand');
const { Table } = require('../lib/table');

const name = (cards) => handName(bestOf(cards.split(' ')));
const beats = (a, b) => bestOf(a.split(' ')) > bestOf(b.split(' '));

test('названия комбинаций', () => {
  assert.equal(name('Ah Kh Qh Jh Th 2c 3d'), 'Роял-флеш');
  assert.equal(name('9h 8h 7h 6h 5h 2c 3d'), 'Стрит-флеш');
  assert.equal(name('9h 9d 9c 9s 5h 2c 3d'), 'Каре');
  assert.equal(name('9h 9d 9c 5s 5h 2c 3d'), 'Фулл-хаус');
  assert.equal(name('Ah 8h 7h 6h 2h Kc 3d'), 'Флеш');
  assert.equal(name('9h 8d 7c 6s 5h 2c Kd'), 'Стрит');
  assert.equal(name('Ah 2d 3c 4s 5h 9c Kd'), 'Стрит');
  assert.equal(name('9h 9d 9c 6s 5h 2c Kd'), 'Сет');
  assert.equal(name('9h 9d 6c 6s 5h 2c Kd'), 'Две пары');
  assert.equal(name('9h 9d 7c 6s 5h 2c Kd'), 'Пара');
  assert.equal(name('Ah 9d 7c 6s 4h 2c Kd'), 'Старшая карта');
});

test('сравнение комбинаций', () => {
  assert.ok(beats('Ah Ad Kc Qs 2h 3c 4d', 'Kh Kd Ac Qs 2h 3c 4d')); // пара тузов > пара королей
  assert.ok(beats('Ah Kd 9c 7s 4h 3c 2d', 'Ah Qd 9c 7s 4h 3c 2d')); // кикер
  assert.ok(beats('6h 5d 4c 3s 2h Kc Qd', 'Ah 2d 3c 4s 5h Kc Qd')); // стрит до 6 > колесо
  assert.ok(beats('9h 9d 9c 5s 5h 2c 3d', 'Ah Ad Ac Ks 2h 3c 4d')); // фулл-хаус > сет
  assert.equal(bestOf('Ah Kd 9c 7s 4h 3c 2d'.split(' ')), bestOf('As Kc 9d 7h 4d 3s 2h'.split(' '))); // масти не важны
});

// Симуляция: случайные игроки играют сотни раздач. Проверяем, что фишки не пропадают и не появляются
// и что раздача всегда доходит до конца.
test('симуляция раздач сохраняет фишки', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let game = 0; game < 40; game++) {
    const n = 2 + (game % 7);
    const t = new Table('TEST', { startChips: 200, smallBlind: 5, bigBlind: 10, turnMs: 1e9, nextHandMs: 1e9, runoutMs: 0 });
    for (let i = 0; i < n; i++) t.addPlayer('P' + i);
    const total = n * 200;
    t.start(t.hostId);

    try {
    for (let hand = 0; hand < 30; hand++) {
      let steps = 0;
      while (t.phase !== 'showdown' && t.phase !== 'lobby') {
        if (++steps > 500) throw new Error('раздача зависла: ' + t.phase);
        if (t.phase === 'runout') { await sleep(2); continue; }
        const p = t.players[t.toAct];
        assert.ok(p, 'должен быть игрок, чей ход');
        const need = t.toCall(p);
        const r = Math.random();
        const tries = [];
        if (r < 0.12) tries.push(['fold']);
        else if (r < 0.55) tries.push([need ? 'call' : 'check']);
        else if (r < 0.9) tries.push(['raise', t.currentBet + t.minRaise + Math.floor(Math.random() * 60)]);
        else tries.push(['allin']);
        tries.push([need ? 'call' : 'check']);
        let ok = false;
        for (const [a, amt] of tries) {
          try { t.act(p.id, a, amt); ok = true; break; } catch (e) { /* пробуем безопасное действие */ }
        }
        assert.ok(ok, 'ни одно действие не сработало');
        const chips = t.players.reduce((s, q) => s + q.chips, 0);
        // после завершения раздачи выигрыш уже выплачен, а взносы ещё показываются как банк
        const live = t.phase === 'showdown' ? 0 : t.pot;
        assert.equal(chips + live, total, 'фишки должны сохраняться во время раздачи');
      }
      if (t.phase === 'lobby') break;
      const chips = t.players.reduce((s, q) => s + q.chips, 0);
      assert.equal(chips, total, 'после раздачи сумма фишек не изменилась');
      t._startHand();
      if (t.phase === 'lobby') break;
    }
    } finally {
      t.destroy();
    }
  }
});

test('нельзя ходить не в свою очередь и чекать под ставкой', () => {
  const t = new Table('T2', { turnMs: 1e9, nextHandMs: 1e9, runoutMs: 0 });
  const [a] = ['A', 'B', 'C'].map((x) => t.addPlayer(x));
  t.start(a.id);
  const actor = t.players[t.toAct];
  const other = t.players.find((p) => p !== actor);
  assert.throws(() => t.act(other.id, 'fold'), /не ваш ход/);
  assert.throws(() => t.act(actor.id, 'check'), /уравнять/);
  assert.throws(() => t.act(actor.id, 'raise', t.currentBet + 1), /Минимальный рейз/);
  t.destroy();
});

test('олл-ины разного размера: фишки сохраняются', async () => {
  const t = new Table('T3', { startChips: 100, smallBlind: 5, bigBlind: 10, turnMs: 1e9, nextHandMs: 1e9, runoutMs: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((x) => t.addPlayer(x));
  b.chips = 50; c.chips = 200;
  t.start(a.id);
  while (t.phase === 'preflop') t.act(t.players[t.toAct].id, 'allin');
  while (t.phase === 'runout') await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.phase, 'showdown');
  assert.equal(t.players.reduce((s, p) => s + p.chips, 0), 350);
  assert.equal(t.result.winners.reduce((s, w) => s + w.amount, 0), 350);
  t.destroy();
});
