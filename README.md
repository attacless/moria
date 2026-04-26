# Moria

Anonymous, end-to-end encrypted, ephemeral chat rooms. 
No accounts. No logs. No metadata.

Nothing is stored, nothing survives. 

https://moria.chat
License: [AGPL-3.0](LICENSE)

## Architecture

- **Live chat**: WebRTC peer-to-peer via Trystero (Nostr signaling). Messages never touch a server.
- **Dead drop**: Encrypted blobs published to decentralized Nostr relay pool. 24h TTL, NIP-09 deletion.
- **Encryption**: ChaCha20-Poly1305 with per-session ephemeral keys (X25519 ECDH + HKDF-SHA256).
- **Key derivation**: Argon2id (16 MiB, 3 iterations) from shared secret. Domain-separated salts for room ID, room key, and drop ID.
- **Crypto runtime**: Rust compiled to WebAssembly. Keys never enter the JavaScript heap. Deterministic zeroing via zeroize crate. Feature flag rollback to JS/Web Crypto.

## Traffic Analysis Resistance

- Fixed 8,192-byte message padding with random noise fill
- Timestamp rounding to 60-second granularity
- Encrypted chaff traffic at random 10-60 second intervals
- Dead drop privacy envelopes: Nostr event timestamp jittered 0-120s, random 0-10s publish delay

## Security Features

- Panic wipe (ESC x 3): zeros keys, clears storage, replaces DOM
- Steganographic mode (Shift x 5): disguises interface as document editor
- Tiered self-destruct timers on all messages
- Clipboard auto-clear, selection blocking, screenshot interception
- Inactivity timeout with auto-disconnect
- Collapsible dead drop messages with tap-to-reveal

## Stack

React 19, TypeScript, Vite, Tailwind. Cryptographic core in Rust/WASM 
(argon2, chacha20poly1305, x25519-dalek, hkdf, sha2, zeroize).

Built by [Attacless](https://attacless.com)
