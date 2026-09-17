// Two-player transport for the co-op versus mode.
//
// Judgement is deliberately *local*: both peers run the same expanded
// BeatScript, hear their own copy of the song and judge only the cues they own,
// so network latency never moves a hit window (the ROM windows are +-50/83 ms,
// far below an inter-city round trip).  The wire carries only control messages:
// the room plan, the agreed start time, one small result per cue and the final
// scores.
//
// Three interchangeable backends behind one interface:
//   loopback  - two peers inside one page, used by the local audit
//   broadcast - BroadcastChannel, two tabs of the same browser
//   webrtc    - manual invite/answer code exchange over a DataChannel (internet)
window.RhythmNet = (() => {
  const ICE_SERVERS = [
    // Chinese STUN servers first: Google's STUN is unreliable from the mainland.
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ];
  const encode = (value) => btoa(unescape(encodeURIComponent(JSON.stringify(value))));
  const decode = (value) => JSON.parse(decodeURIComponent(escape(atob(value.trim()))));

  function loopbackPair(onMessage) {
    const inbox = [];
    let pump = null;
    const peers = [0, 1].map((index) => ({
      index,
      send: (message) => { inbox.push({ to: 1 - index, message }); if (pump) pump(); },
      close: () => {},
      state: () => 'open'
    }));
    const flush = (handler) => {
      const pending = inbox.filter((entry) => entry.to === handler.index);
      for (const entry of pending) inbox.splice(inbox.indexOf(entry), 1);
      for (const entry of pending) handler.onMessage(entry.message);
    };
    peers.forEach((peer, index) => { peer.onMessage = (message) => onMessage(index, message); });
    pump = () => peers.forEach(flush);
    // Deliver asynchronously so a peer never re-enters its own handler.
    pump = () => setTimeout(() => peers.forEach(flush), 0);
    return peers;
  }

  function broadcastTransport(room, onMessage, onStatus) {
    const channel = new BroadcastChannel(`rhythm-versus-${room}`);
    const id = Math.random().toString(36).slice(2, 8);
    channel.onmessage = (event) => { if (event.data?.from !== id) onMessage(event.data.message, event.data.from); };
    onStatus({ state: 'open', detail: 'broadcast' });
    return {
      send: (message) => channel.postMessage({ from: id, message }),
      close: () => channel.close(),
      state: () => 'open'
    };
  }

  // Manual signalling: the host publishes one invite code (offer + its ICE
  // candidates) and the guest answers with one code.  No server participates, so
  // the page stays a static GitHub Pages build.
  function webrtcHost(room, onMessage, onStatus, iceServers) {
    const connection = new RTCPeerConnection({ iceServers: iceServers ?? ICE_SERVERS });
    let channel = null;
    const gather = new Promise((resolve) => {
      const candidates = [];
      connection.onicecandidate = (event) => { if (!event.candidate) resolve(candidates); else candidates.push(event.candidate.toJSON()); };
      setTimeout(() => resolve(candidates), 4000);
    });
    connection.ondatachannel = (event) => {
      channel = event.channel;
      channel.onmessage = (message) => onMessage(message.data);
      channel.onopen = () => onStatus({ state: 'open', detail: 'datachannel' });
      channel.onclose = () => onStatus({ state: 'closed', detail: 'datachannel' });
      channel.onerror = () => onStatus({ state: 'error', detail: 'datachannel' });
    };
    connection.onconnectionstatechange = () => onStatus({ state: connection.connectionState, detail: 'pc' });
    return {
      async createInvite() {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        const candidates = await gather;
        return encode({ room, sdp: connection.localDescription.sdp, candidates });
      },
      async acceptAnswer(code) {
        const answer = decode(code);
        if (answer.room && answer.room !== room) throw new Error('房间码不匹配');
        await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        for (const candidate of answer.candidates ?? []) await connection.addIceCandidate(candidate);
        onStatus({ state: 'connecting', detail: 'answer accepted' });
      },
      send: (message) => { if (channel?.readyState === 'open') channel.send(message); },
      close: () => connection.close(),
      state: () => connection.connectionState
    };
  }

  function webrtcGuest(room, onMessage, onStatus, iceServers) {
    const connection = new RTCPeerConnection({ iceServers: iceServers ?? ICE_SERVERS });
    const channel = connection.createDataChannel('versus', { ordered: true });
    const gather = () => new Promise((resolve) => {
      const candidates = [];
      connection.onicecandidate = (event) => { if (!event.candidate) resolve(candidates); else candidates.push(event.candidate.toJSON()); };
      setTimeout(() => resolve(candidates), 4000);
    });
    channel.onmessage = (message) => onMessage(message.data);
    channel.onopen = () => onStatus({ state: 'open', detail: 'datachannel' });
    channel.onclose = () => onStatus({ state: 'closed', detail: 'datachannel' });
    channel.onerror = () => onStatus({ state: 'error', detail: 'datachannel' });
    connection.onconnectionstatechange = () => onStatus({ state: connection.connectionState, detail: 'pc' });
    return {
      async answerTo(inviteCode) {
        const invite = decode(inviteCode);
        if (invite.room && invite.room !== room) throw new Error('房间码不匹配');
        await connection.setRemoteDescription({ type: 'offer', sdp: invite.sdp });
        for (const candidate of invite.candidates ?? []) await connection.addIceCandidate(candidate);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        const candidates = await gather();
        return encode({ room, sdp: connection.localDescription.sdp, candidates });
      },
      send: (message) => { if (channel.readyState === 'open') channel.send(message); },
      close: () => connection.close(),
      state: () => connection.connectionState
    };
  }

  return {
    ICE_SERVERS,
    loopbackPair,
    create({ kind, role, room, onMessage, onStatus, iceServers }) {
      if (kind === 'broadcast') return broadcastTransport(room, onMessage, onStatus);
      if (kind === 'webrtc') return role === 'host'
        ? webrtcHost(room, onMessage, onStatus, iceServers)
        : webrtcGuest(room, onMessage, onStatus, iceServers);
      throw new Error(`unknown transport ${kind}`);
    },
    encode,
    decode
  };
})();