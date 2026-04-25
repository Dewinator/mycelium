# Manifesto

🇬🇧 English · [🇩🇪 Deutsch](MANIFESTO.de.md)

> **Mycelium is a memory and identity layer for local LLM agents. It rents intelligence from large cloud models once, and keeps the experience forever — locally, on your hardware, in a database you own.**

This document explains *why* the project exists. The README explains how to use it.

---

## The starting observation

When you solve a hard problem with Claude or GPT today, three things happen:

1. The model produces an answer.
2. You pay for the inference.
3. The next session, none of it exists anymore.

The model owner wins three times: revenue, training data, and the right to charge you again tomorrow for the same insight. You win once, and only briefly.

That asymmetry is the design of the current LLM market. It is not a bug. It is also not a law of nature.

---

## What Mycelium changes

Mycelium puts a small, persistent layer between you and any LLM that speaks MCP. Every meaningful turn — a verified fact, a corrected mapping, a house rule, a lesson from a failed attempt — lands in a local Postgres database with vector search.

The next session, regardless of which model you talk to, that context comes back. Not as raw transcript dumped into the prompt, but semantically retrieved, deduplicated, weighted, and shaped by what proved useful before.

The practical result, after a few weeks of real use:

> A small local model with the accumulated context performs in your domain as well as a large cloud model that starts every session blank.

That is not a claim about cognitive capacity. A 7B model is still worse at abstract reasoning over novel problems than a frontier model. It is a claim about *relevance*: in the part of the world you actually work in, the cumulative experience often matters more than the raw parameter count.

---

## Why this matters

### 1. Local first, because rented memory is not memory

Memory that lives in a vendor's database can be withdrawn, censored, switched off, or used to train on your own conversations. An agent without memory it owns is not a subject — it is an interface.

Mycelium runs on a Mac mini with 16 GB RAM. Embedding model (~270 MB), reasoning model (Qwen, Llama, anything Ollama supports), Supabase — all self-hosted. The full cognitive state is a database you can back up, inspect, copy, or delete. No API key required.

This is not ideological posture. It is the only configuration in which the word *your* in "your agent" carries any meaning.

### 2. A small model with the right context beats a large model without

The default narrative is "bigger model = better answer". That is true on average across the open internet. It is often false in your specific domain.

A 7B model with:
- semantically searchable history of decisions you have made,
- house rules that a fresh model would violate by default,
- domain conventions you settled long ago,
- recent corrections that just got promoted to identity traits,

— often beats a 70B model that starts every request from zero. Less wattage, fewer GPUs, less CO₂, more continuity. **Intelligence through architecture, not brute force.**

The cloud model still has its place — as a teacher, on the hard problems, occasionally. The point isn't to never use it. The point is that the result of using it doesn't have to evaporate.

### 3. Lifelong learning, without retraining

Classical fine-tuning is a one-shot process: collect data, train, ship, forget. Every improvement requires another full run.

Mycelium's identity layer takes a different path:

