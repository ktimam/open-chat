mod certification;
pub mod model;

use candid::Principal;
use certification::CertifiedDirectory;
use ic_http_certification::{HttpRequest, HttpResponse};
use model::{Init, Registry, Review, ReviewPage, Status};
use std::cell::RefCell;

// Make the reviewed interface discoverable through ordinary IC tooling. Its exact content is
// checked against the generated service by tests and embedded without a separate Wasm mutator.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "icp:public candid:service"]
static CANDID_METADATA: [u8; include_bytes!("../app_registry.did").len()] =
    *include_bytes!("../app_registry.did");

thread_local! {
    static REGISTRY: RefCell<Option<Registry>> = const { RefCell::new(None) };
    static DIRECTORY: RefCell<Option<CertifiedDirectory>> = const { RefCell::new(None) };
}

fn with_registry<T>(f: impl FnOnce(&Registry) -> T) -> T {
    REGISTRY.with_borrow(|state| f(state.as_ref().expect("Registry is not initialized")))
}
fn with_registry_mut<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with_borrow_mut(|state| f(state.as_mut().expect("Registry is not initialized")))
}
fn refresh_certification() {
    let pages = with_registry(|state| state.pages()).expect("Published directory must be bounded");
    let directory = CertifiedDirectory::new(pages).expect("Directory certification failed");
    ic_cdk::api::certified_data_set(directory.root_hash());
    DIRECTORY.with_borrow_mut(|slot| *slot = Some(directory));
}

#[ic_cdk::init]
fn init(args: Init) {
    let registry =
        Registry::new(args, ic_cdk::api::canister_self()).expect("Invalid registry initialization");
    REGISTRY.with_borrow_mut(|slot| *slot = Some(registry));
    refresh_certification();
}

#[ic_cdk::update]
fn register_app(descriptor_json: String) -> Result<Review, String> {
    with_registry_mut(|state| {
        state.register(
            ic_cdk::api::msg_caller(),
            &descriptor_json,
            ic_cdk::api::time(),
        )
    })
}

#[ic_cdk::query]
fn get_pending(owner: Principal, app_id: String) -> Result<Review, String> {
    with_registry(|state| state.pending(ic_cdk::api::msg_caller(), owner, &app_id))
}

#[ic_cdk::query]
fn get_my_apps(after_id: Option<String>) -> Result<ReviewPage, String> {
    with_registry(|state| state.mine(ic_cdk::api::msg_caller(), after_id.as_deref()))
}

#[ic_cdk::update]
fn publish_app(
    owner: Principal,
    app_id: String,
    expected_commitment: String,
) -> Result<Review, String> {
    let result = with_registry_mut(|state| {
        state.publish(
            ic_cdk::api::msg_caller(),
            owner,
            &app_id,
            &expected_commitment,
            ic_cdk::api::time(),
        )
    });
    if result.is_ok() {
        refresh_certification();
    }
    result
}

#[ic_cdk::update]
fn unpublish_app(app_id: String, expected_revision: u64) -> Result<u64, String> {
    let result = with_registry_mut(|state| {
        state.unpublish(ic_cdk::api::msg_caller(), &app_id, expected_revision)
    });
    if result.is_ok() {
        refresh_certification();
    }
    result
}

#[ic_cdk::query]
fn registry_status() -> Status {
    with_registry(Registry::status)
}

#[ic_cdk::query]
fn http_request(request: HttpRequest<'_>) -> HttpResponse<'static> {
    let certificate = ic_cdk::api::data_certificate().expect("HTTP must run as a certified query");
    DIRECTORY.with_borrow(|directory| {
        directory
            .as_ref()
            .expect("Directory is not initialized")
            .serve(&request, &certificate)
            .expect("Could not produce the certified directory witness")
    })
}

#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    with_registry(|state| ic_cdk::storage::stable_save((state,)))
        .expect("Could not preserve registry state");
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    // Fail closed on incompatible/corrupt data. Never replace saved state with an empty registry.
    let (state,): (Registry,) =
        ic_cdk::storage::stable_restore().expect("Could not restore registry state");
    state
        .validate_restored(ic_cdk::api::canister_self())
        .expect("Invalid restored registry state");
    REGISTRY.with_borrow_mut(|slot| *slot = Some(state));
    refresh_certification();
}

ic_cdk::export_candid!();

pub fn candid_interface() -> String {
    __export_service()
}

#[cfg(test)]
mod tests;
