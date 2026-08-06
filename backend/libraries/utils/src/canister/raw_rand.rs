use candid::Principal;
use ic_cdk::call::{Call, CallResult};
use ic_cdk_management_canister::{self as management_canister, RawRandResult};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RawRandWaitMode {
    Bounded,
    Unbounded,
}

const fn raw_rand_wait_mode(test_mode: bool) -> RawRandWaitMode {
    if test_mode { RawRandWaitMode::Unbounded } else { RawRandWaitMode::Bounded }
}

/// Requests IC management-canister randomness using the established bounded call in production.
/// Test-mode canisters use an unbounded wait because local replicas may not complete `raw_rand`
/// within the bounded-call timeout even though the management-canister request remains valid.
pub async fn request_raw_rand(test_mode: bool) -> CallResult<RawRandResult> {
    match raw_rand_wait_mode(test_mode) {
        RawRandWaitMode::Bounded => management_canister::raw_rand().await,
        RawRandWaitMode::Unbounded => Ok(Call::unbounded_wait(Principal::management_canister(), "raw_rand")
            .await?
            .candid()?),
    }
}

// Get a random seed based on 'raw_rand'
pub async fn get_random_seed() -> [u8; 32] {
    let raw_rand = match management_canister::raw_rand().await {
        Ok(res) => res,
        Err(err) => ic_cdk::trap(format!("failed to get seed: {err}")),
    };

    raw_rand.as_slice().try_into().unwrap_or_else(|_| {
        ic_cdk::trap(format!(
            "when creating seed from raw_rand output, expected raw randomness to be of length 32, got {}",
            raw_rand.len()
        ));
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_keeps_the_existing_bounded_raw_rand_call() {
        assert_eq!(raw_rand_wait_mode(false), RawRandWaitMode::Bounded);
    }

    #[test]
    fn test_mode_selects_the_explicit_unbounded_raw_rand_call() {
        assert_eq!(raw_rand_wait_mode(true), RawRandWaitMode::Unbounded);
    }
}
