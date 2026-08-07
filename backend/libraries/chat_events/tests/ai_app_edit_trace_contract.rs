#[test]
fn action_card_edit_ingress_is_not_traced_and_old_history_is_purged() {
    let routes = [
        include_str!("../../../canisters/user/impl/src/updates/edit_message.rs"),
        include_str!("../../../canisters/group/impl/src/updates/edit_message.rs"),
        include_str!("../../../canisters/community/impl/src/updates/edit_message.rs"),
    ];
    let upgrades = [
        include_str!("../../../canisters/user/impl/src/lifecycle/post_upgrade.rs"),
        include_str!("../../../canisters/group/impl/src/lifecycle/post_upgrade.rs"),
        include_str!("../../../canisters/community/impl/src/lifecycle/post_upgrade.rs"),
    ];

    for route in routes {
        assert!(
            !route.contains("#[trace]"),
            "an edit envelope can carry rejected private ActionCard material and must not be traced"
        );
    }
    for upgrade in upgrades {
        assert!(
            upgrade.contains("\"edit_message\""),
            "the first fixed upgrade must purge ActionCard edit traces written by earlier PR2 builds"
        );
    }
}
