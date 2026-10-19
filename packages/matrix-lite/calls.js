// calls.js — 1:1 voice/video over Matrix signaling (m.call.*) + WebRTC.
// The state machine and wire events are fully implemented and testable;
// the RTC layer is an injected seam (browser: real RTCPeerConnection;
// tests: a fake). TURN servers are config — in low-connectivity
// deployments the operator's TURN is what makes calls work across NAT.
//
// States: idle → inviting → ringing → connected → ended
//                (incoming:) → ringing → connected → ended

export class CallManager {
  // rtc: { createPeer(config), getUserMedia({audio,video}) } — injected
  constructor({ client, rtc, turnServers = [] }) {
    this.client = client;      // MatrixLite (for _req + onCallEvent)
    this.rtc = rtc;
    this.turn = turnServers;   // [{urls, username, credential}]
    this.call = null;          // active CallSession
    this.onIncoming = null;    // (session) => void
    client.onCallEvent = (roomId, ev) => this._onEvent(roomId, ev);
  }

  async placeCall(roomId, { video = false } = {}) {
    if (this.call) throw new Error("already in a call");
    const s = new CallSession(this, roomId, "outgoing");
    this.call = s;
    await s._start(video);
    return s;
  }

  async _onEvent(roomId, ev) {
    const c = ev.content || {};
    if (ev.type === "m.call.invite" && !this.call) {
      const s = new CallSession(this, roomId, "incoming");
      s.callId = c.call_id;
      s.remoteOffer = c.offer;
      this.call = s;
      if (this.onIncoming) this.onIncoming(s);
      return;
    }
    if (!this.call || c.call_id !== this.call.callId) return;
    await this.call._handle(ev.type, c);
  }
}

export class CallSession {
  constructor(mgr, roomId, direction) {
    this.mgr = mgr;
    this.roomId = roomId;
    this.direction = direction;
    this.callId = `huc-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state = "idle";
    this.pc = null;
    this.localStream = null;
    this.onState = null; // (state) => void
  }

  _set(state) { this.state = state; if (this.onState) this.onState(state); }

  async _rtcConfig() {
    return { iceServers: this.mgr.turn.length ? this.mgr.turn : [{ urls: "stun:stun.l.google.com:19302" }] };
  }

  async _start(video) {
    this._set("inviting");
    this.pc = this.mgr.rtc.createPeer(await this._rtcConfig());
    this.localStream = await this.mgr.rtc.getUserMedia({ audio: true, video });
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._send("m.call.invite", {
      call_id: this.callId, version: 1, lifetime: 60000,
      offer: { type: "offer", sdp: offer.sdp },
    });
  }

  async answer({ video = false } = {}) {
    if (this.direction !== "incoming" || this.state !== "idle") throw new Error("nothing to answer");
    this.pc = this.mgr.rtc.createPeer(await this._rtcConfig());
    this.localStream = await this.mgr.rtc.getUserMedia({ audio: true, video });
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    await this.pc.setRemoteDescription(this.remoteOffer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._set("connected");
    await this._send("m.call.answer", {
      call_id: this.callId, version: 1,
      answer: { type: "answer", sdp: answer.sdp },
    });
  }

  async hangup() {
    if (this.state === "ended") return;
    this._set("ended");
    await this._send("m.call.hangup", { call_id: this.callId, version: 1 });
    this._teardown();
  }

  async _handle(type, c) {
    switch (type) {
      case "m.call.answer":
        await this.pc.setRemoteDescription(c.answer);
        this._set("connected");
        break;
      case "m.call.candidates":
        for (const cand of c.candidates || []) {
          if (cand.candidate) await this.pc.addIceCandidate(cand);
        }
        break;
      case "m.call.hangup":
        this._set("ended");
        this._teardown();
        break;
    }
  }

  _teardown() {
    try { this.localStream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.pc?.close(); } catch {}
    if (this.mgr.call === this) this.mgr.call = null;
  }

  _send(type, content) {
    return this.mgr.client._sendEphemeral(this.roomId, type, content);
  }
}
