// Turn-based two-player co-op ("双人联机") on top of the expanded BeatScripts.
//
// Design rules, all driven by what the decomp/ROM does:
//   * Only the active player judges: cues owned by the peer are never scored
//     locally, the peer reports its own result over the wire.  A hit window is
//     +-3/+-5 frames, so judging remotely would break under any real RTT.
//   * The turn plan is a pure function of the cue chart, so both peers derive
//     the identical plan without exchanging it (the host still sends a hash to
//     detect a mismatch).
//   * The hand-off countdown is beat locked: the number shown is derived from
//     the tick distance to the owner's first cue, not from a wall-clock timer,
//     so a dropped frame or a slow device cannot desync the prompt.
//   * "卡点" (co-op) cues must be pressed by both peers; each side judges its own
//     press and the two results are combined into one score entry.
window.RhythmVersus = (() => {
  const TICKS_PER_BEAT = 24;
  const BLOCK_CUES = 8;        // one player keeps the bat for eight pitches
  const LEAD_BEATS = 3;        // 3-2-1 prompt length before a hand-off
  const COOP_KINDS = ['CUE_HIGH'];
  const CLICK = 1046;

  const emptyScore = () => ({ perfect: 0, normal: 0, miss: 0, coop: 0, points: 0 });
  const addScore = (score, result) => {
    if (result === 'perfect') score.perfect++;
    else if (result === 'barely') score.normal++;
    else score.miss++;
    score.points = score.perfect * 100 + score.normal * 50;
  };

  // ---- turn plan -----------------------------------------------------------
  function buildPlan(cues, options = {}) {
    const blockCues = options.blockCues ?? BLOCK_CUES;
    const coopKinds = options.coopKinds ?? COOP_KINDS;
    const first = options.first ?? 'A';
    const blocks = [];
    for (let start = 0; start < cues.length; start += blockCues) {
      const until = Math.min(cues.length, start + blockCues) - 1;
      const owner = (blocks.length % 2 === 0) ? first : (first === 'A' ? 'B' : 'A');
      const coop = [];
      for (let index = start; index <= until; index++) if (coopKinds.includes(cues[index].kind)) coop.push(index);
      blocks.push({
        index: blocks.length, from: start, until, owner, coop,
        firstHit: cues[start].hit,
        switchTick: cues[start].hit - LEAD_BEATS * TICKS_PER_BEAT
      });
    }
    const perCue = cues.map((_, index) => {
      const block = blocks.find((item) => index >= item.from && index <= item.until);
      return block.coop.includes(index) ? 'both' : block.owner;
    });
    return {
      blocks, perCue,
      coopIndices: perCue.map((owner, index) => (owner === 'both' ? index : -1)).filter((index) => index >= 0),
      hash: `${cues.length}:${blocks.map((block) => `${block.owner}${block.coop.length}`).join('')}`
    };
  }

  function blockAtTick(plan, tick) {
    for (const block of plan.blocks) {
      if (tick < block.switchTick) return null;
      const next = plan.blocks[block.index + 1];
      if (!next || tick < next.switchTick) return block;
    }
    return plan.blocks.at(-1);
  }

  // Beat-locked prompt: 3 / 2 / 1 during the lead-in, then the owner is live.
  function countdownFor(plan, tick) {
    const block = blockAtTick(plan, tick);
    if (!block) return null;
    const remaining = (block.firstHit - tick) / TICKS_PER_BEAT;
    if (remaining <= 0) return { block, label: block.owner, step: 0, text: '开始' };
    const step = Math.min(LEAD_BEATS, Math.ceil(remaining));
    return { block, label: block.owner, step, text: String(step) };
  }

  // ---- live session --------------------------------------------------------
  function createSession(options) {
    const session = {
      role: options.role, self: options.role === 'host' ? 'A' : 'B', peer: options.role === 'host' ? 'B' : 'A',
      kind: options.kind ?? 'broadcast', room: options.room ?? 'RHYTHM', level: options.level ?? 'spaceball',
      cues: options.cues ?? [], plan: null, transport: options.transport ?? null,
      status: 'idle', detail: '', rtt: 0, offset: 0, trim: 0,
      connected: false, started: false, startTick: 0, localStart: 0, hostStart: 0,
      scores: { A: emptyScore(), B: emptyScore() },
      coopState: new Map(), peerResults: new Map(), localResults: new Map(),
      countdownShown: null, log: [], listeners: options.listeners ?? {},
      hooks: options.hooks ?? {}
    };
    if (session.transport) wire(session);
    return session;
  }

  function wire(session) {
    const transport = session.transport;
    transport.onMessage = (message) => receive(session, message);
    session.send = (message) => transport.send(message);
  }

  function emit(session, type, detail) {
    session.log.push({ type, detail });
    session.listeners.onStatus?.({ status: session.status, detail: session.detail, rtt: session.rtt, offset: session.offset, connected: session.connected });
  }

  function receive(session, message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'hello':
        session.connected = true; session.status = 'connected'; session.detail = `${message.name ?? '对手'} 已加入`;
        emit(session, 'hello', message.planHash);
        if (session.role === 'host' && session.plan) session.send({ type: 'plan', hash: session.plan.hash, level: session.level });
        break;
      case 'plan':
        session.connected = true; session.status = 'connected';
        if (message.hash !== session.plan?.hash) {
          session.status = 'mismatch'; session.detail = `关卡/分轮方案不一致 (${message.hash} ≠ ${session.plan?.hash})`;
        } else session.detail = '方案一致，等待开始';
        emit(session, 'plan', message.hash);
        break;
      case 'ping': session.send({ type: 'pong', t0: message.t0, t1: session.hooks.audio?.() ?? 0 }); break;
      case 'pong': {
        const t3 = session.hooks.audio?.() ?? 0;
        const rtt = t3 - message.t0;
        const offset = message.t1 - (message.t0 + t3) / 2;
        // Keep the estimate from the least delayed round trip (NTP-style min filter).
        if (!session.rtt || rtt <= session.rtt) { session.rtt = rtt; session.offset = offset; }
        emit(session, 'pong', `${(rtt * 1000).toFixed(0)}ms`);
        break;
      }
      case 'start':
        session.hostStart = message.start;
        startLocal(session);
        break;
      case 'cue':
        applyPeerResult(session, message.index, message.result, message.offset);
        break;
      case 'score':
        session.scores[session.peer] = { ...emptyScore(), ...message.score };
        emit(session, 'score', JSON.stringify(message.score));
        break;
      case 'bye':
        session.connected = false; session.status = 'closed'; session.detail = '对手已离开';
        emit(session, 'bye', '');
        break;
      default: break;
    }
  }

  function attachTransport(session, transport) { session.transport = transport; wire(session); }

  async function hostRoom(session) {
    session.plan = buildPlan(session.cues);
    session.transport = window.RhythmNet.create({
      kind: session.kind, role: 'host', room: session.room,
      onMessage: (message) => receive(session, message),
      onStatus: (status) => { session.status = status.state; session.detail = status.detail; emit(session, 'transport', status.detail); }
    });
    session.status = 'waiting';
    if (session.kind === 'webrtc') return session.transport.createInvite();
    session.send({ type: 'hello', name: session.self, planHash: session.plan.hash });
    return null;
  }

  // The guest opens its data channel first and only then pastes the host's
  // invite code, so the manual signalling flow is two visible steps.
  function prepareGuest(session) {
    session.plan = buildPlan(session.cues);
    session.transport = window.RhythmNet.create({
      kind: session.kind, role: 'guest', room: session.room,
      onMessage: (message) => receive(session, message),
      onStatus: (status) => { session.status = status.state; session.detail = status.detail; emit(session, 'transport', status.detail); }
    });
    session.status = 'connecting';
    if (session.kind !== 'webrtc') session.send({ type: 'hello', name: session.self, planHash: session.plan.hash });
    return session.transport;
  }
  async function joinRoom(session, inviteCode) {
    session.plan = buildPlan(session.cues);
    session.transport = window.RhythmNet.create({
      kind: session.kind, role: 'guest', room: session.room,
      onMessage: (message) => receive(session, message),
      onStatus: (status) => { session.status = status.state; session.detail = status.detail; emit(session, 'transport', status.detail); }
    });
    session.status = 'connecting';
    if (session.kind === 'webrtc') return session.transport.answerTo(inviteCode);
    session.send({ type: 'hello', name: session.self, planHash: session.plan.hash });
    return null;
  }

  function acceptAnswer(session, code) { return session.transport.acceptAnswer(code); }

  function startLocal(session) {
    // The peer hears the song at hostStart on the host clock; convert it into
    // this client's audio clock (offset = peerClock - myClock is measured the
    // other way round for the guest, hence the sign flip).
    const now = session.hooks.audio?.() ?? 0;
    const mapped = session.role === 'host' ? session.hostStart : session.hostStart - session.offset + session.trim / 1000;
    session.localStart = Math.max(now + .05, mapped);
    session.started = true; session.status = 'playing'; session.detail = '进行中';
    session.hooks.setSongStart?.(session.localStart);
    emit(session, 'start', session.localStart.toFixed(3));
  }

  function start(session) {
    const now = session.hooks.audio?.() ?? 0;
    session.hostStart = now + 4.0;   // four seconds of "get ready"
    session.send({ type: 'start', start: session.hostStart });
    startLocal(session);
  }

  function ownerOf(session, index) { return session.plan?.perCue[index] ?? 'A'; }
  // "同一个按键 + 谁轮到谁按": a press is only dispatched while the local player
  // owns the running block, except on a co-op cue, which both peers must press.
  function acceptsInput(session, tick, index) {
    if (!session.started) return false;
    if (index != null && ownerOf(session, index) === 'both') return true;
    const block = blockAtTick(session.plan, tick);
    return Boolean(block) && block.owner === session.self;
  }
  function isLocalCue(session, index) { return ownerOf(session, index) === session.self || ownerOf(session, index) === 'both'; }

  // ---- results -------------------------------------------------------------
  function recordLocal(session, index, result, offset = 0) {
    session.localResults.set(index, result);
    if (!isLocalCue(session, index)) return result;      // the peer owns this cue
    if (ownerOf(session, index) === 'both') {
      session.coopState.set(index, { ...(session.coopState.get(index) ?? {}), [session.self]: result });
      return combineCoop(session, index);
    }
    addScore(session.scores[session.self], result);
    session.send({ type: 'cue', index, result, offset });
    return result;
  }

  function applyPeerResult(session, index, result, offset = 0) {
    session.peerResults.set(index, result);
    if (ownerOf(session, index) === 'both') { combineCoop(session, index); return; }
    addScore(session.scores[session.peer], result);
    // The offset travels with the result so the peer's copy of the cue animates
    // exactly like the player who pressed it (a barely hit drifts the same way).
    session.listeners.onPeerCue?.(index, result, offset);
  }

  function combineCoop(session, index) {
    const state = session.coopState.get(index);
    if (!state?.[session.self] || !state?.[session.peer]) return null;
    const rank = { miss: 0, barely: 1, perfect: 2 };
    const combined = rank[state[session.self]] <= rank[state[session.peer]] ? state[session.self] : state[session.peer];
    for (const player of ['A', 'B']) addScore(session.scores[player], combined);
    if (combined !== 'miss') session.scores.A.coop = session.scores.B.coop = session.scores.A.coop + 1;
    session.coopState.set(index, { ...state, combined });
    session.listeners.onCoop?.(index, state, combined);
    return combined;
  }

  // ---- drawing -------------------------------------------------------------
  function drawUpper(session, ctx, tick, width, height) {
    if (!session.started) return;
    const prompt = countdownFor(session.plan, tick);
    if (!prompt) return;
    const live = prompt.step === 0;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = live ? 'rgba(0,0,0,.42)' : 'rgba(0,0,0,.55)';
    const boxW = live ? 360 : 300, boxH = live ? 96 : 200;
    ctx.fillRect(width / 2 - boxW / 2, 24, boxW, boxH);
    ctx.strokeStyle = prompt.label === session.self ? '#7ef0a0' : '#ffd166';
    ctx.lineWidth = 4; ctx.strokeRect(width / 2 - boxW / 2, 24, boxW, boxH);
    ctx.fillStyle = prompt.label === session.self ? '#7ef0a0' : '#ffd166';
    ctx.font = '700 34px sans-serif';
    ctx.fillText(live ? `第 ${prompt.block.index + 1} 段 · ${prompt.label} 操作` : `轮到 ${prompt.label}`, width / 2, 64);
    if (!live) {
      ctx.fillStyle = '#fff'; ctx.font = '800 120px sans-serif';
      ctx.fillText(prompt.text, width / 2, 200);
      if (prompt.block.coop.length) {
        ctx.fillStyle = '#ff8fa3'; ctx.font = '600 24px sans-serif';
        ctx.fillText(`本段含 ${prompt.block.coop.length} 个双人卡点`, width / 2, 232);
      }
    }
    ctx.restore();
  }

  function drawLower(session, ctx, tick, width, height) {
    const live = countdownFor(session.plan, tick);
    const owner = live?.label ?? '-';
    ctx.save();
    ctx.fillStyle = 'rgba(6,8,14,.86)'; ctx.fillRect(24, 96, width - 48, 300);
    ctx.strokeStyle = owner === session.self ? '#7ef0a0' : '#ffd166'; ctx.lineWidth = 4;
    ctx.strokeRect(24, 96, width - 48, 300);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cfd6e6'; ctx.font = '600 26px sans-serif';
    ctx.fillText(session.connected ? `已连接 · ${(session.rtt * 1000).toFixed(0)}ms` : `未连接 (${session.status})`, width / 2, 138);
    ctx.fillStyle = owner === session.self ? '#7ef0a0' : '#ffd166'; ctx.font = '800 56px sans-serif';
    ctx.fillText(live ? (live.step ? `轮到 ${owner}  ${live.text}` : `${owner} 操作中`) : '等待开始', width / 2, 216);
    ctx.fillStyle = '#cfd6e6'; ctx.font = '600 24px sans-serif';
    ctx.fillText(session.self === 'A' ? '你是 A' : '你是 B', width / 2, 254);
    const coop = session.plan ? session.plan.coopIndices.filter((index) => session.coopState.get(index)?.combined !== undefined).length : 0;
    const coopTotal = session.plan?.coopIndices.length ?? 0;
    ctx.fillText(`双人卡点 ${coop}/${coopTotal}`, width / 2, 292);
    ctx.textAlign = 'left'; ctx.fillStyle = '#9fb0c8'; ctx.font = '600 22px sans-serif';
    const mine = session.scores[session.self], theirs = session.scores[session.peer];
    ctx.fillText(`我  ${mine.perfect}/${mine.normal}/${mine.miss}  ${mine.points}分`, 60, 344);
    ctx.fillText(`对手 ${theirs.perfect}/${theirs.normal}/${theirs.miss}  ${theirs.points}分`, 60, 376);
    ctx.restore();
  }

  function drawResult(session, ctx, width, height) {
    const mine = session.scores[session.self], theirs = session.scores[session.peer];
    ctx.save();
    ctx.fillStyle = 'rgba(4,6,12,.88)'; ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '800 56px sans-serif';
    const verdict = mine.points === theirs.points ? '平局' : (mine.points > theirs.points ? '你赢了' : '对手赢了');
    ctx.fillText(verdict, width / 2, 150);
    ctx.font = '700 34px sans-serif'; ctx.fillStyle = mine.points >= theirs.points ? '#7ef0a0' : '#ffd166';
    ctx.fillText(`我 ${mine.points} 分`, width / 2 - 150, 240);
    ctx.fillStyle = theirs.points > mine.points ? '#7ef0a0' : '#ffd166';
    ctx.fillText(`对手 ${theirs.points} 分`, width / 2 + 150, 240);
    ctx.fillStyle = '#cfd6e6'; ctx.font = '600 26px sans-serif';
    ctx.fillText(`Perfect ${mine.perfect} · Barely ${mine.normal} · Miss ${mine.miss}`, width / 2, 310);
    ctx.fillText(`双人卡点成功 ${mine.coop}/${session.plan.coopIndices.length}`, width / 2, 352);
    ctx.fillText('点击任意处返回菜单', width / 2, 430);
    ctx.restore();
  }

  // ---- countdown clicks ----------------------------------------------------
  function update(session, tick) {
    if (!session.started) return;
    const prompt = countdownFor(session.plan, tick);
    const key = prompt ? `${prompt.block.index}:${prompt.step}` : null;
    if (key && key !== session.countdownShown) {
      session.countdownShown = key;
      if (prompt.step) session.hooks.tone?.(CLICK, .07, 'square', .06);
      else session.hooks.tone?.(CLICK * 1.5, .12, 'square', .07);
      session.listeners.onPrompt?.(prompt);
    }
  }

  return {
    TICKS_PER_BEAT, BLOCK_CUES, LEAD_BEATS, COOP_KINDS,
    buildPlan, blockAtTick, countdownFor,
    createSession, attachTransport, hostRoom, joinRoom, prepareGuest, acceptAnswer, start, startLocal,
    acceptsInput, isLocalCue, recordLocal, applyPeerResult, ownerOf,
    drawUpper, drawLower, drawResult, update, emptyScore
  };
})();