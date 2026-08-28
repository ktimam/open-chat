use std::collections::BTreeSet;
use types::AiAppId;

/// A chat-local allow-list is configuration, not an application directory. Keeping it small makes
/// update, query, upgrade, and group-to-channel import costs independent of attacker-chosen app ids.
pub const MAX_ENABLED_AI_APPS_PER_CHAT: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnabledAiAppsLimitReached;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileEnabledAiAppsError {
    ConfigurationChanged,
    AppUnavailable,
    LimitReached,
}

/// Applies an enable/disable operation without allowing the set to grow beyond its fixed limit.
///
/// Enabling an already-enabled app is idempotent, including at capacity. Disabling is always
/// allowed, so an administrator can remove or replace entries after the set reaches capacity.
pub fn set_ai_app_enabled(
    enabled_ai_apps: &mut BTreeSet<AiAppId>,
    app_id: AiAppId,
    enabled: bool,
) -> Result<(), EnabledAiAppsLimitReached> {
    if !enabled {
        enabled_ai_apps.remove(&app_id);
        return Ok(());
    }

    if enabled_ai_apps.contains(&app_id) {
        return Ok(());
    }

    if enabled_ai_apps.len() >= MAX_ENABLED_AI_APPS_PER_CHAT {
        return Err(EnabledAiAppsLimitReached);
    }

    enabled_ai_apps.insert(app_id);
    Ok(())
}

/// Reconciles the exact allow-list covered by one authoritative directory lookup, then enables its
/// candidate. Any concurrent configuration change fails closed so an older enable cannot overwrite
/// a newer enable/disable decision.
///
/// Cleanup is committed even when the candidate disappeared or the remaining valid entries still
/// fill the chat limit. This makes deleted/unpublished ids release their slots on the next enable
/// operation without letting an arbitrary id enter the allow-list.
pub fn reconcile_and_enable_ai_app(
    enabled_ai_apps: &mut BTreeSet<AiAppId>,
    enabled_ai_apps_snapshot: &BTreeSet<AiAppId>,
    checked_app_ids: &BTreeSet<AiAppId>,
    published_app_ids: &BTreeSet<AiAppId>,
    app_id: AiAppId,
) -> Result<usize, ReconcileEnabledAiAppsError> {
    if enabled_ai_apps != enabled_ai_apps_snapshot {
        return Err(ReconcileEnabledAiAppsError::ConfigurationChanged);
    }

    let before = enabled_ai_apps.len();
    enabled_ai_apps.retain(|enabled_id| !checked_app_ids.contains(enabled_id) || published_app_ids.contains(enabled_id));
    let removed = before - enabled_ai_apps.len();

    if !checked_app_ids.contains(&app_id) || !published_app_ids.contains(&app_id) {
        return Err(ReconcileEnabledAiAppsError::AppUnavailable);
    }

    set_ai_app_enabled(enabled_ai_apps, app_id, true).map_err(|_| ReconcileEnabledAiAppsError::LimitReached)?;
    Ok(removed)
}

/// Bounds legacy or imported state deterministically. `BTreeSet` order means that every canister
/// retains the same lowest app ids, irrespective of hash seeds or insertion order.
pub fn bound_enabled_ai_apps(enabled_ai_apps: &mut BTreeSet<AiAppId>) {
    if enabled_ai_apps.len() > MAX_ENABLED_AI_APPS_PER_CHAT {
        *enabled_ai_apps = enabled_ai_apps.iter().take(MAX_ENABLED_AI_APPS_PER_CHAT).copied().collect();
    }
}

