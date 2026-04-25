use wasm_bindgen::prelude::*;
use argon2::{Argon2, Algorithm, Version, Params};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use chacha20poly1305::aead::{Aead, KeyInit};
use x25519_dalek::{StaticSecret, PublicKey};
use hkdf::Hkdf;
use sha2::Sha256;
use rand::RngCore;
use rand::rngs::OsRng;
use zeroize::Zeroizing;

// ── Argon2id constants ────────────────────────────────────────────────────────
// Must match @noble/hashes argon2id call in src/crypto/worker.ts exactly:
//   m: 16384, t: 3, p: 1, dkLen: 32, version: 0x13 (default)
const M_COST: u32 = 16384;
const T_COST: u32 = 3;
const P_COST: u32 = 1;
const DK_LEN: usize = 32;

const SALT_ROOM_ID:  &[u8] = b"moria-room-id-v1-salt";
const SALT_ROOM_KEY: &[u8] = b"moria-room-key-v1-salt";
const SALT_DROP_ID:  &[u8] = b"moria-drop-id-v1-salt";

// ── ChaCha20-Poly1305 constants ───────────────────────────────────────────────
// Must match src/crypto/chacha20.ts exactly:
//   BLOCK_SIZE = 8192, NONCE_SIZE = 12, TAG_SIZE = 16, WIRE_SIZE = 8220
const BLOCK_SIZE: usize = 8192;
const NONCE_LEN:  usize = 12;
const TAG_LEN:    usize = 16;
const WIRE_SIZE:  usize = NONCE_LEN + BLOCK_SIZE + TAG_LEN; // 8220

// ── Argon2id helpers ──────────────────────────────────────────────────────────

fn argon2id_derive(secret: &[u8], salt: &[u8]) -> Vec<u8> {
    let params = Params::new(M_COST, T_COST, P_COST, Some(DK_LEN))
        .expect("valid Argon2id params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut output = vec![0u8; DK_LEN];
    argon2
        .hash_password_into(secret, salt, &mut output)
        .expect("Argon2id derivation failed");
    output
}

// ── Exported: ping ────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn ping() -> String {
    "moria-crypto ready".to_string()
}

// ── Exported: Argon2id key derivation ─────────────────────────────────────────

/// Derives the Trystero room namespace from the shared secret.
/// Output: 32 raw bytes (caller converts to hex for Trystero).
/// Salt: "moria-room-id-v1-salt"
#[wasm_bindgen]
pub fn derive_room_id(secret: &str) -> Vec<u8> {
    argon2id_derive(secret.as_bytes(), SALT_ROOM_ID)
}

/// Derives the ChaCha20-Poly1305 session key from the shared secret.
/// Output: 32 raw bytes. Caller is responsible for zeroing after use.
/// Salt: "moria-room-key-v1-salt"
#[wasm_bindgen]
pub fn derive_room_key(secret: &str) -> Vec<u8> {
    argon2id_derive(secret.as_bytes(), SALT_ROOM_KEY)
}

/// Derives the Nostr dead drop room tag from the shared secret.
/// Deliberately distinct from room ID to prevent relay correlation.
/// Salt: "moria-drop-id-v1-salt"
#[wasm_bindgen]
pub fn derive_drop_id(secret: &str) -> Vec<u8> {
    argon2id_derive(secret.as_bytes(), SALT_DROP_ID)
}

// ── Exported: ChaCha20-Poly1305 encrypt ───────────────────────────────────────

/// Encrypts raw plaintext bytes with a 32-byte key.
///
/// Matches chacha20.ts `encryptMessage` byte-for-byte:
/// - Pads plaintext to BLOCK_SIZE (8192) bytes:
///     [2-byte LE length][content][random fill]
/// - Generates a 12-byte random nonce
/// - Encrypts with IETF ChaCha20-Poly1305 (RFC 8439)
/// - Returns: nonce || ciphertext+tag  (8220 bytes fixed)
///
/// `plaintext` must be raw UTF-8 JSON bytes (caller serialises WireMessage).
#[wasm_bindgen]
pub fn encrypt(plaintext: &[u8], key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str("encrypt: key must be 32 bytes"));
    }
    if plaintext.len() > BLOCK_SIZE - 2 {
        return Err(JsValue::from_str(&format!(
            "encrypt: plaintext too long ({} bytes, max {})",
            plaintext.len(),
            BLOCK_SIZE - 2
        )));
    }

    // ── Pad: [2-byte LE length][content][cryptographic random fill] ──────────
    // Matches chacha20.ts pad() exactly — uses random fill, not zeros.
    let mut padded = Zeroizing::new(vec![0u8; BLOCK_SIZE]);
    padded[0] = (plaintext.len() & 0xff) as u8;
    padded[1] = ((plaintext.len() >> 8) & 0xff) as u8;
    padded[2..2 + plaintext.len()].copy_from_slice(plaintext);
    OsRng.fill_bytes(&mut padded[2 + plaintext.len()..]);

    // ── Generate 12-byte random nonce ────────────────────────────────────────
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // ── Encrypt → ciphertext+tag (BLOCK_SIZE + TAG_LEN bytes) ───────────────
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let ciphertext = cipher
        .encrypt(nonce, padded.as_slice())
        .map_err(|e| JsValue::from_str(&format!("encrypt: aead error: {e}")))?;
    // padded is Zeroizing — wiped here on drop

    // ── Wire: nonce || ciphertext+tag ────────────────────────────────────────
    let mut wire = vec![0u8; WIRE_SIZE];
    wire[..NONCE_LEN].copy_from_slice(&nonce_bytes);
    wire[NONCE_LEN..].copy_from_slice(&ciphertext);

    Ok(wire)
}

