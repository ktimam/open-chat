use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// Generic verification challenge OpenChat sends to an AI app's own canister at publish time.
///
/// The app answers whether it vouches for `name` under `owner`. The lightest viable check (option
/// A) ignores `owner` and simply attests the name: because the c2c reached the canister the manifest
/// declared and it acknowledged the name, possession of that canister is treated as control of the
/// app. `owner` is kept in the contract so a stricter app can also bind its OpenChat registrant.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Args {
    /// The manifest `name` being published (e.g. the app's stable identifier).
    pub name: String,
    /// The OpenChat-side registrant principal (a UserId's canister). Apps using option A ignore it.
    pub owner: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Response {
    /// True iff the app canister vouches for `name` (and, if it checks, `owner`). OpenChat treats a
    /// false, a trap, a timeout, or a decode failure all as "not verified".
    pub vouched: bool,
    /// Echo of the name the app recognises (optional, for diagnostics).
    pub name: Option<String>,
    /// The principal the app considers its owner (optional, for diagnostics / option B).
    pub owner: Option<Principal>,
}
