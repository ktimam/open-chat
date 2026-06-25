use candid_gen::generate_candid_method;

fn main() {
    generate_candid_method!(action_inbox, actions, query);
    generate_candid_method!(action_inbox, openchat_public_key, query);
    generate_candid_method!(action_inbox, c2c_notify_actions, update);

    candid::export_service!();
    std::print!("{}", __export_service());
}
