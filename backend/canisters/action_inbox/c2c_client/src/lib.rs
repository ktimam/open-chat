use action_inbox_canister::*;
use canister_client::generate_c2c_call;

generate_c2c_call!(c2c_notify_actions, 10);
generate_c2c_call!(configuration, 10);