// ── Exported: ChaCha20-Poly1305 decrypt ───────────────────────────────────────

/// Decrypts an 8220-byte wire blob produced by `encrypt()` or chacha20.ts.
///
/// Matches chacha20.ts `decryptMessage` byte-for-byte:
/// - Extracts nonce (bytes 0–11) and ciphertext+tag (bytes 12–8219)
/// - Decrypts with IETF ChaCha20-Poly1305 → 8192-byte padded plaintext
/// - Unpads using the 2-byte LE length prefix
/// - Returns raw plaintext bytes (caller decodes UTF-8 JSON → WireMessage)
///
/// Returns Err on authentication failure or malformed input (do not throw
/// across the boundary — caller must handle the JS exception).
#[wasm_bindgen]
pub fn decrypt(wire: &[u8], key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if wire.len() != WIRE_SIZE {
        return Err(JsValue::from_str(&format!(
            "decrypt: wire must be {WIRE_SIZE} bytes, got {}",
            wire.len()
        )));
    }
    if key.len() != 32 {
        return Err(JsValue::from_str("decrypt: key must be 32 bytes"));
    }

    // ── Extract nonce and ciphertext ─────────────────────────────────────────
    let nonce      = Nonce::from_slice(&wire[..NONCE_LEN]);
    let ciphertext = &wire[NONCE_LEN..];

    // ── Decrypt and authenticate ──────────────────────────────────────────────
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let padded = Zeroizing::new(
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| JsValue::from_str("decrypt: authentication failed"))?,
    );

    // ── Unpad: read LE 2-byte length, return content ─────────────────────────
    // Matches chacha20.ts unpad() exactly.
    let len = (padded[0] as usize) | ((padded[1] as usize) << 8);
    if len + 2 > BLOCK_SIZE {
        return Err(JsValue::from_str("decrypt: invalid padding length"));
    }

    Ok(padded[2..2 + len].to_vec())
    // padded is Zeroizing — wiped on drop
}

// ── Exported: X25519 ephemeral keypair generation ─────────────────────────────

/// Generate an ephemeral X25519 keypair.
///
/// Matches generateIdentity() in src/crypto/x25519.ts:
///   x25519.utils.randomSecretKey() → private (32 bytes)
///   x25519.getPublicKey(private)   → public  (32 bytes)
///
/// Returns 64 bytes: private_key[0..32] || public_key[32..64]
/// Caller splits the slice and is responsible for zeroing private_key after use
/// (via destroyIdentity → zeroBytes).
#[wasm_bindgen]
pub fn generate_keypair() -> Vec<u8> {
    let private = StaticSecret::random_from_rng(OsRng);
    let public  = PublicKey::from(&private);

    let mut out = vec![0u8; 64];
    out[..32].copy_from_slice(private.as_bytes());
    out[32..].copy_from_slice(public.as_bytes());
    out
    // StaticSecret (private) zeroizes on drop here — bytes already copied to out
}

// ── Exported: X25519 ECDH + HKDF-SHA256 session key derivation ───────────────

/// Derive a 32-byte symmetric session key for a peer.
///
/// Matches derivePeerSessionKey() in src/crypto/x25519.ts exactly:
///   1. X25519 ECDH: sharedSecret = DH(myPrivate, theirPublic)   [32 bytes]
///   2. HKDF-SHA256:
///        salt = None  →  RFC 5869 default = 32 zero bytes
///                        (matches noble hkdf(sha256, ikm, undefined, ...))
///        info = UTF-8 bytes of "moria-p2p-session-key-v1"
///        length = 32
///   3. Zero the raw shared secret immediately (SharedSecret zeroizes on drop)
///
/// Returns 32-byte session key — used as ChaCha20-Poly1305 key for this peer.
#[wasm_bindgen]
pub fn derive_peer_session_key(
    my_private_key: &[u8],
    their_public_key: &[u8],
) -> Result<Vec<u8>, JsValue> {
    if my_private_key.len() != 32 {
        return Err(JsValue::from_str(
            "derive_peer_session_key: private key must be 32 bytes",
        ));
    }
    if their_public_key.len() != 32 {
        return Err(JsValue::from_str(
            "derive_peer_session_key: public key must be 32 bytes",
        ));
    }

    // Construct private key from caller-supplied bytes
    let priv_bytes: [u8; 32] = my_private_key.try_into().unwrap();
    let private = StaticSecret::from(priv_bytes);

    // Construct their public key
    let pub_bytes: [u8; 32] = their_public_key.try_into().unwrap();
    let public = PublicKey::from(pub_bytes);

    // X25519 ECDH — SharedSecret zeroizes on drop
    let shared = private.diffie_hellman(&public);

    // HKDF-SHA256: salt=None (→ 32 zero bytes per RFC 5869, matches noble undefined)
    //              info="moria-p2p-session-key-v1" (UTF-8, matches JS TextEncoder)
    let hk = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let mut session_key = vec![0u8; 32];
    hk.expand(b"moria-p2p-session-key-v1", &mut session_key)
        .map_err(|e| JsValue::from_str(&format!("derive_peer_session_key: HKDF error: {e}")))?;

    Ok(session_key)
    // shared (SharedSecret) zeroizes here on drop
}
