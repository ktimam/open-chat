use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};

/// Legacy V1 verification challenge retained only for wire/source compatibility.
///
/// UserIndex never accepts this name-only contract as publication authority. Apps must implement
/// `c2c_verify_ai_app_v2` and bind the exact registry row and manifest commitment.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Args {
    /// The manifest `name` being published (e.g. the app's stable identifier).
    pub name: String,
    /// The OpenChat-side registrant principal (a UserId's canister).
    pub owner: Principal,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Response {
    /// Legacy diagnostic result. It cannot publish an app.
    pub vouched: bool,
    /// Echo of the name the app recognises (optional, for diagnostics).
    pub name: Option<String>,
    /// The principal the app considers its owner (optional, for diagnostics / option B).
    pub owner: Option<Principal>,
}
