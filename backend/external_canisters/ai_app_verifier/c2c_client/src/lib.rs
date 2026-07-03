use ai_app_verifier_canister::*;
use canister_client::generate_candid_c2c_call;

// The single generic method every AI app implements so OpenChat can verify its manifest at publish.
generate_candid_c2c_call!(c2c_verify_ai_app);
