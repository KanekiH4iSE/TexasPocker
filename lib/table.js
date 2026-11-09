'use strict';
// Игровой движок: один стол Texas Hold'em No-Limit. Ничего не знает про сеть —
// сервер вызывает методы и рассылает view() каждому игроку.
const crypto = require('crypto');
const { bestOf, handName } = require('./hand');

const MAX_SEATS = 8;
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

class Table {
  constructor(code, opts = {}, onChange = () => {}) {
    this.code = code;
    this.onChange = onChange;
    this.startChips = opts.startChips || 1000;
    this.smallBlind = opts.smallBlind || 10;
    this.bigBlind = opts.bigBlind || this.smallBlind * 2;
    this.turnMs = opts.turnMs || 30000;
    this.nextHandMs = opts.nextHandMs ?? 6000;
    this.runoutMs = opts.runoutMs ?? 1400;

    this.players = [];
    this.hostId = null;
    this.started = false;
    this.phase = 'lobby'; // lobby | preflop | flop | turn | river | runout | showdown
    this.board = [];
    this.deck = [];
    this.dealerIdx = -1;
    this.sbIdx = -1;
    this.bbIdx = -1;
    this.toAct = -1;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.deadline = 0;
    this.revealed = false;
    this.result = null;
    this.handNo = 0;
    this.log = [];
    this.timer = null;
    this.nextTimer = null;
    this.lastActive = Date.now();
  }

