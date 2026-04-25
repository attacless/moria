/* tslint:disable */
/* eslint-disable */

/**
 * Decrypts an 8220-byte wire blob produced by `encrypt()` or chacha20.ts.
 *
 * Matches chacha20.ts `decryptMessage` byte-for-byte:
 * - Extracts nonce (bytes 0–11) and ciphertext+tag (bytes 12–8219)
 * - Decrypts with IETF ChaCha20-Poly1305 → 8192-byte padded plaintext
 * - Unpads using the 2-byte LE length prefix
 * - Returns raw plaintext bytes (caller decodes UTF-8 JSON → WireMessage)
 *
 * Returns Err on authentication failure or malformed input (do not throw
 * across the boundary — caller must handle the JS exception).
 */
export function decrypt(wire: Uint8Array, key: Uint8Array): Uint8Array;

/**
 * Derives the Nostr dead drop room tag from the shared secret.
 * Deliberately distinct from room ID to prevent relay correlation.
 * Salt: "moria-drop-id-v1-salt"
 */
export function derive_drop_id(secret: string): Uint8Array;

/**
 * Derive a 32-byte symmetric session key for a peer.
 *
 * Matches derivePeerSessionKey() in src/crypto/x25519.ts exactly:
 *   1. X25519 ECDH: sharedSecret = DH(myPrivate, theirPublic)   [32 bytes]
 *   2. HKDF-SHA256:
 *        salt = None  →  RFC 5869 default = 32 zero bytes
 *                        (matches noble hkdf(sha256, ikm, undefined, ...))
 *        info = UTF-8 bytes of "moria-p2p-session-key-v1"
 *        length = 32
 *   3. Zero the raw shared secret immediately (SharedSecret zeroizes on drop)
 *
 * Returns 32-byte session key — used as ChaCha20-Poly1305 key for this peer.
 */
export function derive_peer_session_key(my_private_key: Uint8Array, their_public_key: Uint8Array): Uint8Array;

/**
 * Derives the Trystero room namespace from the shared secret.
 * Output: 32 raw bytes (caller converts to hex for Trystero).
 * Salt: "moria-room-id-v1-salt"
 */
export function derive_room_id(secret: string): Uint8Array;

/**
 * Derives the ChaCha20-Poly1305 session key from the shared secret.
 * Output: 32 raw bytes. Caller is responsible for zeroing after use.
 * Salt: "moria-room-key-v1-salt"
 */
export function derive_room_key(secret: string): Uint8Array;

/**
 * Encrypts raw plaintext bytes with a 32-byte key.
 *
 * Matches chacha20.ts `encryptMessage` byte-for-byte:
 * - Pads plaintext to BLOCK_SIZE (8192) bytes:
 *     [2-byte LE length][content][random fill]
 * - Generates a 12-byte random nonce
 * - Encrypts with IETF ChaCha20-Poly1305 (RFC 8439)
 * - Returns: nonce || ciphertext+tag  (8220 bytes fixed)
 *
 * `plaintext` must be raw UTF-8 JSON bytes (caller serialises WireMessage).
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array;

/**
 * Generate an ephemeral X25519 keypair.
 *
 * Matches generateIdentity() in src/crypto/x25519.ts:
 *   x25519.utils.randomSecretKey() → private (32 bytes)
 *   x25519.getPublicKey(private)   → public  (32 bytes)
 *
 * Returns 64 bytes: private_key[0..32] || public_key[32..64]
 * Caller splits the slice and is responsible for zeroing private_key after use
 * (via destroyIdentity → zeroBytes).
 */
export function generate_keypair(): Uint8Array;

export function ping(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly decrypt: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly derive_drop_id: (a: number, b: number, c: number) => void;
    readonly derive_peer_session_key: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly derive_room_id: (a: number, b: number, c: number) => void;
    readonly derive_room_key: (a: number, b: number, c: number) => void;
    readonly encrypt: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly generate_keypair: (a: number) => void;
    readonly ping: (a: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