pub fn bounded_enabled_ai_apps(enabled_ai_apps: impl IntoIterator<Item = AiAppId>) -> BTreeSet<AiAppId> {
    let mut bounded = BTreeSet::new();
    for app_id in enabled_ai_apps {
        bounded.insert(app_id);
        if bounded.len() > MAX_ENABLED_AI_APPS_PER_CHAT {
            bounded.pop_last();
        }
    }
    bounded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_32nd_app_but_rejects_the_33rd() {
        let mut apps: BTreeSet<_> = (0..31).collect();

        assert_eq!(apps.len(), 31);
        assert_eq!(set_ai_app_enabled(&mut apps, u32::MAX, true), Ok(()));
        assert_eq!(apps.len(), 32);
        assert!(apps.contains(&u32::MAX));

        assert_eq!(set_ai_app_enabled(&mut apps, 31, true), Err(EnabledAiAppsLimitReached));
        assert_eq!(apps.len(), 32);
        assert!(!apps.contains(&31));
    }

    #[test]
    fn idempotent_enable_and_replacement_remain_available_at_capacity() {
        let mut apps: BTreeSet<_> = (0..MAX_ENABLED_AI_APPS_PER_CHAT as u32).collect();

        assert_eq!(set_ai_app_enabled(&mut apps, 31, true), Ok(()));
        assert_eq!(apps.len(), 32);

        assert_eq!(set_ai_app_enabled(&mut apps, 7, false), Ok(()));
        assert_eq!(apps.len(), 31);
        assert_eq!(set_ai_app_enabled(&mut apps, u32::MAX, true), Ok(()));
        assert_eq!(apps.len(), 32);
        assert!(!apps.contains(&7));
        assert!(apps.contains(&u32::MAX));
    }

    #[test]
    fn legacy_and_imported_sets_are_bounded_deterministically() {
        let mut apps: BTreeSet<_> = (0..100).rev().chain([u32::MAX]).collect();

        bound_enabled_ai_apps(&mut apps);

        assert_eq!(apps.len(), 32);
        assert_eq!(apps, (0..32).collect());
    }

    #[test]
    fn bounded_iterator_does_not_interpret_huge_ids_as_indexes() {
        let apps = bounded_enabled_ai_apps((0..100).rev().chain([u32::MAX, u32::MAX - 1]));

        assert_eq!(apps, (0..32).collect());
    }

    #[test]
    fn authoritative_reconciliation_prunes_stale_ids_and_enables_the_candidate() {
        let mut apps = BTreeSet::from([1, 2]);
        let snapshot = apps.clone();
        let checked = BTreeSet::from([1, 2, 3]);
        let published = BTreeSet::from([1, 3]);

        assert_eq!(
            reconcile_and_enable_ai_app(&mut apps, &snapshot, &checked, &published, 3),
            Ok(1)
        );
        assert_eq!(apps, BTreeSet::from([1, 3]));
    }

    #[test]
    fn unavailable_candidate_is_rejected_after_bounded_cleanup() {
        let mut apps = BTreeSet::from([1, 2]);
        let snapshot = apps.clone();
        let checked = BTreeSet::from([1, 2, 3]);
        let published = BTreeSet::from([1]);

        assert_eq!(
            reconcile_and_enable_ai_app(&mut apps, &snapshot, &checked, &published, 3),
            Err(ReconcileEnabledAiAppsError::AppUnavailable)
        );
        assert_eq!(apps, BTreeSet::from([1]));
    }

    #[test]
    fn stale_entry_frees_a_capacity_slot_before_enable() {
        let mut apps: BTreeSet<_> = (0..MAX_ENABLED_AI_APPS_PER_CHAT as u32).collect();
        let snapshot = apps.clone();
        let checked: BTreeSet<_> = apps.iter().copied().chain([u32::MAX]).collect();
        let published: BTreeSet<_> = apps.iter().copied().filter(|app_id| *app_id != 7).chain([u32::MAX]).collect();

        assert_eq!(
            reconcile_and_enable_ai_app(&mut apps, &snapshot, &checked, &published, u32::MAX),
            Ok(1)
        );
        assert_eq!(apps.len(), MAX_ENABLED_AI_APPS_PER_CHAT);
        assert!(!apps.contains(&7));
        assert!(apps.contains(&u32::MAX));
    }

    #[test]
    fn concurrent_configuration_change_fails_without_overwriting_it() {
        let snapshot = BTreeSet::from([1, 2]);
        let mut apps = BTreeSet::from([1, 2, 99]);
        let checked = BTreeSet::from([1, 2, 3]);
        let published = BTreeSet::from([1, 2, 3]);

        assert_eq!(
            reconcile_and_enable_ai_app(&mut apps, &snapshot, &checked, &published, 3),
            Err(ReconcileEnabledAiAppsError::ConfigurationChanged)
        );
        assert_eq!(apps, BTreeSet::from([1, 2, 99]));
    }
}