  // ---------- игроки ----------
  addPlayer(name) {
    if (this.players.length >= MAX_SEATS) throw new Error('Стол заполнен');
    const p = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: String(name || 'Игрок').trim().slice(0, 16) || 'Игрок',
      chips: this.startChips,
      bet: 0, total: 0,
      folded: false, allIn: false, inHand: false, acted: false,
      hole: [], connected: true, left: false, lastAction: '',
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this._log(`${p.name} за столом`);
    this._emit();
    return p;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  byToken(t) { return this.players.find((p) => p.token === t); }

  setConnected(id, on) {
    const p = this.byId(id);
    if (!p) return;
    p.connected = on;
    this.lastActive = Date.now();
    this._emit();
  }

  removePlayer(id) {
    const p = this.byId(id);
    if (!p) return;
    this._log(`${p.name} вышел`);
    if (p.inHand && !p.folded && this.phase !== 'showdown') {
      p.left = true;
      if (this.players[this.toAct] === p) this.act(id, 'fold');
      else { p.folded = true; this._afterFold(); }
    } else {
      this._drop(p);
    }
    this._emit();
  }

  _drop(p) {
    const i = this.players.indexOf(p);
    if (i < 0) return;
    this.players.splice(i, 1);
    if (this.dealerIdx >= i) this.dealerIdx--;
    if (this.hostId === p.id) {
      const nh = this.players.find((q) => q.connected) || this.players[0];
      this.hostId = nh ? nh.id : null;
    }
  }

  isEmpty() { return this.players.every((p) => !p.connected); }

  rebuy(id) {
    const p = this.byId(id);
    if (!p) return;
    if (p.chips > 0 || p.inHand) throw new Error('Докупиться можно только без фишек, между раздачами');
    p.chips = this.startChips;
    this._log(`${p.name} докупил ${this.startChips}`);
    this._maybeSchedule();
    this._emit();
  }

  // ---------- раздача ----------
  start(id) {
    if (id !== this.hostId) throw new Error('Начать может только хозяин стола');
    if (this.started) throw new Error('Игра уже идёт');
    if (this._eligible().length < 2) throw new Error('Нужно минимум 2 игрока');
    this.started = true;
    this._startHand();
  }

  _eligible() { return this.players.filter((p) => p.chips > 0 && !p.left); }

  _next(from, pred) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (pred(this.players[i])) return i;
    }
    return -1;
  }

  _startHand() {
    clearTimeout(this.nextTimer);
    // убираем вышедших и пустых (кто вышел во время раздачи)
    for (const p of this.players.filter((q) => q.left)) this._drop(p);
    const elig = this._eligible();
    if (elig.length < 2) {
      this.phase = 'lobby';
      this.started = false;
      this.result = null;
      this._log('Игра остановлена: нужно минимум 2 игрока с фишками');
      this._emit();
      return;
    }
    this.handNo++;
    this.deck = newDeck();
    this.board = [];
    this.revealed = false;
    this.result = null;
    for (const p of this.players) {
      p.bet = 0; p.total = 0; p.folded = false; p.allIn = false; p.acted = false;
      p.hole = []; p.lastAction = '';
      p.inHand = p.chips > 0;
      if (!p.inHand) p.folded = true;
    }
    const inH = (p) => p.inHand;
    this.dealerIdx = this._next(this.dealerIdx, inH);
    const headsUp = elig.length === 2;
    this.sbIdx = headsUp ? this.dealerIdx : this._next(this.dealerIdx, inH);
    this.bbIdx = this._next(this.sbIdx, inH);

    this._log(`— Раздача №${this.handNo} —`);
    this._post(this.players[this.sbIdx], this.smallBlind, 'малый блайнд');
    this._post(this.players[this.bbIdx], this.bigBlind, 'большой блайнд');
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    for (let r = 0; r < 2; r++) {
      for (const p of this.players) if (p.inHand) p.hole.push(this.deck.pop());
    }
    this.phase = 'preflop';
    this._seekActor(headsUp ? this.sbIdx : this.bbIdx + 1);
  }

  _post(p, amount, label) {
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.bet += a; p.total += a;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = `${label} ${a}`;
  }

  // ---------- действия ----------
  _canAct(p) { return p.inHand && !p.folded && !p.allIn; }
  _alive() { return this.players.filter((p) => p.inHand && !p.folded); }
  _needs(p) {
    if (!this._canAct(p)) return false;
    if (p.bet < this.currentBet) return true;
    const many = this.players.filter((q) => this._canAct(q)).length > 1;
    return !p.acted && many;
  }
  get pot() { return this.players.reduce((s, p) => s + p.total, 0); }

  toCall(p) { return Math.max(0, this.currentBet - p.bet); }

  act(id, action, amount) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0 || idx !== this.toAct || !['preflop', 'flop', 'turn', 'river'].includes(this.phase)) {
      throw new Error('Сейчас не ваш ход');
    }
    const p = this.players[idx];
    const need = this.toCall(p);
    this.lastActive = Date.now();

    if (action === 'fold') {
      p.folded = true; p.lastAction = 'фолд';
      this._log(`${p.name}: фолд`);
    } else if (action === 'check') {
      if (need > 0) throw new Error('Нельзя чекнуть — нужно уравнять ставку');
      p.lastAction = 'чек';
      this._log(`${p.name}: чек`);
    } else if (action === 'call' || (action === 'allin' && p.bet + p.chips <= this.currentBet)) {
      const a = Math.min(need, p.chips);
      p.chips -= a; p.bet += a; p.total += a;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? `олл-ин ${p.bet}` : (a ? `колл ${a}` : 'чек');
      this._log(`${p.name}: ${p.allIn ? 'олл-ин' : 'колл'} ${a}`);
    } else if (action === 'raise' || action === 'allin') {
      const max = p.bet + p.chips;
      let to = action === 'allin' ? max : Math.floor(Number(amount));
      if (!Number.isFinite(to)) throw new Error('Некорректная сумма');
      to = Math.min(to, max);
      if (to <= this.currentBet) throw new Error('Рейз должен быть больше текущей ставки');
      const size = to - this.currentBet;
      if (size < this.minRaise && to < max) {
        throw new Error(`Минимальный рейз — до ${this.currentBet + this.minRaise}`);
      }
      const had = this.currentBet > 0;
      const pay = to - p.bet;
      p.chips -= pay; p.bet = to; p.total += pay;
      if (p.chips === 0) p.allIn = true;
      if (size >= this.minRaise) this.minRaise = size;
      this.currentBet = to;
      for (const q of this.players) if (q !== p) q.acted = false;
      p.lastAction = p.allIn ? `олл-ин ${to}` : (had ? `рейз до ${to}` : `ставка ${to}`);
      this._log(`${p.name}: ${p.allIn ? 'олл-ин' : (had ? 'рейз' : 'ставка')} до ${to}`);
    } else {
      throw new Error('Неизвестное действие');
    }
    p.acted = true;
    this._afterAction(idx);
  }

  _afterFold() {
    if (this.phase === 'showdown' || this.phase === 'lobby') return;
    if (this._alive().length === 1) this._finishUncontested();
    else if (this.toAct < 0 || this.players[this.toAct].folded) this._afterAction(Math.max(this.toAct, 0));
    this._emit();
  }

  _afterAction(fromIdx) {
    if (this._alive().length === 1) return this._finishUncontested();
    const nxt = this._next(fromIdx, (p) => this._needs(p));
    if (nxt >= 0) return this._setActor(nxt);
    return this._nextStreet();
  }

  // первый ход улицы: ищем начиная с fromIdx включительно
  _seekActor(fromIdx) {
    const n = this.players.length;
    const start = (((fromIdx - 1) % n) + n) % n;
    const nxt = this._next(start, (p) => this._needs(p));
    if (nxt >= 0) this._setActor(nxt);
    else this._nextStreet();
  }

  _setActor(i) {
    this.toAct = i;
    const p = this.players[i];
    this.deadline = Date.now() + (p.connected ? this.turnMs : Math.min(8000, this.turnMs));
    clearTimeout(this.timer);
    const id = p.id;
    this.timer = setTimeout(() => this._timeout(id), this.deadline - Date.now() + 50);
    this._emit();
  }

  _timeout(id) {
    const p = this.byId(id);
    if (!p || this.players[this.toAct] !== p) return;
    try { this.act(id, this.toCall(p) === 0 ? 'check' : 'fold'); } catch (e) { /* ход уже сменился */ }
  }

  _nextStreet() {
    clearTimeout(this.timer);
    this.toAct = -1; this.deadline = 0;
    for (const p of this.players) { p.bet = 0; p.acted = false; if (!p.folded && !p.allIn) p.lastAction = ''; }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    if (this.phase === 'river' || this.phase === 'runout') return this._showdown();
    const order = { preflop: 'flop', flop: 'turn', turn: 'river' };
    const next = order[this.phase];
    this.deck.pop(); // сжигаем карту
    const n = next === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
    this.phase = next;
    this._log(`${{ flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' }[next]}: ${this.board.join(' ')}`);

    const canAct = this.players.filter((p) => this._canAct(p)).length;
    if (canAct <= 1) {
      // торговаться некому — открываем остальные карты с паузой
      this.phase = 'runout';
      this._emit();
      this.timer = setTimeout(() => this._runoutStep(), this.runoutMs);
      return;
    }
    this._seekActor(this.dealerIdx + 1);
  }

  _runoutStep() {
    if (this.board.length >= 5) return this._showdown();
    this.deck.pop();
    this.board.push(this.deck.pop());
    this._log(`${this.board.length === 4 ? 'Тёрн' : 'Ривер'}: ${this.board.join(' ')}`);
    this._emit();
    this.timer = setTimeout(() => this._runoutStep(), this.runoutMs);
  }

  // ---------- завершение ----------
  _finishUncontested() {
    clearTimeout(this.timer);
    const w = this._alive()[0];
    const won = this.pot;
    w.chips += won;
    this.toAct = -1; this.deadline = 0;
    this.phase = 'showdown';
    this.revealed = false;
    this.result = { winners: [{ id: w.id, name: w.name, amount: won, hand: null }], uncontested: true };
    this._log(`${w.name} забирает ${won} (все сфолдили)`);
    this._endHand();
  }

  _showdown() {
    clearTimeout(this.timer);
    this.toAct = -1; this.deadline = 0;
    this.phase = 'showdown';
    this.revealed = true;
    const alive = this._alive();
    const score = new Map(alive.map((p) => [p, bestOf([...p.hole, ...this.board])]));

    // побочные банки: уровни по взносам живых игроков
    const levels = [...new Set(alive.map((p) => p.total))].sort((a, b) => a - b);
    const everyone = this.players.filter((p) => p.total > 0);
    const won = new Map();
    let prev = 0;
    levels.forEach((lvl, li) => {
      let pot = 0;
      for (const p of everyone) pot += Math.max(0, Math.min(p.total, lvl) - prev);
      if (li === levels.length - 1) {
        // остаток выше последнего уровня (в норме нет) — в последний банк
        for (const p of everyone) pot += Math.max(0, p.total - lvl);
      }
      prev = lvl;
      const elig = alive.filter((p) => p.total >= lvl);
      const top = Math.max(...elig.map((p) => score.get(p)));
      const ws = elig.filter((p) => score.get(p) === top);
      const share = Math.floor(pot / ws.length);
      let odd = pot - share * ws.length;
      const n = this.players.length;
      // нечётные фишки — первым по часовой от дилера
      const ordered = [...ws].sort((a, b) => {
        const da = (this.players.indexOf(a) - this.dealerIdx - 1 + n) % n;
        const db = (this.players.indexOf(b) - this.dealerIdx - 1 + n) % n;
        return da - db;
      });
      for (const p of ordered) {
        const add = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        won.set(p, (won.get(p) || 0) + add);
      }
    });

    const winners = [];
    for (const [p, amount] of won) {
      p.chips += amount;
      winners.push({ id: p.id, name: p.name, amount, hand: handName(score.get(p)) });
      this._log(`${p.name} выигрывает ${amount} — ${handName(score.get(p))}`);
    }
    this.result = { winners, uncontested: false };
    this._endHand();
  }

  _endHand() {
    this._maybeSchedule();
    this._emit();
  }

  // Следующая раздача стартует сама; если играть некому — _startHand вернёт стол в лобби.
  _maybeSchedule() {
    if (this.phase !== 'showdown') return;
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => this._startHand(), this.nextHandMs);
  }

  // ---------- вид для клиента ----------
  view(viewerId) {
    const me = this.byId(viewerId);
    const list = this.players.map((p, i) => {
      let cards = [];
      if (p.inHand && p.hole.length) {
        if (p.id === viewerId || (this.revealed && !p.folded)) cards = p.hole;
        else if (!p.folded) cards = ['??', '??'];
      }
      let hand = null;
      if (cards.length && cards[0] !== '??' && this.board.length >= 3 && !p.folded) {
        hand = handName(bestOf([...p.hole, ...this.board]));
      }
      return {
        id: p.id, name: p.name, chips: p.chips, bet: p.bet,
        folded: p.folded && p.inHand, allIn: p.allIn, inHand: p.inHand,
        connected: p.connected, cards, hand, action: p.lastAction,
        dealer: i === this.dealerIdx && this.started,
        sb: i === this.sbIdx && p.inHand && this.started,
        bb: i === this.bbIdx && p.inHand && this.started,
      };
    });
    const actor = this.toAct >= 0 ? this.players[this.toAct] : null;
    return {
      code: this.code, phase: this.phase, started: this.started, handNo: this.handNo,
      board: this.board, pot: this.pot, currentBet: this.currentBet, minRaise: this.minRaise,
      smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      hostId: this.hostId, you: me ? me.id : null,
      toAct: actor ? actor.id : null, deadline: this.deadline, now: Date.now(),
      toCall: me ? this.toCall(me) : 0,
      players: list, result: this.result, log: this.log.slice(-40),
    };
  }

  _log(s) { this.log.push(s); if (this.log.length > 120) this.log.shift(); }
  _emit() { try { this.onChange(this); } catch (e) { console.error(e); } }

  destroy() { clearTimeout(this.timer); clearTimeout(this.nextTimer); }
}

module.exports = { Table, MAX_SEATS };
