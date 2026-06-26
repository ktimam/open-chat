use candid::CandidType;
use serde::{Deserialize, Serialize};

// Exposes the platform P-256 signing public key (PEM) this shard signs confirmed-action deposits with, so a
// consumer (or a deploy script wiring the action_inbox) can verify deposits against the right key.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(String),
}
