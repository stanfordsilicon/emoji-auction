(() => {
  const socket = io();

  // Player identity is a persistent id kept in sessionStorage (not the
  // socket id) — a refresh gets a brand new socket but keeps the same
  // device id, which is what lets rejoin_room put you right back where you
  // were. sessionStorage (not localStorage) keeps two tabs on one device
  // from collapsing into a single player identity.
  function getDeviceId() {
    let id = sessionStorage.getItem('emojiauction_device_id');
    if (!id) {
      id = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('emojiauction_device_id', id);
    }
    return id;
  }

  const myId = getDeviceId();

  function saveSession(roomCode, username) {
    sessionStorage.setItem('emojiauction_session', JSON.stringify({ roomCode, username }));
  }
  function clearSession() {
    sessionStorage.removeItem('emojiauction_session');
  }
  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem('emojiauction_session') || 'null');
    } catch (e) {
      return null;
    }
  }

  // Single source of truth for what this client knows about the room —
  // always replaced wholesale from the server's room_update payload rather
  // than patched piecemeal.
  let room = null;
  let timerInterval = null;
  let localBetDrafts = {}; // entryId -> typed (not-yet-submitted) bet amount, reset each betting phase
  let revealIndex = -1; // local pointer into round.results for the reveal screen's step animation
  let viewingFinalLocally = false; // whether this tab has clicked through to the final screen

  const screens = {
    login: document.getElementById('screen-login'),
    lobby: document.getElementById('screen-lobby'),
    writing: document.getElementById('screen-writing'),
    betting: document.getElementById('screen-betting'),
    voting: document.getElementById('screen-voting'),
    reveal: document.getElementById('screen-reveal'),
    final: document.getElementById('screen-final'),
  };
  const GAME_SCREENS = ['writing', 'betting', 'voting', 'reveal'];
  const topbar = document.getElementById('game-topbar');

  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.remove('active'));
    screens[name].classList.add('active');
    topbar.classList.toggle('hidden', !GAME_SCREENS.includes(name));
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---------- LOGIN ----------
  const usernameInput = document.getElementById('input-username');
  const roomCodeInput = document.getElementById('input-room-code');
  const loginError = document.getElementById('login-error');
  const loginInviteHint = document.getElementById('login-invite-hint');

  const invitedRoomCode = new URLSearchParams(window.location.search).get('room');
  if (invitedRoomCode) {
    roomCodeInput.value = invitedRoomCode.trim().toUpperCase();
    loginInviteHint.textContent = `You've been invited to room ${roomCodeInput.value} — enter a name and join!`;
    loginInviteHint.classList.remove('hidden');
    usernameInput.focus();
  }

  document.getElementById('btn-create-room').addEventListener('click', () => {
    loginError.classList.add('hidden');
    const name = usernameInput.value;
    socket.emit('create_room', { username: name, playerId: myId }, (res) => {
      if (!res.ok) return showLoginError(res.error);
      saveSession(res.room.roomCode, name || usernameInput.value);
      applyRoom(res.room);
    });
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    loginError.classList.add('hidden');
    const name = usernameInput.value;
    socket.emit('join_room', { username: name, roomCode: roomCodeInput.value, playerId: myId }, (res) => {
      if (!res.ok) return showLoginError(res.error);
      saveSession(res.room.roomCode, name || usernameInput.value);
      applyRoom(res.room);
    });
  });

  function showLoginError(msg) {
    loginError.textContent = msg || 'Something went wrong.';
    loginError.classList.remove('hidden');
  }

  // ---------- REJOIN AFTER REFRESH ----------
  socket.on('connect', () => {
    const session = loadSession();
    if (!session || !session.roomCode) return;
    socket.emit('rejoin_room', { roomCode: session.roomCode, playerId: myId, username: session.username }, (res) => {
      if (!res.ok) {
        clearSession();
        return;
      }
      usernameInput.value = session.username || '';
      applyRoom(res.room);
    });
  });

  socket.on('room_update', (updatedRoom) => applyRoom(updatedRoom));
  socket.on('connect_error', () => toast('Connection error — retrying…'));

  // ---------- CENTRAL ROOM RENDERER ----------
  function applyRoom(updatedRoom) {
    const prevState = room ? room.state : null;
    room = updatedRoom;

    if (room.state !== 'final') viewingFinalLocally = false;

    if (room.state === 'lobby') {
      clearInterval(timerInterval);
      renderLobby();
      showScreen('lobby');
      return;
    }

    updateTopbar();

    if (room.state === 'writing' || room.state === 'betting' || room.state === 'voting') {
      if (room.state === 'betting' && prevState !== 'betting') localBetDrafts = {};
      startTimer(room.round.phaseEndsAt);
      if (room.state === 'writing') renderWriting();
      if (room.state === 'betting') renderBetting();
      if (room.state === 'voting') renderVoting();
      showScreen(room.state);
      return;
    }

    // reveal or final
    clearInterval(timerInterval);
    if (prevState !== 'reveal' && prevState !== 'final') revealIndex = -1;
    renderReveal();
    if (room.state === 'final' && viewingFinalLocally) {
      showFinalScreen();
    } else {
      showScreen('reveal');
    }
  }

  // ---------- SHARED HELPERS ----------
  function renderPlayerBadge(player) {
    const badge = document.createElement('span');
    badge.className = 'player-badge';
    badge.style.backgroundColor = player.color || '#999';
    badge.textContent = (player.username || '?').trim().charAt(0).toUpperCase() || '?';
    badge.title = player.username;
    return badge;
  }

  function renderLeaderboard(listEl, players) {
    listEl.innerHTML = '';
    [...players]
      .sort((a, b) => b.chips - a.chips)
      .forEach((p) => {
        const li = document.createElement('li');
        if (p.connected === false) li.classList.add('disconnected');
        const left = document.createElement('span');
        left.className = 'roster-left';
        left.appendChild(renderPlayerBadge(p));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.username + (p.id === myId ? ' (you)' : '');
        left.appendChild(name);
        const chips = document.createElement('span');
        chips.className = 'chips';
        chips.textContent = `💰 ${p.chips}`;
        li.appendChild(left);
        li.appendChild(chips);
        listEl.appendChild(li);
      });
  }

  // Circle-avatar leaderboard used on the reveal screen, matching the
  // reference layout's row of player pills — separate from the row-list
  // renderLeaderboard() above, which the final screen keeps using.
  function renderLeaderboardPills(container, players) {
    container.innerHTML = '';
    [...players]
      .sort((a, b) => b.chips - a.chips)
      .forEach((p) => {
        const pill = document.createElement('div');
        pill.className = 'leaderboard-pill' + (p.connected === false ? ' disconnected' : '');
        pill.dataset.playerId = p.id;

        const circle = document.createElement('div');
        circle.className = 'pill-circle';
        circle.style.backgroundColor = p.color || '#999';
        circle.textContent = (p.username || '?').trim().charAt(0).toUpperCase() || '?';
        pill.appendChild(circle);

        const name = document.createElement('div');
        name.className = 'pill-name';
        name.textContent = p.username + (p.id === myId ? ' (you)' : '');
        pill.appendChild(name);

        const chips = document.createElement('div');
        chips.className = 'pill-chips';
        chips.textContent = `💰 ${p.chips}`;
        pill.appendChild(chips);

        container.appendChild(pill);
      });
  }

  function startTimer(endsAt) {
    clearInterval(timerInterval);
    const timerEl = document.getElementById('topbar-timer');
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      timerEl.textContent = remaining;
      timerEl.classList.toggle('low', remaining <= 8);
      if (remaining <= 0) clearInterval(timerInterval);
    };
    tick();
    timerInterval = setInterval(tick, 250);
  }

  function updateTopbar() {
    const phaseNames = { writing: 'Writing', betting: 'Betting', voting: 'Voting', reveal: 'Results', final: 'Results' };
    document.getElementById('topbar-phase').textContent = phaseNames[room.state] || '';
    document.getElementById('topbar-round-number').textContent = room.round.roundNumber;
    document.getElementById('topbar-total-rounds').textContent = room.totalRounds;
    const me = room.players.find((p) => p.id === myId);
    document.getElementById('topbar-chips').textContent = me ? me.chips : 0;

    document.querySelectorAll('.room-code-value').forEach((el) => {
      el.textContent = room.roomCode;
    });
    ['writing-emoji', 'betting-emoji', 'voting-emoji', 'reveal-emoji'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = room.round.emoji;
    });
  }

  // ---------- LOBBY ----------
  function renderLobby() {
    document.getElementById('lobby-room-code').textContent = room.roomCode;

    const list = document.getElementById('lobby-player-list');
    list.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      if (!p.connected) li.classList.add('disconnected');
      const left = document.createElement('span');
      left.className = 'roster-left';
      left.appendChild(renderPlayerBadge(p));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.username + (p.id === room.hostId ? ' (host)' : '');
      left.appendChild(name);

      const readyBadge = document.createElement('span');
      readyBadge.className = 'ready-badge ' + (p.ready ? 'is-ready' : 'is-waiting');
      readyBadge.textContent = p.ready ? '✅ Ready' : '⏳ Waiting';

      li.appendChild(left);
      li.appendChild(readyBadge);
      list.appendChild(li);
    });

    const isHost = room.hostId === myId;
    const me = room.players.find((p) => p.id === myId);
    const allReady = room.players.length > 0 && room.players.every((p) => !p.connected || p.ready);

    const readyBtn = document.getElementById('btn-toggle-ready');
    readyBtn.textContent = me && me.ready ? 'Cancel Ready' : '✅ Ready Up';

    const startBtn = document.getElementById('btn-start-game');
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !allReady;

    const waiting = document.getElementById('lobby-waiting');
    waiting.textContent = allReady
      ? (isHost ? 'Everyone is ready — start when you are!' : 'Waiting for the host to start the game…')
      : 'Waiting for everyone to be ready…';
  }

  document.getElementById('btn-toggle-ready').addEventListener('click', () => {
    const me = room.players.find((p) => p.id === myId);
    socket.emit('set_ready', { ready: !(me && me.ready) }, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('start_game', {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  document.getElementById('btn-copy-code').addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${room.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
    } catch (e) {
      toast(url);
    }
  });

  // ---------- WRITING ----------
  function renderWordChips(words) {
    const box = document.getElementById('writing-chips');
    box.innerHTML = '';
    words.forEach((w) => {
      const chip = document.createElement('span');
      chip.className = 'word-chip';
      const label = document.createElement('span');
      label.textContent = w.text;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        socket.emit('remove_word', { wordId: w.id }, (res) => {
          if (!res.ok) return toast(res.error);
          room.round.myDraft = res.draft;
          renderWriting();
        });
      });
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      box.appendChild(chip);
    });
  }

  function renderWriting() {
    document.getElementById('writing-emoji').textContent = room.round.emoji;
    document.getElementById('writing-max-words').textContent = room.maxWordsPerPlayer;
    const hints = room.round.hints || [];
    document.getElementById('writing-hint-text').textContent = hints.length ? `e.g. ${hints.join(', ')}…` : '';
    const draft = room.round.myDraft || [];
    renderWordChips(draft);
    const remaining = room.maxWordsPerPlayer - draft.length;
    document.getElementById('writing-input').disabled = remaining <= 0;
    document.querySelector('#writing-form button').disabled = remaining <= 0;
    document.getElementById('writing-feedback').textContent = '';

    const readyBtn = document.getElementById('btn-writing-ready');
    readyBtn.textContent = room.round.myReady ? 'Cancel Lock In' : '🔒 Lock In';
    document.getElementById('writing-ready-count').textContent = `${room.round.readyCount}/${room.round.totalConnected} locked in`;
  }

  document.getElementById('writing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('writing-input');
    const text = input.value;
    if (!text.trim()) return;
    socket.emit('submit_word', { text }, (res) => {
      const feedback = document.getElementById('writing-feedback');
      if (!res.ok) {
        feedback.textContent = res.error;
        return;
      }
      room.round.myDraft = res.draft;
      input.value = '';
      renderWriting();
      input.focus();
    });
  });

  document.getElementById('btn-writing-ready').addEventListener('click', () => {
    socket.emit('phase_ready', { phase: 'writing' }, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  // ---------- BETTING ----------
  function renderBetting() {
    const board = document.getElementById('betting-board');
    board.innerHTML = '';
    const myEntryIds = new Set(room.round.myEntryIds || []);
    const myBet = room.round.myBet;

    (room.round.entries || []).forEach((entry) => {
      const isMine = myEntryIds.has(entry.id);
      const card = document.createElement('div');
      card.className = 'entry-card' + (isMine ? ' mine' : '');

      const text = document.createElement('div');
      text.className = 'entry-text';
      text.textContent = entry.text;
      card.appendChild(text);

      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      const poolLabel = document.createElement('span');
      poolLabel.textContent = `💰 ${entry.pool} chips bet`;
      const oddsLabel = document.createElement('span');
      oddsLabel.className = 'entry-odds';
      oddsLabel.textContent = entry.odds ? `${entry.odds.toFixed(2)}x` : 'no bets yet';
      meta.appendChild(poolLabel);
      meta.appendChild(oddsLabel);
      card.appendChild(meta);

      if (isMine) {
        const note = document.createElement('div');
        note.className = 'hint';
        note.textContent = "This is your entry — you can't bet on it.";
        card.appendChild(note);
      } else {
        const actions = document.createElement('div');
        actions.className = 'entry-actions';
        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.min = room.minBet;
        amountInput.placeholder = `min ${room.minBet}`;
        amountInput.value = localBetDrafts[entry.id] || '';
        amountInput.addEventListener('input', () => {
          localBetDrafts[entry.id] = amountInput.value;
        });
        const betBtn = document.createElement('button');
        betBtn.type = 'button';
        betBtn.className = 'btn btn-primary btn-small';
        betBtn.textContent = 'Bet';
        betBtn.addEventListener('click', () => {
          const amount = Number(amountInput.value);
          if (!amount) return toast('Enter a chip amount first.');
          socket.emit('place_bet', { entryId: entry.id, amount }, (res) => {
            if (!res.ok) return toast(res.error);
            delete localBetDrafts[entry.id];
          });
        });
        actions.appendChild(amountInput);
        actions.appendChild(betBtn);
        card.appendChild(actions);

        if (myBet && myBet.entryId === entry.id) {
          const badge = document.createElement('div');
          badge.className = 'my-bet-badge';
          badge.textContent = `Your bet: ${myBet.amount} chips`;
          card.appendChild(badge);
        }
      }

      board.appendChild(card);
    });

    if (myBet) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn btn-secondary btn-small';
      clearBtn.textContent = 'Clear my bet';
      clearBtn.style.marginBottom = '10px';
      clearBtn.addEventListener('click', () => {
        socket.emit('place_bet', { entryId: myBet.entryId, amount: 0 }, (res) => {
          if (!res.ok) toast(res.error);
        });
      });
      board.insertBefore(clearBtn, board.firstChild);
    }

    const readyBtn = document.getElementById('btn-betting-ready');
    readyBtn.textContent = room.round.myReady ? 'Cancel Lock In' : '🔒 Lock In';
    document.getElementById('betting-ready-count').textContent = `${room.round.readyCount}/${room.round.totalConnected} locked in`;
  }

  document.getElementById('btn-betting-ready').addEventListener('click', () => {
    socket.emit('phase_ready', { phase: 'betting' }, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  // ---------- VOTING ----------
  // The whole card is the vote button (click anywhere on an entry to spend
  // a heart on it) — a small heart badge marks entries you've voted for, and
  // a shared row of hearts above the board tracks how many you have left.
  function renderHeartsRow(heartsLeft, totalHearts) {
    const row = document.getElementById('voting-hearts-row');
    row.innerHTML = '';
    for (let i = 0; i < totalHearts; i++) {
      const heart = document.createElement('span');
      heart.className = 'hearts-row-icon' + (i < heartsLeft ? '' : ' spent');
      heart.textContent = i < heartsLeft ? '❤️' : '🤍';
      row.appendChild(heart);
    }
  }

  function renderVoting() {
    const board = document.getElementById('voting-board');
    board.innerHTML = '';
    const myEntryIds = new Set(room.round.myEntryIds || []);
    const myVotes = new Set(room.round.myVotes || []);
    const heartsLeft = room.votesPerPlayer - myVotes.size;
    renderHeartsRow(heartsLeft, room.votesPerPlayer);

    (room.round.entries || []).forEach((entry) => {
      const isMine = myEntryIds.has(entry.id);
      const voted = myVotes.has(entry.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'entry-card entry-card-votable' + (isMine ? ' mine' : '') + (voted ? ' voted' : '');
      card.disabled = isMine || (!voted && heartsLeft <= 0);

      const text = document.createElement('div');
      text.className = 'entry-text';
      text.textContent = entry.text;
      card.appendChild(text);

      if (isMine) {
        const note = document.createElement('div');
        note.className = 'hint';
        note.textContent = "This is your entry — you can't vote for it.";
        card.appendChild(note);
      } else if (voted) {
        const badge = document.createElement('span');
        badge.className = 'vote-heart-badge';
        badge.textContent = '❤️';
        card.appendChild(badge);
      }

      if (!isMine) {
        card.addEventListener('click', () => {
          socket.emit('cast_vote', { entryId: entry.id }, (res) => {
            if (!res.ok) return toast(res.error);
            room.round.myVotes = res.myVotes;
            renderVoting();
          });
        });
      }

      board.appendChild(card);
    });

    const readyBtn = document.getElementById('btn-voting-ready');
    readyBtn.textContent = room.round.myReady ? 'Cancel Lock In' : '🔒 Lock In';
    document.getElementById('voting-ready-count').textContent = `${room.round.readyCount}/${room.round.totalConnected} locked in`;
  }

  document.getElementById('btn-voting-ready').addEventListener('click', () => {
    socket.emit('phase_ready', { phase: 'voting' }, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  // ---------- REVEAL ----------
  function renderRevealCurrent(results) {
    const box = document.getElementById('reveal-current');
    box.innerHTML = '';
    if (results.length === 0) {
      box.innerHTML = '<p class="reveal-placeholder">Nobody wrote anything this round!</p>';
      return;
    }
    if (revealIndex < 0) {
      const p = document.createElement('p');
      p.className = 'reveal-placeholder';
      p.textContent = `${results.length} word${results.length === 1 ? '' : 's'} up for vote. Tap "Reveal Next" to see how they did!`;
      box.appendChild(p);
      return;
    }

    const r = results[revealIndex];
    const word = document.createElement('div');
    word.className = 'reveal-word';
    word.textContent = r.text;
    if (r.isWinner) {
      const badge = document.createElement('span');
      badge.className = 'reveal-winner-badge';
      badge.textContent = '🏆 Winner';
      word.appendChild(badge);
    }
    box.appendChild(word);

    const authorNames = r.authors
      .map((a) => a.username + (a.id === myId ? ' (you)' : ''))
      .join(' & ');
    const author = document.createElement('div');
    author.className = 'reveal-line';
    author.textContent = `Written by ${authorNames}`;
    box.appendChild(author);

    const votesLine = document.createElement('div');
    votesLine.className = 'reveal-line';
    votesLine.textContent = `❤️ ${r.votes} vote${r.votes === 1 ? '' : 's'} · 💰 ${r.pool} chips bet`;
    box.appendChild(votesLine);

    if (r.authorBonus > 0) {
      const bonusLine = document.createElement('div');
      bonusLine.className = 'reveal-line';
      bonusLine.textContent = r.authors.length > 1
        ? `+${r.authorBonus} chips split between the authors`
        : `+${r.authorBonus} chips to the author`;
      box.appendChild(bonusLine);
    }
    if (r.payoutTotal > 0) {
      const payoutLine = document.createElement('div');
      payoutLine.className = 'reveal-line';
      payoutLine.textContent = `+${r.payoutTotal} chips paid out to backers`;
      box.appendChild(payoutLine);
    }
  }

  function renderReveal() {
    const results = (room.round && room.round.results) || [];
    document.getElementById('reveal-title').textContent =
      room.state === 'final' ? 'Final Round Results' : `Round ${room.round.roundNumber} Results`;
    renderRevealCurrent(results);
    renderLeaderboardPills(document.getElementById('reveal-leaderboard'), room.players);

    // Pop a small "+N" badge over whichever pill(s) just earned a bonus from
    // the entry currently on screen, echoing the reference layout's leaderboard bump.
    const current = revealIndex >= 0 ? results[revealIndex] : null;
    if (current && current.authorBonus > 0) {
      const share = Math.floor(current.authorBonus / current.authors.length);
      current.authors.forEach((author) => {
        const pill = document.querySelector(`.leaderboard-pill[data-player-id="${author.id}"]`);
        if (!pill || share <= 0) return;
        const badge = document.createElement('div');
        badge.className = 'pill-bonus-badge';
        badge.textContent = `+${share}`;
        pill.appendChild(badge);
      });
    }

    const isHost = room.hostId === myId;
    const allRevealed = revealIndex >= results.length - 1;

    document.getElementById('btn-reveal-next').classList.toggle('hidden', allRevealed);
    document.getElementById('btn-next-round').classList.toggle('hidden', room.state === 'final' || !isHost || !allRevealed);
    document.getElementById('btn-to-final').classList.toggle('hidden', room.state !== 'final' || !allRevealed);
    document.getElementById('reveal-waiting').classList.toggle('hidden', !allRevealed || isHost);
  }

  document.getElementById('btn-reveal-next').addEventListener('click', () => {
    const results = (room.round && room.round.results) || [];
    revealIndex = Math.min(results.length - 1, revealIndex + 1);
    renderReveal();
  });

  document.getElementById('btn-next-round').addEventListener('click', () => {
    socket.emit('next_round', {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  document.getElementById('btn-to-final').addEventListener('click', () => {
    viewingFinalLocally = true;
    showFinalScreen();
  });

  function showFinalScreen() {
    const finalPlayers = room.finalLeaderboard && room.finalLeaderboard.length ? room.finalLeaderboard : room.players;
    renderLeaderboard(document.getElementById('final-leaderboard'), finalPlayers);
    const isHost = room.hostId === myId;
    document.getElementById('btn-play-again').classList.toggle('hidden', !isHost);
    document.getElementById('final-waiting').classList.toggle('hidden', isHost);
    showScreen('final');
  }

  document.getElementById('btn-play-again').addEventListener('click', () => {
    viewingFinalLocally = false;
    socket.emit('play_again', {}, (res) => {
      if (!res.ok) toast(res.error);
    });
  });

  document.getElementById('btn-go-home').addEventListener('click', () => {
    socket.emit('leave_room', {}, () => {
      clearSession();
      room = null;
      showScreen('login');
      usernameInput.value = '';
      roomCodeInput.value = '';
    });
  });
})();
