# Moria

Anonymous, end-to-end encrypted, ephemeral chat rooms. 
No accounts. No logs. No metadata.

Nothing is stored, nothing survives. 

https://moria.chat
License: [AGPL-3.0](LICENSE)

## Architecture

- **Live chat**: WebRTC peer-to-peer via Trystero (Nostr signaling). Messages never touch a server.
- **Inline image sharing**: P2P only. Images chunked to 8KB segments, ChaCha20-Poly1305 encrypted per chunk, reassembled in-memory, 2MB cap. Never written to disk. Destroyed with session.
- **Dead drop**: Encrypted blobs published to decentralized Nostr relay pool. Custom TTL from 2h to 24h. 30-second polling while waiting for peers. Event kind 1337 (invisible to standard Nostr clients). NIP-09 deletion.
- **Encryption**: ChaCha20-Poly1305 with per-session ephemeral keys (X25519 ECDH + HKDF-SHA256).
- **Key derivation**: Argon2id (16 MiB, 3 iterations) from shared secret. Domain-separated salts for room ID, room key, and drop ID.
- **Crypto runtime**: Rust compiled to WebAssembly. Keys never enter the JavaScript heap. Deterministic zeroing via zeroize crate. Feature flag rollback to JS/Web Crypto.
- **Compatibility**: Tor Browser and iOS Lockdown Mode supported with automatic WebRTC fallback to dead drop mode.

## Traffic Analysis Resistance

- Fixed 8,192-byte message padding with random noise fill
- Timestamp rounding to 60-second granularity
- Encrypted chaff traffic at random 10-60 second intervals
- Dead drop privacy envelopes: Nostr event timestamp jittered 0-120s, random 0-10s publish delay

## Security Features

- Panic wipe (ESC x 3): zeros keys, clears storage, replaces DOM
- Steganographic mode (Shift x 5): disguises interface as document editor
- Dead man's switch: timed auto-activating dead drops, 1h to 48h timers, 6-character cancellation token, SHA-256 hashed token verification, no background execution required
- Duress password: @ prefix triggers a decoy room with generated conversation, poison event warns the other party
- Tiered self-destruct timers on all messages
- Clipboard auto-clear, selection blocking, screenshot interception
- Inactivity timeout with auto-disconnect
- Collapsible dead drop messages with tap-to-reveal
- SRI hashes: SHA-384 integrity on all static assets

## Stack

React 19, TypeScript, Vite, Tailwind. Cryptographic core in Rust/WASM 
(argon2, chacha20poly1305, x25519-dalek, hkdf, sha2, zeroize).

Built by [Attacless](https://attacless.com)
