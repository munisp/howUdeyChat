# Signal Protocol vs Matrix — and why howUdeyChat rides Matrix

| | Signal Protocol | Matrix |
|---|---|---|
| **What it is** | An E2EE *protocol* (double ratchet) + a centralized service run by one US nonprofit | An open *federated* protocol (client-server + server-server) with E2EE (Olm/Megolm) layered on top |
| **Who controls the network** | Signal Messenger LLC, exclusively. No federation, no self-hosting the network, phone-number identity locked to their directory | Anyone. Self-host a homeserver; federation links operators peer-to-peer. Identity is `@user:yourdomain` |
| **E2EE default** | Always on, best-in-class (double ratchet, sealed sender) | Per-room; Megolm group sessions, device verification |
| **Server sees** | Almost nothing (sealed sender hides metadata) | Metadata (who talks when); content hidden in E2EE rooms |
| **Offline/intermittent** | Queue at Signal's servers | Queue at *your* server — or your LAN relay with zero internet |
| **Extensibility** | Fixed feature set, no bots/automation surface | Open event model — health artifacts, bots, bridges are first-class |
| **Geopolitical exposure** | A single US entity that can be pressured, sanctioned, or blocked (and has been, in several countries) | No single point of foreign control; blocking one homeserver doesn't touch another |

## The verdict for this project

Signal's *cryptography* is the gold standard — and its *governance* is the
exact failure mode howUdeyChat exists to escape: one foreign organization
holds the network, the identity directory, and the kill switch. A ministry
cannot self-host Signal, cannot integrate it with a clinic gateway, cannot
audit where patient metadata flows, and cannot keep it running if it is
banned or pressured.

Matrix gives us: self-hosting, federation between states/NGOs without a
central operator, an open event model for health artifacts, and E2EE we
control (ADR-0005). What we consciously give up is Signal's sealed-sender
metadata protection — acceptable because the metadata lives on the
operator's own sovereign server, not a foreign one.

The phase-2 E2EE design (ADR-0005) is Megolm-shaped precisely so the
audited cryptographic composition (vodozemac, MIT/Apache-2.0) can land
without changing the client architecture.
