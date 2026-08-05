// New app-bound action cards must stay disabled until the backend can attest the complete canonical
// card content (title, rows, exact payload, and producing app/action revision). Coordinate-only
// provenance is insufficient: a sender can otherwise pair genuine app coordinates with forged card
// content. Keep this as a production constant, not a local-storage/query flag; enabling it requires
// the implemented server attestation path to be present in rebuilt canisters and to pass its
// generated-contract, PocketIC, and live cross-layer gates.
export function appContentAttestationAvailable(): boolean {
    return false;
}

// Initial card-content attestation cannot authorize an iframe-edited override. Confirmation remains
// disabled until the implemented separate server/app grant is deployed and proves that it binds the
// exact final bytes to the authenticated viewer, chat/message/thread, app revision/action, and
// replay-safe grant across the release matrix. Cancellation does not need it.
export function appCardFinalConfirmationAvailable(): boolean {
    return false;
}

// Private context is separately gated from public card rendering and final confirmation. User
// authorization and source protocol exist, but activation remains false until rebuilt OpenChat
// canisters and each registered app's redemption/decryption contract pass the end-to-end scope,
// expiry, replay, upgrade, and four-profile suite.
export function appCardPrivateContextAvailable(): boolean {
    return false;
}
