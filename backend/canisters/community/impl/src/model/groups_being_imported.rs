use serde::{Deserialize, Serialize};
use std::collections::hash_map::Entry::Vacant;
use std::collections::{BTreeSet, HashMap};
use types::{AiAppId, ChannelId, ChatId, EventContext, TimestampMillis, Timestamped, UserId};

#[derive(Serialize, Deserialize, Default)]
pub struct GroupsBeingImported {
    groups: HashMap<ChatId, GroupBeingImported>,
}

pub struct GroupToImport {
    pub group_id: ChatId,
    pub action: GroupToImportAction,
}

#[derive(Debug)]
pub enum GroupToImportAction {
    Events(ChannelId, Option<EventContext>),
    Members(ChannelId, Option<UserId>),
    Core(u64),
}

impl GroupsBeingImported {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the existing import boundary and its captured app policy explicit without changing callers"
    )]
    pub fn add(
        &mut self,
        group_id: ChatId,
        channel_id: ChannelId,
        imported_by: UserId,
        total_bytes: u64,
        mut enabled_ai_apps: BTreeSet<AiAppId>,
        now: TimestampMillis,
        is_default: bool,
    ) -> bool {
        group_community_common::bound_enabled_ai_apps(&mut enabled_ai_apps);
        match self.groups.entry(group_id) {
            Vacant(e) => {
                e.insert(GroupBeingImported::new(
                    channel_id,
                    imported_by,
                    total_bytes,
                    enabled_ai_apps,
                    is_default,
                    now,
                ));
                true
            }
            _ => false,
        }
    }

    pub fn contains(&self, group_id: &ChatId) -> bool {
        self.groups.contains_key(group_id)
    }

    pub fn next_batch(&mut self, now: TimestampMillis) -> Vec<GroupToImport> {
        let mut batch = Vec::new();
        for (chat_id, group) in self.groups.iter_mut().filter(|(_, g)| !g.is_complete()) {
            if group.current_batch_started.is_none() {
                group.current_batch_started = Some(now);
                let action = if !group.events_imported {
                    GroupToImportAction::Events(group.channel_id, group.events_imported_up_to.clone())
                } else if !group.members_imported {
                    GroupToImportAction::Members(group.channel_id, group.members_imported_up_to)
                } else {
                    GroupToImportAction::Core(group.bytes.len() as u64)
                };
                batch.push(GroupToImport {
                    group_id: *chat_id,
                    action,
                });
            }
        }
        batch
    }

    // Returns true if the group bytes have all been imported, else false
    pub fn mark_batch_complete(&mut self, group_id: &ChatId, bytes: &[u8]) -> bool {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = None;
            group.bytes.extend_from_slice(bytes);
            group.is_complete()
        } else {
            false
        }
    }

    pub fn mark_events_batch_complete(&mut self, group_id: &ChatId, up_to: EventContext) {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = None;
            group.events_imported_up_to = Some(up_to);
        }
    }

    pub fn mark_events_import_complete(&mut self, group_id: &ChatId) {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = None;
            group.events_imported = true;
        }
    }

    pub fn mark_members_batch_complete(&mut self, group_id: &ChatId, up_to: UserId) {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = None;
            group.members_imported_up_to = Some(up_to);
        }
    }

    pub fn mark_members_import_complete(&mut self, group_id: &ChatId) {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = None;
            group.members_imported = true;
        }
    }

    pub fn mark_batch_failed(&mut self, group_id: &ChatId, error_message: String) {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.current_batch_started = None;
            group.error_message = Some(error_message);
        }
    }

    pub fn take(&mut self, group_id: &ChatId) -> Option<GroupBeingImported> {
        self.groups.remove(group_id)
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    pub fn summaries(&self) -> Vec<GroupBeingImportedSummary> {
        self.groups.values().map(|g| g.into()).collect()
    }

    pub fn completed_imports(&self) -> Vec<ChatId> {
        self.groups.iter().filter(|(_, g)| g.is_complete()).map(|(g, _)| *g).collect()
    }

    pub(crate) fn bound_enabled_ai_apps(&mut self) {
        for group in self.groups.values_mut() {
            group_community_common::bound_enabled_ai_apps(&mut group.enabled_ai_apps);
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct GroupBeingImported {
    channel_id: ChannelId,
    imported_by: UserId,
    import_started: TimestampMillis,
    current_batch_started: Option<TimestampMillis>,
    events_imported: bool,
    events_imported_up_to: Option<EventContext>,
    members_imported: bool,
    members_imported_up_to: Option<UserId>,
    total_bytes: u64,
    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
    error_message: Option<String>,
    is_default: Timestamped<bool>,
    // AI apps enabled on the source group; written onto the channel at finalize.
    // `#[serde(default)]` so an import already in flight across the upgrade that
    // introduced this field still deserializes (falls back to an empty set).
    #[serde(default)]
    enabled_ai_apps: BTreeSet<AiAppId>,
}

impl GroupBeingImported {
    pub fn new(
        channel_id: ChannelId,
        imported_by: UserId,
        total_bytes: u64,
        enabled_ai_apps: BTreeSet<AiAppId>,
        is_default: bool,
        now: TimestampMillis,
    ) -> GroupBeingImported {
        GroupBeingImported {
            channel_id,
            imported_by,
            import_started: now,
            current_batch_started: None,
            events_imported: false,
            events_imported_up_to: None,
            members_imported: false,
            members_imported_up_to: None,
            total_bytes,
            bytes: Vec::with_capacity(total_bytes as usize),
            error_message: None,
            is_default: Timestamped::new(is_default, now),
            enabled_ai_apps,
        }
    }

    pub fn channel_id(&self) -> ChannelId {
        self.channel_id
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn enabled_ai_apps(&self) -> &BTreeSet<AiAppId> {
        &self.enabled_ai_apps
    }

    pub fn is_default(&self) -> Timestamped<bool> {
        self.is_default.clone()
    }

    pub fn is_complete(&self) -> bool {
        self.bytes.len() as u64 == self.total_bytes
    }
}

#[derive(Serialize, Debug)]
pub struct GroupBeingImportedSummary {
    imported_by: UserId,
    import_started: TimestampMillis,
    current_batch_started: Option<TimestampMillis>,
    total_bytes: u64,
    bytes_synced: u64,
    error_message: Option<String>,
}

impl From<&GroupBeingImported> for GroupBeingImportedSummary {
    fn from(value: &GroupBeingImported) -> Self {
        GroupBeingImportedSummary {
            imported_by: value.imported_by,
            import_started: value.import_started,
            current_batch_started: value.current_batch_started,
            total_bytes: value.total_bytes,
            bytes_synced: value.bytes.len() as u64,
            error_message: value.error_message.clone(),
        }
    }
}
