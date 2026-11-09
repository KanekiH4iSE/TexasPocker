(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let sess = load();
  let ws = null;
  let S = null;          // последнее состояние стола
  let offset = 0;        // разница часов сервера и клиента
  let retry = 0;
  let lastSig = '';
  let raiseTo = 0;
  let timerTotal = 30000;
  let lastDeadline = 0;
  let wasMyTurn = false;

  function load() { try { return JSON.parse(localStorage.getItem('poker.session') || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem('poker.session', JSON.stringify(sess)); } catch (e) { /* приватный режим */ } }
  function clearSess() { sess = null; try { localStorage.removeItem('poker.session'); } catch (e) { /* ignore */ } }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ---------- сеть ----------
  function send(o) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
    toast('Нет соединения с сервером');
    return false;
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => {
      retry = 0;
      $('offline').classList.add('hidden');
      if (sess) ws.send(JSON.stringify({ t: 'join', code: sess.code, token: sess.token, name: sess.name }));
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      $('offline').classList.remove('hidden');
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }

  function onMsg(m) {
    if (m.t === 'joined') {
      sess = { code: m.code, token: m.token, name: (sess && sess.name) || $('name').value.trim() };
      save();
      try { history.replaceState(null, '', '/?room=' + m.code); } catch (e) { /* ignore */ }
      $('home').classList.add('hidden');
      $('game').classList.remove('hidden');
    } else if (m.t === 'state') {
      S = m.s;
      offset = S.now - Date.now();
      render();
    } else if (m.t === 'error') {
      if (!S && sess) { clearSess(); showHome(); }
      $('homeErr').textContent = m.msg;
      toast(m.msg);
    } else if (m.t === 'left') {
      clearSess();
      showHome();
    }
  }

  function showHome() {
    S = null; lastSig = '';
    $('game').classList.add('hidden');
    $('home').classList.remove('hidden');
    try { history.replaceState(null, '', '/'); } catch (e) { /* ignore */ }
  }

  // ---------- карты ----------
  function cardHtml(c, dim) {
    if (c === '??') return '<div class="card back"></div>';
    const r = c[0] === 'T' ? '10' : c[0];
    const red = c[1] === 'h' || c[1] === 'd';
    return `<div class="card${red ? ' red' : ''}${dim ? ' dim' : ''}"><b>${r}</b><i>${SUIT[c[1]]}</i></div>`;
  }

  // ---------- отрисовка ----------
  function render() {
    if (!S) return;
    $('roomCode').textContent = S.code;
    $('blinds').textContent = `Блайнды ${S.smallBlind}/${S.bigBlind}`;

    const me = S.players.find((p) => p.id === S.you);
    const n = S.players.length;
    const v = Math.max(0, S.players.findIndex((p) => p.id === S.you));
    const winners = new Set(((S.result && S.result.winners) || []).map((w) => w.id));

    $('board').innerHTML = S.board.map((c) => cardHtml(c)).join('');
    $('pot').innerHTML = S.pot > 0 && S.phase !== 'lobby' ? `<small>Банк</small>${S.pot}` : '';

    let seats = '';
    let bets = '';
    S.players.forEach((p, i) => {
      const r = (i - v + n) % n;
      const a = Math.PI / 2 + (r * 2 * Math.PI) / n;
      const x = 50 + 42 * Math.cos(a);
      const y = 50 + 41 * Math.sin(a);
      const cls = ['seat'];
      if (p.id === S.you) cls.push('me');
      if (p.id === S.toAct) cls.push('turn');
      if (p.folded) cls.push('folded');
      if (!p.inHand && S.phase !== 'lobby') cls.push('out');
      if (winners.has(p.id)) cls.push('win');
      const badges = (p.dealer ? '<span class="badge">D</span>' : '')
        + (p.sb ? '<span class="badge sb">М</span>' : '') + (p.bb ? '<span class="badge bb">Б</span>' : '');
      const dim = p.folded;
      seats += `<div class="${cls.join(' ')}" data-id="${p.id}" style="left:${x}%;top:${y}%">
        <div class="cards">${p.cards.map((c) => cardHtml(c, dim)).join('')}</div>
        <div class="plate">
          <div class="nm">${esc(p.name)}${p.connected ? '' : ' <span class="off">⚠</span>'}${badges}</div>
          <div class="ch">${p.chips}</div>
          <div class="act">${esc(p.allIn && !p.action ? 'олл-ин' : p.action || '')}</div>
          <div class="hand">${p.id === S.you && p.hand ? esc(p.hand) : ''}</div>
          <div class="timer"><i></i></div>
        </div></div>`;
      if (p.bet > 0) {
        const bx = 50 + (x - 50) * 0.55;
        const by = 47 + (y - 47) * 0.55;
        bets += `<div class="bet" style="left:${bx}%;top:${by}%">${p.bet}</div>`;
      }
    });
    $('seats').innerHTML = seats + bets;

    // сообщение в центре
    let msg = '';
    if (S.phase === 'lobby') {
      msg = `Ждём игроков (${n}/8).<br>Отправьте друзьям ссылку или код <b>${S.code}</b>`;
    } else if (S.result) {
      msg = S.result.winners.map((w) =>
        `<div><span class="win">${esc(w.name)} +${w.amount}</span>${w.hand ? ' · ' + esc(w.hand) : ''}</div>`).join('')
        + '<div style="color:var(--muted);font-size:12px">Следующая раздача сейчас начнётся…</div>';
    } else if (S.phase === 'runout') {
      msg = 'Все в олл-ине — открываем карты…';
    }
    $('msg').innerHTML = msg;

    $('log').innerHTML = S.log.map((l) => `<div>${esc(l)}</div>`).join('');
    $('log').scrollTop = 1e9;

    // отсчёт времени хода
    if (S.deadline !== lastDeadline) {
      lastDeadline = S.deadline;
      timerTotal = Math.max(1000, S.deadline - (Date.now() + offset));
    }
    const myTurn = !!me && S.toAct === S.you;
    if (myTurn && !wasMyTurn && navigator.vibrate) navigator.vibrate(150);
    wasMyTurn = myTurn;

    controls(me, myTurn);
    tick();
  }

  function controls(me, myTurn) {
    const el = $('controls');
    const isHost = S.hostId === S.you;
    const actor = S.players.find((p) => p.id === S.toAct);
    let sig;
    if (S.phase === 'lobby') sig = ['lobby', isHost, S.players.length].join('|');
    else if (myTurn) sig = ['act', S.handNo, S.phase, S.currentBet, me.chips, me.bet, S.minRaise, S.pot].join('|');
    else sig = ['wait', S.handNo, S.phase, S.toAct, me && me.chips, me && me.inHand, me && me.folded].join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    if (S.phase === 'lobby') {
      el.innerHTML = isHost
        ? `<div class="status"><button id="start" class="btn primary big" ${S.players.length < 2 ? 'disabled' : ''}>Начать игру</button>
           <div style="margin-top:8px">${S.players.length < 2 ? 'Нужен минимум ещё один игрок' : 'Все в сборе? Поехали!'}</div></div>`
        : '<div class="status">Ждём, пока хозяин стола начнёт игру…</div>';
      const b = $('start'); if (b) b.onclick = () => send({ t: 'start' });
      return;
    }

    if (myTurn) {
      const need = S.toCall;
      const maxTo = me.bet + me.chips;
      const minTo = Math.min(maxTo, S.currentBet + S.minRaise);
      const canRaise = maxTo > S.currentBet;
      raiseTo = Math.min(maxTo, Math.max(minTo, raiseTo || minTo));
      el.innerHTML = `<div class="yourturn">Ваш ход · <span id="cd"></span></div>
        <div class="actions">
          <button class="btn fold" data-a="fold">Фолд</button>
          <button class="btn call" data-a="${need ? 'call' : 'check'}">${need ? 'Колл ' + Math.min(need, me.chips) : 'Чек'}</button>
        </div>
        ${canRaise ? `<div class="raise">
          <div class="quick"><button data-q="0.5">½ банка</button><button data-q="1">Банк</button><button data-q="max">Макс</button></div>
          <input type="range" id="rs" min="${minTo}" max="${maxTo}" value="${raiseTo}">
          <div class="rrow"><input type="number" id="rn" min="${minTo}" max="${maxTo}" value="${raiseTo}">
          <button class="btn primary" id="rb"></button></div></div>` : ''}`;

      const setRaise = (val) => {
        raiseTo = Math.min(maxTo, Math.max(minTo, Math.round(Number(val) || minTo)));
        const rs = $('rs'); const rn = $('rn'); const rb = $('rb');
        if (!rs) return;
        rs.value = raiseTo; rn.value = raiseTo;
        rb.textContent = raiseTo >= maxTo ? `Олл-ин ${maxTo}` : `${S.currentBet ? 'Рейз до' : 'Ставка'} ${raiseTo}`;
      };
      el.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => send({ t: 'act', action: b.dataset.a }); });
      if (canRaise) {
        $('rs').oninput = (e) => setRaise(e.target.value);
        $('rn').onchange = (e) => setRaise(e.target.value);
        $('rb').onclick = () => send({ t: 'act', action: raiseTo >= maxTo ? 'allin' : 'raise', amount: raiseTo });
        el.querySelectorAll('[data-q]').forEach((b) => {
          b.onclick = () => {
            if (b.dataset.q === 'max') return setRaise(maxTo);
            return setRaise(S.currentBet + Math.round((S.pot + need) * Number(b.dataset.q)));
          };
        });
        setRaise(raiseTo);
      }
      return;
    }

    if (me && me.chips === 0 && !me.inHand) {
      el.innerHTML = '<div class="status">У вас закончились фишки.<br><button id="rebuy" class="btn primary">Докупить 1000</button></div>';
      $('rebuy').onclick = () => send({ t: 'rebuy' });
      return;
    }
    let text = '';
    if (me && me.folded) text = 'Вы сфолдили. Ждём конец раздачи…';
    else if (!me || !me.inHand) text = 'Вы сядете за стол со следующей раздачи';
    else if (actor) text = `Ходит <b>${esc(actor.name)}</b>`;
    else if (S.phase === 'showdown') text = 'Раздача окончена';
    else text = 'Ждём…';
    el.innerHTML = `<div class="status">${text}</div>`;
  }

  // полоска времени у игрока, чей ход, и секунды в кнопках
  function tick() {
    if (!S || !S.toAct) return;
    const left = Math.max(0, S.deadline - (Date.now() + offset));
    const bar = document.querySelector(`.seat[data-id="${S.toAct}"] .timer i`);
    if (bar) bar.style.width = Math.min(100, (left / timerTotal) * 100) + '%';
    const cd = $('cd');
    if (cd) cd.textContent = Math.ceil(left / 1000) + ' с';
  }
  setInterval(tick, 250);

  // ---------- главный экран ----------
  const nameOk = () => {
    const v = $('name').value.trim();
    if (!v) { $('homeErr').textContent = 'Введите имя'; $('name').focus(); return null; }
    try { localStorage.setItem('poker.name', v); } catch (e) { /* ignore */ }
    sess = null;
    return v;
  };
  $('create').onclick = () => { const n = nameOk(); if (n) { $('homeErr').textContent = ''; send({ t: 'create', name: n }); } };
  $('join').onclick = () => {
    const n = nameOk(); if (!n) return;
    const c = $('code').value.trim().toUpperCase();
    if (c.length !== 4) { $('homeErr').textContent = 'Код состоит из 4 букв'; return; }
    $('homeErr').textContent = '';
    send({ t: 'join', code: c, name: n });
  };
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value ? $('join') : $('create')).click(); });
  $('leave').onclick = () => { if (confirm('Выйти из-за стола? Ваши фишки будут потеряны.')) send({ t: 'leave' }); };
  $('copy').onclick = async () => {
    const url = `${location.origin}/?room=${S ? S.code : ''}`;
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch (e) { prompt('Скопируйте ссылку:', url); }
  };

  try { $('name').value = localStorage.getItem('poker.name') || ''; } catch (e) { /* ignore */ }
  const room = new URLSearchParams(location.search).get('room');
  if (room) $('code').value = room.toUpperCase().slice(0, 4);
  if (sess && room && sess.code !== room.toUpperCase()) clearSess(); // пришли по ссылке на другой стол
  connect();
})();
