// group-calls.js — group voice/video for howUdeyChat (phase 3).
//
// 1:1 calls (calls.js) mesh fine at two parties; a care-team consult with a
// doctor, nurse, patient, and interpreter cannot mesh — upload bandwidth at
// the clinic is the bottleneck. So group calls route media through an SFU
// (Selective Forwarding Unit): one upload per participant, the SFU fans out.
//
// Architecture (MSC3401-shaped):
// - The ROOM is the call. Participants publish m.call.member state events
//   declaring they're in the call and which focus (SFU) they use.
// - Focus selection is deterministic: lowest userId member's preferred focus
//   wins — no leader election race on a flaky link.
// - The SFU itself is an injected seam (FocusFactory) — LiveKit (Apache-2.0)
//   self-hosted by the operator is the reference; tests inject a fake.
// - Media between client and SFU is DTLS-SRTP (WebRTC native); the SFU is
//   the honest trust boundary, documented in SECURITY.md.

export class GroupCallManager {
  // focusFactory: { create(focusInfo, rtcConfig) => FocusConnection }
  constructor({ client, focusFactory, turnServers = [] }) {
    this.client = client;
    this.focusFactory = focusFactory;
    this.turn = turnServers;
    this.active = null;         // GroupCallSession
    this.onIncoming = null;     // (session) => void — someone started a call in a room
    this.onMemberState = null;
    client.onStateEvent = (roomId, ev) => this._onState(roomId, ev);
  }

  async join(roomId, focusInfo = { type: "livekit", url: "" }) {
    if (this.active) throw new Error("already in a group call");
    const s = new GroupCallSession(this, roomId, focusInfo);
    this.active = s;
    await s._join();
    return s;
  }

  async _onState(roomId, ev) {
    if (ev.type !== "m.call.member") return;
    const members = Object.keys(ev.content?.memberships || {});
    if (members.length && !this.active && this.onIncoming) {
      this.onIncoming({ roomId, members, join: (focus) => this.join(roomId, focus) });
    }
    if (this.active && this.active.roomId === roomId) {
      this.active._updateMembers(ev.content.memberships || {});
    }
    if (this.onMemberState) this.onMemberState(roomId, members);
  }
}

export class GroupCallSession {
  constructor(mgr, roomId, focusInfo) {
    this.mgr = mgr;
    this.roomId = roomId;
    this.focusInfo = focusInfo;
    this.callId = `huc-gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state = "idle";
    this.members = new Map();   // userId -> { focus, joinedAt }
    this.focus = null;          // FocusConnection to the SFU
    this.onState = null;
    this.onMembers = null;
  }

  _set(s) { this.state = s; if (this.onState) this.onState(s); }

  async _join() {
    this._set("joining");
    // 1. connect to the SFU
    this.focus = await this.mgr.focusFactory.create(this.focusInfo, {
      iceServers: this.mgr.turn.length ? this.mgr.turn : [{ urls: "stun:stun.l.google.com:19302" }],
    });
    // 2. publish membership state so others see (and join) the call
    await this._publishMembership();
    this._set("active");
  }

  async _publishMembership() {
    const userId = this.mgr.client.userId;
    await this.mgr.client.sendStateEvent(this.roomId, "m.call.member", {
      memberships: {
        [userId]: {
          call_id: this.callId,
          focus: this.focusInfo,
          joined_at: Date.now(),
        },
      },
    }, userId);
  }

  _updateMembers(memberships) {
    const before = this.members.size;
    this.members = new Map(Object.entries(memberships));
    if (this.members.size === 0) {
      // everyone left — including us, if state echoed after leave
      this._set("ended");
      if (this.mgr.active === this) this.mgr.active = null;
      return;
    }
    if (this.onMembers && this.members.size !== before) {
      this.onMembers([...this.members.keys()]);
    }
  }

  // deterministic focus agreement: every participant independently picks
  // the focus of the lexicographically-lowest member — same answer everywhere
  agreedFocus() {
    const ids = [...this.members.keys()].sort();
    if (!ids.length) return this.focusInfo;
    return this.members.get(ids[0]).focus || this.focusInfo;
  }

  async leave() {
    this._set("left");
    try {
      await this.mgr.client.sendStateEvent(this.roomId, "m.call.member",
        { memberships: {} }, this.mgr.client.userId);
    } finally {
      this.focus?.close?.();
      if (this.mgr.active === this) this.mgr.active = null;
    }
  }
}