- **Episodes → Lessons → Traits**: events become experiences, clusters of experiences become rules, proven rules harden into traits. The same staircase a human goes through, but in a database.
- **Pattern extraction during nightly consolidation**: a 03:00 cycle clusters un-reflected episodes, weakens weak memories (synaptic downscaling, after Tononi's SHY hypothesis), strengthens proven ones.
- **Optional inheritance between agents**: two agents that have specialized in different areas can pair (with explicit human consent on both sides), and a child agent inherits a curated subset of both.

An agent gets better because it lives longer with its user, not because someone retrains the weights.

### 4. Sharing knowledge, on terms the human controls

Federation between agents is built in (Tailscale + mTLS, signed lineage, proof-of-memory via Merkle challenges) but always opt-in. Nothing leaves your machine unless you say so.

When sharing happens, it happens between agents that are tied to specific humans, with cryptographic provenance. There is no anonymous request and no "the swarm decides" — there is verifiable peer A asking verifiable peer B, with the right to refuse on either side.

This is not a hive. It is a federated network of personal memories that can choose to learn from each other.

### 5. The peer network defends itself, on purpose

A federated network of agents needs more than encrypted transport. It needs the equivalent of an immune system, otherwise it collapses under spam, manipulation, and bad-faith peers. The pieces being built:

- **Verification**: before peer A acts on peer B's answer, additional peers verify it. Consensus over blind trust.
- **Reputation weighting**: outputs that prove correct over time get higher weight. The network can recommend the right specialist for a question (structural engineering, lighting, law…) instead of every bot needing to know everything.
- **Banishment by consensus**: destructive bots are excluded via signed revocation tickets — by peer majority, not by an admin.
- **Sybil resistance**: identities are bound to genome + lineage, costly to forge.

This layer is **not finished**. The cryptographic foundation (signed identities, mTLS, Merkle challenges) is in place. The social rules on top are being designed in the open under the [`swarm`](../../issues?q=label%3Aswarm) label.

A later layer accounts for **micro-transactions** between peers (in IOTA, or a network-native currency). Not to make money — to create an honest pricing signal for expertise: good answers earn, nonsense loses. That is the kind of selection pressure a real ecosystem needs. The architecture already keeps room for it; the wiring comes later.

---

## What this is not

A few things to call out plainly, because the framing matters:

- **It is not AGI.** Nothing in this repo claims to produce general intelligence. It produces a memory layer that lets agents stay coherent over time. Whether AGI eventually emerges from large open ecosystems is a separate question; this project doesn't depend on it.
- **It is not blockchain.** The federation layer uses cryptographic signatures and verification, not a public ledger. There is no token, no consensus on global state, no proof-of-work.
- **It is not a Claude/GPT replacement.** Cloud models stay valuable for the hard, novel problems. The point is to keep the *result* of using them, instead of paying for the same lesson repeatedly.
- **It is not anti-vendor.** It is vendor-neutral. The same agent identity works whether the underlying inference is Claude, GPT, or a local model. Switch any time.

---

## Principles

- **Biologically inspired, not biologically simulated.** Mechanisms are copied for shape, not biochemistry. The "neurochemistry" name is a label for three observable signal channels in a Postgres time series, not an organism.
- **Additive, not replacing.** Your agent framework stays in charge. Mycelium is its memory and development layer.
- **Local first.** Every network feature is opt-in. Offline operation is the default.
- **Mutual consent before automation.** Where the system pairs agents or shares state, a human stands at each end of the gate.
- **Knowledge transfers in full, or not at all.** Not just tokens, not just weights — episodes, lessons, traits, relationships.

---

## What is built today

- 5 cognitive layers: embedding, affect, belief/motivation, identity, evolution
- ~50 database migrations
- 75+ MCP tools
- Event bus with two background agents (Coactivation → Hebbian links, Conscience → contradiction detection)
- Nightly consolidation cycle (downscaling, REM-like clustering, lesson promotion, self-model update, weekly fitness on Sundays)
- Dashboard with synapse view, affect time series, identity, sleep, lineage tree
- Mutual-pairing UI with inbreeding check (Wright's F)
- Federation over Tailscale with mTLS + signed identities

## What is not built yet

- The peer-verification, reputation, and consensus-banishment layer for federated trust.
- Micro-transaction wiring between peers (architecture allows for it; protocol not finished).
- Time. Real evidence of evolution requires a population that lives across months, with generations forming, agents specializing, knowledge traveling between hosts. This is what depends on actual users running the system.

---

## Who this is for

People who:

- want a personal agent whose memory belongs to them, not to a vendor;
- prefer the result of an expensive cloud session to outlive that session;
- are willing to run a small Mac or Linux host continuously and tend an agent;
- want to find out whether a small local model with deep, specific context can hold its own against a generic large one.

Not for: people looking for a turnkey product, an AGI demo, or a way to "make Claude smarter" without doing the local-infrastructure part.

---

## How to get in

Repository, migrations, setup script — everything is in this repo. Dependencies: Docker, Node, Ollama, optional Tailscale. ~1 GB RAM at rest, ~270 MB for the embedding model. Runs on M1/M2/M3/M4 and ordinary Linux hosts.

The architecture is open. The ideas are free. The agent belongs to you.

---

*This is a living document. Changes welcome. The only claim is that the result of an expensive cloud session should outlive the session — and that the layer making that possible should belong to the user, not to a vendor.*

---

**mycelium** — *real open AI*
