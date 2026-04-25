# Moria

Anonymous encrypted peer-to-peer chat. No accounts. No servers. Nothing is stored. Nothing survives.

https://moria.chat

## Architecture

- **Live chat**: WebRTC peer-to-peer via Trystero (Nostr signaling). Messages never touch a server.
- **Dead drop**: Encrypted blobs published to decentralized Nostr relay pool. 24h TTL, NIP-09 deletion.
- **Encryption**: ChaCha20-Poly1305 with per-session ephemeral keys (X25519 ECDH + HKDF-SHA256).
- **Key derivation**: Argon2id (16 MiB, 3 iterations) from shared secret.

## Traffic Analysis Resistance

- Fixed 8,192-byte message padding with random noise fill
- Timestamp rounding to 60-second granularity
- Encrypted chaff traffic at random 10-60 second intervals

## Security Features

- Panic wipe (ESC x 3): zeros keys, clears storage, replaces DOM
- Steganographic mode (Shift x 5): disguises interface as document editor
- Tiered self-destruct timers on all messages
- Clipboard auto-clear, selection blocking, screenshot interception
- Inactivity timeout with auto-disconnect

## Stack

React 19, TypeScript, Vite, Tailwind

## Deployment
