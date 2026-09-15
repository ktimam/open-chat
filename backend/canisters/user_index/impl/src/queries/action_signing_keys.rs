use crate::model::action_signing_keyring;
use crate::{RuntimeState, read_state};
use ic_cdk::query;
use serde_bytes::ByteBuf;
use user_index_canister::action_signing_keys::{Response::*, *};

#[query]
fn action_signing_keys(_args: Args) -> Response {
    read_state(action_signing_keys_impl)
}

fn action_signing_keys_impl(state: &RuntimeState) -> Response {
    let now = state.env.now();
    let keys: Vec<_> = state
        .data
        .action_signing_keyring
        .public_keys_at(now)
        .map(|entry| ActionSigningPublicKey {
            key_id: ByteBuf::from(entry.key_id.to_vec()),
            public_key_pem: entry.public_key_pem.to_string(),
            status: match entry.status {
                action_signing_keyring::ActionSigningKeyStatus::Staged => ActionSigningKeyStatus::Staged,
                action_signing_keyring::ActionSigningKeyStatus::Active => ActionSigningKeyStatus::Active,
                action_signing_keyring::ActionSigningKeyStatus::VerifyOnly => ActionSigningKeyStatus::VerifyOnly,
            },
            created_at: entry.created_at,
            verify_until: entry.verify_until,
        })
        .collect();
    if keys.is_empty() {
        NotInitialised
    } else {
        Success(SuccessResult {
            signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
            purpose: "action_inbox_deposit".to_string(),
            keys,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::model::action_signing_keyring::ActionSigningKeyring;

    #[test]
    fn empty_keyring_fails_closed() {
        assert_eq!(ActionSigningKeyring::default().public_keys().count(), 0);
    }
}
