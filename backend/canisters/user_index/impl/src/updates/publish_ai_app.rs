use crate::guards::caller_is_governance_principal;
use crate::{mutate_state, read_state};
use ai_app_verifier_canister::c2c_verify_ai_app;
use canister_api_macros::{proposal, update};
use canister_tracing_macros::trace;
use tracing::info;
use types::CanisterId;
use user_index_canister::publish_ai_app::{Args, Response};

// Publishing makes a registered AI app visible in the directory/explorer for everyone (a new
// registration is private to its owner). Gated like publish_bot: an SNS proposal in production,
// open in test_mode so local deploys can self-publish. Candid-exposed as well as msgpack because
// external apps' deploy scripts drive registration+publication over plain candid.
//
// Before flipping visibility we make an anti-squatting check: the manifest must declare an
// `app_canister_id`, and that canister must vouch for the app's `name` over the generic
// `c2c_verify_ai_app` method. Only the canister the manifest points at can answer, so a squatter
// who registers someone else's name (with a bogus or absent canister) can never publish. The check
// is a cross-canister call, so this endpoint is async.
#[proposal(guard = "caller_is_governance_principal")]
#[trace]
async fn publish_ai_app(args: Args) -> Response {
    publish_ai_app_impl(args).await
}

#[update(msgpack = true)]
#[trace]
async fn publish_ai_app(args: Args) -> Response {
    // Same verification runs in test_mode; only the governance gate is relaxed for local deploys.
    if !read_state(|state| state.data.test_mode) {
        return Response::NotAuthorised;
    }
    publish_ai_app_impl(args).await
}

async fn publish_ai_app_impl(args: Args) -> Response {
    // Resolve the app and its declared canister up front (read-only). Absent id → NotVerified: the
    // anti-squatting gate requires a canister that can vouch.
    let prepared = read_state(|state| match state.data.ai_apps.get(args.app_id) {
        None => Err(Response::NotFound),
        Some(app) => match app.manifest.app_canister_id {
            Some(canister_id) => Ok((canister_id, app.manifest.name.clone(), app.owner)),
            None => Err(Response::NotVerified),
        },
    });
    let (app_canister_id, name, owner): (CanisterId, String, _) = match prepared {
        Ok(ok) => ok,
        Err(response) => return response,
    };

    // Ask the app's own canister to vouch for the name. Any non-vouch outcome — false, trap,
    // timeout, decode failure — maps to NotVerified. Never fail open.
    let vouched = match ai_app_verifier_canister_c2c_client::c2c_verify_ai_app(
        app_canister_id,
        &c2c_verify_ai_app::Args {
            name: name.clone(),
            owner: owner.into(),
        },
    )
    .await
    {
        Ok(response) => response.vouched,
        Err(error) => {
            info!(?error, %app_canister_id, name, "c2c_verify_ai_app failed; treating as not verified");
            false
        }
    };

    if !vouched {
        return Response::NotVerified;
    }

    // Re-check the app still exists after the await (it could have been deleted meanwhile), then
    // publish. Unlike bots there is no per-LUI replication to notify — clients query the registry.
    mutate_state(|state| {
        if state.data.ai_apps.publish(args.app_id, state.env.now()) {
            Response::Success
        } else {
            Response::NotFound
        }
    })
}
