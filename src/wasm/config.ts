// Feature flag: set to false to revert all crypto operations to the original JS/Web Crypto implementation.
// No rebuild of the Rust WASM module is needed. Just flip this boolean and redeploy.
export const USE_WASM_CRYPTO = true
