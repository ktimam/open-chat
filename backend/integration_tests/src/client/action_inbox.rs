use crate::generate_msgpack_update_call;
use action_inbox_canister::*;

// Updates
generate_msgpack_update_call!(actions);
generate_msgpack_update_call!(acknowledge_actions);
