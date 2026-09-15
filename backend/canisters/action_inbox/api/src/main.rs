use candid_gen::generate_candid_method;

fn main() {
    generate_candid_method!(action_inbox, actions, update);
    generate_candid_method!(action_inbox, configuration, query);
    generate_candid_method!(action_inbox, acknowledge_actions, update);
    generate_candid_method!(action_inbox, c2c_notify_actions, update);

    candid::export_service!();
    std::print!("{}", __export_service());
}
