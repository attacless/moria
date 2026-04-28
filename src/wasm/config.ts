// Feature flag: automatically falls back to JS crypto when WebAssembly
// is unavailable (iOS Lockdown Mode, restricted browsers).
export const USE_WASM_CRYPTO = typeof WebAssembly !== 'undefined'
