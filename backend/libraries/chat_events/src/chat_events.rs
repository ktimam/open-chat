use crate::chat_events_list::Reader;
use crate::expiring_events::ExpiringEvents;
use crate::last_updated_timestamps::LastUpdatedTimestamps;
use crate::metrics::{ChatMetricsInternal, MetricKey};
use crate::search_index::SearchIndex;
use crate::*;
use constants::{ONE_MB, OPENCHAT_BOT_USER_ID};
use event_store_types::EventBuilder;
use oc_error_codes::{OCError, OCErrorCode};
use search::simple::{Document, Query};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::cmp::max;
use std::collections::btree_map::Entry::{Occupied, Vacant};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::mem;
use std::ops::DerefMut;
use tracing::error;
use types::{
    ActionCardResponse, ActionCardState, BlobReference, BotChatEvent, BotNotification, CallParticipant, CanisterId, Chat,
    ChatEvent, ChatEventCategory, ChatEventType, ChatType, CompletedCryptoTransaction, DiamondMembershipStatus,
    DirectChatCreated, EventContext, EventIndex, EventMetaData, EventWrapper, EventWrapperInternal, EventsTimeToLiveUpdated,
    GroupCanisterThreadDetails, GroupCreated, GroupFrozen, GroupUnfrozen, HydratedMention, Mention, Message,
    MessageEditedEventPayload, MessageEventPayload, MessageId, MessageIndex, MessageMatch, MessageTippedEventPayload,
    Milliseconds, MultiUserChat, OCResult, OgPreview, OptionUpdate, P2PSwapAccepted, P2PSwapCompleted,
    P2PSwapCompletedEventPayload, P2PSwapContent, P2PSwapStatus, PendingCryptoTransaction, PollVotes, ProposalRewardStatus,
    ProposalUpdate, Reaction, ReactionAddedEventPayload, RegisterVoteResult, ReserveP2PSwapSuccess, SenderContext, Tally,
    TimestampMillis, TimestampNanos, Timestamped, Tips, UserId, VideoCall, VideoCallEndedEventPayload, VideoCallParticipants,
    VideoCallPresence, VideoCallType, VoteOperation,
};

#[derive(Serialize, Deserialize)]
pub struct ChatEvents {
    chat: Chat,
    main: ChatEventsList,
    threads: BTreeMap<MessageIndex, ChatEventsList>,
    metrics: ChatMetricsInternal,
    per_user_metrics: BTreeMap<UserId, ChatMetricsInternal>,
    frozen: bool,
    events_ttl: Timestamped<Option<Milliseconds>>,
    expiring_events: ExpiringEvents,
    last_updated_timestamps: LastUpdatedTimestamps,
    video_call_in_progress: Timestamped<Option<VideoCallInternal>>,
    anonymized_id: String,
    search_index: SearchIndex,
    bot_subscriptions: BTreeMap<ChatEventType, HashSet<UserId>>,
    #[serde(rename = "pt", default, skip_serializing_if = "BTreeMap::is_empty")]
    active_proposal_tallies: BTreeMap<EventIndex, Tally>,
}

fn action_card_edit_is_forbidden(current: &MessageContentInternal, replacement: &MessageContentInternal) -> bool {
    matches!(current, MessageContentInternal::ActionCard(_)) || matches!(replacement, MessageContentInternal::ActionCard(_))
}

fn app_card_confirmation_is_forbidden(card: &ActionCardContentInternal, chat: Chat) -> bool {
    let has_app_binding = card.app_id.is_some() || card.app_revision.is_some();
    if has_app_binding {
        matches!(chat, Chat::Direct(_))
            || card.app_id.is_none()
            || card.app_revision.is_none()
            || !card.app_verified
            || !card.app_content_verified
    } else {
        // Old payload-bearing cards predate server-verified app provenance and authoritative route
        // resolution. Confirming them would either trust sender-carried routing or silently commit
        // without delivering the opaque action. Keep display compatibility but fail confirmation
        // closed; routing-less legacy cards retain their ordinary local confirm/cancel behavior.
        card.confirm_payload.is_some()
            || card.recipient_public_key.is_some()
            || !card.recipient_public_keys.is_empty()
            || card.inbox_canister_id.is_some()
    }
}

fn app_card_private_handoff_is_forbidden(card: &ActionCardContentInternal) -> bool {
    !card.app_verified || !card.app_content_verified
}

/// Recomputes the portable full-card commitment from authenticated message coordinates and the
/// exact raw card ingress. Sender-carried provenance/routing fields are not part of the content.
pub fn ai_app_card_content_hash_from_initial(
    user_id: UserId,
    chat: Chat,
    thread_root_message_index: Option<MessageIndex>,
    message_id: MessageId,
    app_id: types::AiAppId,
    app_revision: TimestampMillis,
    card: &types::ActionCardContentInitial,
) -> Result<[u8; 32], String> {
    types::ai_app_card_content_commitment_hash_v1(&types::AiAppCardContentCommitmentV1 {
        user_id,
        chat,
        thread_root_message_index,
        message_id,
        app_id,
        app_revision,
        content: card.into(),
    })
}

// Deliberate release gate: the attestation layer is complete, but private viewer context remains
// disabled until explicit product/user approval enables the handoff in a later change.
const AI_APP_PRIVATE_CONTEXT_DELIVERY_ENABLED: bool = false;

impl ChatEvents {
    pub fn import_events(chat: Chat, events: Vec<(EventContext, ByteBuf)>) {
        stable_memory::write_events_as_bytes(chat, events);
    }

    pub fn new_direct_chat(
        them: UserId,
        events_ttl: Option<Milliseconds>,
        anonymized_id: u128,
        now: TimestampMillis,
    ) -> ChatEvents {
        let chat = Chat::Direct(them.into());
        let mut events = ChatEvents {
            chat,
            main: ChatEventsList::new(chat, None),
            threads: BTreeMap::new(),
            metrics: ChatMetricsInternal::default(),
            per_user_metrics: BTreeMap::new(),
            frozen: false,
            events_ttl: Timestamped::new(events_ttl, now),
            expiring_events: ExpiringEvents::default(),
            last_updated_timestamps: LastUpdatedTimestamps::default(),
            video_call_in_progress: Timestamped::default(),
            anonymized_id: hex::encode(anonymized_id.to_be_bytes()),
            search_index: SearchIndex::default(),
            bot_subscriptions: BTreeMap::new(),
            active_proposal_tallies: BTreeMap::new(),
        };

        events.push_event(None, ChatEventInternal::DirectChatCreated(DirectChatCreated {}), now);

        events
    }

    pub fn new_group_chat(
        chat: MultiUserChat,
        name: String,
        description: String,
        created_by: UserId,
        events_ttl: Option<Milliseconds>,
        anonymized_id: u128,
        now: TimestampMillis,
    ) -> ChatEvents {
        let chat = chat.into();
        let mut events = ChatEvents {
            chat,
            main: ChatEventsList::new(chat, None),
            threads: BTreeMap::new(),
            metrics: ChatMetricsInternal::default(),
            per_user_metrics: BTreeMap::new(),
            frozen: false,
            events_ttl: Timestamped::new(events_ttl, now),
            expiring_events: ExpiringEvents::default(),
            last_updated_timestamps: LastUpdatedTimestamps::default(),
            video_call_in_progress: Timestamped::default(),
            anonymized_id: hex::encode(anonymized_id.to_be_bytes()),
            search_index: SearchIndex::default(),
            bot_subscriptions: BTreeMap::new(),
            active_proposal_tallies: BTreeMap::new(),
        };

        events.push_event(
            None,
            ChatEventInternal::GroupChatCreated(Box::new(GroupCreated {
                name,
                description,
                created_by,
            })),
            now,
        );

        events
    }

    pub fn chat(&self) -> Chat {
        self.chat
    }

    pub fn set_chat(&mut self, chat: Chat) {
        self.chat = chat;
        self.main.set_stable_memory_prefix(chat, None);
        for (message_index, events_list) in self.threads.iter_mut() {
            events_list.set_stable_memory_prefix(chat, Some(*message_index));
        }
    }

    pub fn read_events_as_bytes_from_stable_memory(&self, after: Option<EventContext>) -> Vec<(EventContext, ByteBuf)> {
        stable_memory::read_events_as_bytes(self.chat, after, ONE_MB as usize)
    }

    pub fn iter_recently_updated_events(
        &self,
    ) -> impl Iterator<Item = (Option<MessageIndex>, EventIndex, TimestampMillis)> + '_ {
        self.last_updated_timestamps.iter()
    }

    pub fn thread_keys(&self) -> impl Iterator<Item = MessageIndex> + '_ {
        self.threads.keys().copied()
    }

    pub fn thread_details(&self, thread_root_message_index: &MessageIndex) -> Option<GroupCanisterThreadDetails> {
        self.threads
            .get(thread_root_message_index)
            .map(|t| GroupCanisterThreadDetails {
                root_message_index: *thread_root_message_index,
                latest_event: t.latest_event_index().unwrap_or_default(),
                latest_message: t.latest_message_index().unwrap_or_default(),
                last_updated: t.latest_event_timestamp().unwrap_or_default(),
            })
    }

    pub fn push_message<P: EventPusher>(
        &mut self,
        args: PushMessageArgs,
        mut event_pusher: Option<P>,
    ) -> (EventWrapper<Message>, Option<BotNotification>) {
        let events_list = if let Some(root_message_index) = args.thread_root_message_index {
            self.threads
                .entry(root_message_index)
                .or_insert_with(|| ChatEventsList::new(self.chat, Some(root_message_index)))
        } else {
            &mut self.main
        };

        let video_call_type = if let MessageContentInternal::VideoCall(vc) = &args.content { Some(vc.call_type) } else { None };

        if let Some(event_pusher) = event_pusher.as_mut() {
            let event_payload = MessageEventPayload {
                message_type: args.content.content_type().to_string(),
                chat_type: ChatType::from(&self.chat).to_string(),
                chat_id: self.anonymized_id.clone(),
                thread: args.thread_root_message_index.is_some(),
                sender_is_bot: args.sender_is_bot,
                content_specific_payload: args.content.event_payload(),
            };

            event_pusher.push(
                EventBuilder::new("message_sent", args.now)
                    .with_user(args.sender.to_string(), true)
                    .with_source(self.chat.canister_id().to_string(), true)
                    .with_json_payload(&event_payload)
                    .build(),
            );
        }

        let message_index = events_list.next_message_index();
        let message_internal = MessageInternal {
            message_index,
            message_id: args.message_id,
            sender: args.sender,
            content: args.content,
            sender_context: args.sender_context,
            replies_to: args.replies_to,
            reactions: Vec::new(),
            tips: Tips::default(),
            last_edited: None,
            deleted_by: None,
            thread_summary: None,
            forwarded: args.forwarded,
            block_level_markdown: args.block_level_markdown,
            og_previews: args.og_previews,
        };

        add_to_metrics(
            &mut self.metrics,
            &mut self.per_user_metrics,
            args.sender,
            |m| message_internal.add_to_metrics(m),
            args.now,
        );

        let message = message_internal.clone().hydrate(Some(message_internal.sender));

        let push_event_result = self.push_event(
            args.thread_root_message_index,
            ChatEventInternal::Message(Box::new(message_internal)),
            args.now,
        );

        if let Some(root_message_index) = args.thread_root_message_index {
            let _ = self.update_thread_summary(
                root_message_index,
                |thread_summary, root_message_sender| {
                    thread_summary.mark_message_added(
                        args.sender,
                        &args.mentioned,
                        root_message_sender,
                        push_event_result.index,
                        args.now,
                    );
                    true
                },
                EventIndex::default(),
                true,
                args.now,
            );
        }

        if let Some(call_type) = video_call_type {
            if let Some(vc) = &self.video_call_in_progress.value {
                let _ = self.end_video_call(vc.message_index.into(), args.now, event_pusher);
            }

            self.video_call_in_progress = Timestamped::new(
                Some(VideoCallInternal {
                    message_index,
                    call_type,
                }),
                args.now,
            );
        }

        (
            EventWrapper {
                index: push_event_result.index,
                timestamp: args.now,
                expires_at: push_event_result.expires_at,
                event: message,
            },
            push_event_result.bot_notification,
        )
    }

    pub fn edit_message<P: EventPusher>(
        &mut self,
        args: EditMessageArgs,
        event_pusher: Option<P>,
    ) -> OCResult<EditMessageSuccess> {
        let sender = args.sender;
        let thread_root_message_index = args.thread_root_message_index;
        let now = args.now;
        let chat = self.chat;
        let anonymized_id = self.anonymized_id.clone();

        match self.update_message(
            thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            now,
            true,
            ChatEventType::MessageEdited,
            |message, event| Self::edit_message_inner(message, event, args, chat, anonymized_id, event_pusher),
        ) {
            Ok(result) => {
                let bot_notification = result.bot_notification;
                let (message_index, event, document) = result.value;
                if thread_root_message_index.is_none() {
                    self.search_index.push(message_index, sender, document);
                }

                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    sender,
                    |m| m.incr(MetricKey::Edits, 1),
                    now,
                );
                Ok(EditMessageSuccess {
                    message_index,
                    event,
                    bot_notification,
                })
            }
            Err(UpdateEventError::NoChange(Ok((message_index, event)))) => Ok(EditMessageSuccess {
                message_index,
                event,
                bot_notification: None,
            }),
            Err(UpdateEventError::NoChange(Err(e))) => Err(e),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    #[expect(clippy::type_complexity)]
    fn edit_message_inner<P: EventPusher>(
        message: &mut MessageInternal,
        event: EventMetaData,
        args: EditMessageArgs,
        chat: Chat,
        anonymized_id: String,
        mut event_pusher: Option<P>,
    ) -> Result<(MessageIndex, EventMetaData, Document), UpdateEventError<OCResult<(MessageIndex, EventMetaData)>>> {
        if message.sender != args.sender || matches!(message.content, MessageContentInternal::Deleted(_)) {
            return Err(UpdateEventError::NoChange(Err(OCErrorCode::InitiatorNotAuthorized.into())));
        }

        // ActionCards contain server-controlled provenance and response state. Allowing either an
        // existing card to be edited, or another message type to be changed into a card, would let
        // ingress replace those fields without passing the post-time provenance validation path.
        if action_card_edit_is_forbidden(&message.content, &args.content) {
            return Err(UpdateEventError::NoChange(Err(
                OCErrorCode::InvalidRequest.with_message("ActionCard messages cannot be edited")
            )));
        }

        let existing_text = message.content.text();
        let new_text = args.content.text();
        let block_level_markdown_update = args.block_level_markdown.filter(|md| *md != message.block_level_markdown);

        if new_text != existing_text || block_level_markdown_update.is_some() || args.og_previews != message.og_previews {
            let edited = new_text.map(|t| t.replace("#LINK_REMOVED", ""))
                != existing_text.map(|t| t.replace("#LINK_REMOVED", ""))
                || block_level_markdown_update.is_some();

            let old_length = message.content.text_length();
            message.content = args.content;
            message.og_previews = args.og_previews;

            let document = Document::from(&message.content);

            if edited {
                if let Some(block_level_markdown) = block_level_markdown_update {
                    message.block_level_markdown = block_level_markdown;
                }

                let already_edited = message.last_edited.is_some();
                message.last_edited = Some(args.now);

                if args.finalise_bot_message
                    && let Some(bot_context) = message.bot_context_mut()
                {
                    bot_context.finalised = true;
                }

                if let Some(event_pusher) = event_pusher.as_mut() {
                    let new_length = message.content.text_length();
                    let payload = MessageEditedEventPayload {
                        message_type: message.content.content_type().to_string(),
                        chat_type: ChatType::from(&chat).to_string(),
                        chat_id: anonymized_id,
                        thread: args.thread_root_message_index.is_some(),
                        already_edited,
                        old_length,
                        new_length,
                    };

                    event_pusher.push(
                        EventBuilder::new("message_edited", args.now)
                            .with_user(args.sender.to_string(), true)
                            .with_source(chat.canister_id().to_string(), true)
                            .with_json_payload(&payload)
                            .build(),
                    );
                }
            }
            return Ok((message.message_index, event, document));
        }

        Err(UpdateEventError::NoChange(Ok((message.message_index, event))))
    }

    pub fn last_updated(&self) -> Option<TimestampMillis> {
        max(
            self.main.latest_event_timestamp(),
            self.iter_recently_updated_events().next().map(|(_, _, ts)| ts),
        )
    }

    pub fn delete_messages(&mut self, args: DeleteUndeleteMessagesArgs) -> Vec<(MessageId, OCResult<DeleteMessageSuccess>)> {
        args.iter()
            .map(|delete_message_args| (delete_message_args.message_id, self.delete_message(delete_message_args)))
            .collect()
    }

    pub fn undelete_messages(
        &mut self,
        args: DeleteUndeleteMessagesArgs,
    ) -> Vec<(MessageId, OCResult<Option<BotNotification>>)> {
        args.iter()
            .map(|undelete_message_args| (undelete_message_args.message_id, self.undelete_message(undelete_message_args)))
            .collect()
    }

    fn delete_message(&mut self, args: DeleteUndeleteMessageArgs) -> OCResult<DeleteMessageSuccess> {
        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessageDeleted,
            |message, _| Self::delete_message_inner(message, &args),
        ) {
            Ok(result) => {
                let (sender, message_index) = result.value;

                if sender != args.caller {
                    add_to_metrics(
                        &mut self.metrics,
                        &mut self.per_user_metrics,
                        sender,
                        |m| m.incr(MetricKey::ReportedMessages, 1),
                        args.now,
                    );
                }
                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    args.caller,
                    |m| m.incr(MetricKey::DeletedMessages, 1),
                    args.now,
                );
                if args.thread_root_message_index.is_none() {
                    self.search_index.remove(message_index);
                }
                Ok(DeleteMessageSuccess {
                    sender,
                    bot_notification: result.bot_notification,
                })
            }
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn delete_message_inner(
        message: &mut MessageInternal,
        args: &DeleteUndeleteMessageArgs,
    ) -> Result<(UserId, MessageIndex), UpdateEventError<OCErrorCode>> {
        if message.sender == args.caller || args.is_admin {
            if message.deleted_by.is_some() || matches!(message.content, MessageContentInternal::Deleted(_)) {
                Err(UpdateEventError::NoChange(OCErrorCode::NoChange))
            } else if matches!(message.content, MessageContentInternal::VideoCall(ref c) if c.ended.is_none()) {
                Err(UpdateEventError::NoChange(OCErrorCode::InitiatorNotAuthorized))
            } else {
                let sender = message.sender;
                message.deleted_by = Some(DeletedByInternal {
                    deleted_by: args.caller,
                    timestamp: args.now,
                });
                Ok((sender, message.message_index))
            }
        } else {
            Err(UpdateEventError::NoChange(OCErrorCode::InitiatorNotAuthorized))
        }
    }

    fn undelete_message(&mut self, args: DeleteUndeleteMessageArgs) -> OCResult<Option<BotNotification>> {
        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessageDeleted,
            |message, _| Self::undelete_message_inner(message, &args),
        ) {
            Ok(result) => {
                let (sender, message_index, document) = result.value;
                if sender != args.caller {
                    add_to_metrics(
                        &mut self.metrics,
                        &mut self.per_user_metrics,
                        sender,
                        |m| m.decr(MetricKey::ReportedMessages, 1),
                        args.now,
                    );
                }
                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    args.caller,
                    |m| m.decr(MetricKey::DeletedMessages, 1),
                    args.now,
                );
                if args.thread_root_message_index.is_none() {
                    self.search_index.push(message_index, sender, document);
                }
                Ok(result.bot_notification)
            }
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn undelete_message_inner(
        message: &mut MessageInternal,
        args: &DeleteUndeleteMessageArgs,
    ) -> Result<(UserId, MessageIndex, Document), UpdateEventError<OCErrorCode>> {
        let Some(deleted_by) = message.deleted_by.as_ref().map(|db| db.deleted_by) else {
            return Err(UpdateEventError::NoChange(OCErrorCode::NoChange));
        };

        if deleted_by == args.caller || (args.is_admin && message.sender != deleted_by) {
            match message.content {
                MessageContentInternal::Deleted(_) => Err(UpdateEventError::NoChange(OCErrorCode::MessageHardDeleted)),
                MessageContentInternal::Crypto(_) => Err(UpdateEventError::NoChange(OCErrorCode::InvalidMessageType)),
                _ => {
                    let sender = message.sender;
                    message.deleted_by = None;
                    Ok((sender, message.message_index, Document::from(&message.content)))
                }
            }
        } else {
            Err(UpdateEventError::NoChange(OCErrorCode::InitiatorNotAuthorized))
        }
    }

    // The UserId returned is the message sender
    pub fn remove_deleted_message_content(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        now: TimestampMillis,
    ) -> Option<(MessageContentInternal, UserId)> {
        if let Ok((content, sender)) = self
            .update_message(
                thread_root_message_index,
                message_id.into(),
                EventIndex::default(),
                now,
                false,
                ChatEventType::MessageDeleted,
                |message, _| Self::remove_deleted_message_content_inner(message),
            )
            .map(|r| r.value)
        {
            Some((content, sender))
        } else {
            None
        }
    }

    fn remove_deleted_message_content_inner(
        message: &mut MessageInternal,
    ) -> Result<(MessageContentInternal, UserId), UpdateEventError> {
        let Some(deleted_by) = message.deleted_by.clone() else {
            return Err(UpdateEventError::NoChange(()));
        };

        let content = std::mem::replace(&mut message.content, MessageContentInternal::Deleted(deleted_by));
        let sender = message.sender;

        Ok((content, sender))
    }

    pub fn register_poll_vote(
        &mut self,
        args: RegisterPollVoteArgs,
    ) -> OCResult<UpdateMessageSuccess<RegisterPollVoteSuccess>> {
        match self.update_message(
            args.thread_root_message_index,
            args.message_index.into(),
            args.min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessagePollVote,
            |message, _| Self::register_poll_vote_inner(message, &args),
        ) {
            Ok(result) => {
                if result.value.updated {
                    match args.operation {
                        VoteOperation::RegisterVote => {
                            if !result.value.existing_vote_removed {
                                add_to_metrics(
                                    &mut self.metrics,
                                    &mut self.per_user_metrics,
                                    args.user_id,
                                    |m| m.incr(MetricKey::PollVotes, 1),
                                    args.now,
                                );
                            }
                        }
                        VoteOperation::DeleteVote => {
                            add_to_metrics(
                                &mut self.metrics,
                                &mut self.per_user_metrics,
                                args.user_id,
                                |m| m.decr(MetricKey::PollVotes, 1),
                                args.now,
                            );
                        }
                    }
                }
                Ok(result)
            }
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::PollNotFound.into()),
        }
    }

    fn register_poll_vote_inner(
        message: &mut MessageInternal,
        args: &RegisterPollVoteArgs,
    ) -> Result<RegisterPollVoteSuccess, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::Poll(p) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        let result = p.register_vote(args.user_id, args.option_index, args.operation);

        match result {
            RegisterVoteResult::Success(existing_vote_removed) => Ok(RegisterPollVoteSuccess {
                poll_creator: message.sender,
                votes: p.votes(Some(args.user_id)),
                existing_vote_removed,
                updated: true,
            }),
            RegisterVoteResult::SuccessNoChange => Ok(RegisterPollVoteSuccess {
                poll_creator: message.sender,
                votes: p.votes(Some(args.user_id)),
                existing_vote_removed: false,
                updated: false,
            }),
            RegisterVoteResult::PollEnded => Err(UpdateEventError::NoChange(OCErrorCode::PollEnded)),
            RegisterVoteResult::OptionIndexOutOfRange => Err(UpdateEventError::NoChange(OCErrorCode::PollOptionNotFound)),
            RegisterVoteResult::UserCannotChangeVote => Err(UpdateEventError::NoChange(OCErrorCode::CannotChangeVote)),
        }
    }

    // Records a human's Confirm/Cancel response to an interactive ActionCard. On a state transition the
    // message is marked updated (so clients re-render) and, via `update_message`, a bot notification of
    // the updated event is generated for subscribed bots — the authenticated forward of the card (incl.
    // its `payload`) to the integration's endpoint. Idempotent: a no-op response yields `NoChange`.
    pub fn respond_to_action_card(
        &mut self,
        args: RespondToActionCardArgs,
    ) -> OCResult<UpdateMessageSuccess<RespondToActionCardResult>> {
        let chat = self.chat;
        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessageActionCardResponse,
            |message, _| Self::respond_to_action_card_inner(message, &args, chat),
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    /// Returns the immutable server-side fields needed to mint an app-card capability. This is a
    /// read-only operation and deliberately requires the server-only provenance bearer; legacy or
    /// raw-posted cards with copied app identifiers fail closed.
    pub fn ai_app_card_capability_source(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult<AiAppCardCapabilitySource> {
        self.ai_app_card_attested_source(thread_root_message_index, message_id, min_visible_event_index, now, true)
    }

    pub fn ai_app_card_confirmation_source(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult<AiAppCardCapabilitySource> {
        self.ai_app_card_attested_source(thread_root_message_index, message_id, min_visible_event_index, now, false)
    }

    pub fn ai_app_card_confirmation_reservation_source(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        user_id: UserId,
        confirmation_lease_generation: u64,
        confirm_payload_hash: [u8; 32],
        now: TimestampMillis,
    ) -> OCResult<AiAppCardCapabilitySource> {
        let source =
            self.ai_app_card_confirmation_source(thread_root_message_index, message_id, min_visible_event_index, now)?;
        let Some((message, _)) = self.message_internal(min_visible_event_index, thread_root_message_index, message_id.into())
        else {
            return Err(OCErrorCode::MessageNotFound.into());
        };
        let MessageContentInternal::ActionCard(card) = message.content else {
            return Err(OCErrorCode::MessageNotFound.into());
        };
        if card.confirmation_reserved_by != Some(user_id)
            || card.confirmation_lease_generation != confirmation_lease_generation
            || card.confirmation_payload_hash != Some(confirm_payload_hash)
        {
            return Err(OCErrorCode::NoChange.into());
        }
        Ok(source)
    }

    fn ai_app_card_attested_source(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
        require_private_delivery_enabled: bool,
    ) -> OCResult<AiAppCardCapabilitySource> {
        let Some((message, _)) = self.message_internal(min_visible_event_index, thread_root_message_index, message_id.into())
        else {
            return Err(OCErrorCode::MessageNotFound.into());
        };
        let MessageContentInternal::ActionCard(card) = message.content else {
            return Err(OCErrorCode::MessageNotFound.into());
        };
        if !matches!(card.state, ActionCardState::Pending) || card.is_expired(now) {
            return Err(OCErrorCode::NoChange.into());
        }
        let (Some(app_id), Some(app_revision)) = (card.app_id, card.app_revision) else {
            return Err(OCErrorCode::InvalidRequest.with_message("card has no verified app provenance"));
        };
        if app_card_private_handoff_is_forbidden(&card) {
            return Err(OCErrorCode::InvalidRequest.with_message("card content is not fully attested"));
        }
        if require_private_delivery_enabled && !AI_APP_PRIVATE_CONTEXT_DELIVERY_ENABLED {
            return Err(OCErrorCode::InvalidRequest.with_message("private app-card context delivery is not enabled"));
        }
        let Some(content_hash) = card.app_content_hash else {
            return Err(OCErrorCode::InvalidRequest.with_message("card has no canonical content commitment"));
        };
        if card.action_id.is_empty() {
            return Err(OCErrorCode::InvalidRequest.with_message("card has no app action id"));
        }
        Ok(AiAppCardCapabilitySource {
            app_id,
            app_revision,
            action_id: card.action_id,
            content_hash,
        })
    }

    fn respond_to_action_card_inner(
        message: &mut MessageInternal,
        args: &RespondToActionCardArgs,
        chat: Chat,
    ) -> Result<RespondToActionCardResult, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::ActionCard(card) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if matches!(args.response, ActionCardResponse::Confirm) {
            if app_card_confirmation_is_forbidden(card, chat) {
                return Err(UpdateEventError::NoChange(OCErrorCode::InvalidRequest));
            }
        }

        let changed = match args.response {
            ActionCardResponse::Confirm => card.confirm(args.user_id, args.now),
            ActionCardResponse::Cancel => card.cancel(args.user_id, args.now),
        };

        if !changed {
            return Err(UpdateEventError::NoChange(OCErrorCode::NoChange));
        }

        // Legacy synchronous path retained for cards without the current app-provenance contract.
        let recipient_keys = card.all_recipient_keys();
        let deposit = match (
            matches!(args.response, ActionCardResponse::Confirm) && !recipient_keys.is_empty(),
            &card.confirm_payload,
        ) {
            (true, Some(confirm_payload)) => Some(ActionCardDeposit {
                app_id: card.app_id,
                app_revision: card.app_revision,
                app_verified: card.app_verified,
                action_id: card.action_id.clone(),
                recipient_public_keys: recipient_keys,
                confirm_payload: confirm_payload.clone(),
                confirm_payload_hash: types::ai_app_card_confirm_payload_hash_v1(confirm_payload)
                    .expect("bounded stored action payload must hash"),
                responded_at: args.now,
                message_id: args.message_id,
                thread_root_message_index: args.thread_root_message_index,
                confirmed_by: args.user_id,
                content_hash: card.app_content_hash,
                confirmation_lease_generation: card.confirmation_lease_generation,
                inbox_canister_id: card.inbox_canister_id.clone(),
            }),
            _ => None,
        };

        Ok(RespondToActionCardResult {
            state: card.state.clone(),
            deposit,
        })
    }

    // Two-phase confirm, reservation side: atomically leases a currently Pending, unexpired card
    // that carries an opaque confirm payload, then returns its immutable deposit instruction without
    // committing the visible response.
    // The canister deposits first and only commits `Confirmed` once the deposit is stored (see the
    // `respond_to_action_card` handlers), so a failed deposit leaves the card Pending (retryable)
    // instead of a Confirmed-but-undelivered card. Returns None for every other case (message not
    // found / not an action card / expired / already responded / no routing); the caller then falls
    // back to the normal `respond_to_action_card` commit, which handles those exactly as before (a
    // routing-less confirm commits with no deposit; an expired/non-pending card yields the usual
    // NoChange/expiry outcome).
    pub fn reserve_action_card_confirm(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        user_id: UserId,
        requested_confirm_payload_hash: Option<[u8; 32]>,
        now: TimestampMillis,
    ) -> OCResult<Option<ActionCardDeposit>> {
        let chat = self.chat;
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            min_visible_event_index,
            now,
            false,
            ChatEventType::MessageActionCardResponse,
            |message, _| {
                let MessageContentInternal::ActionCard(card) = &mut message.content else {
                    return Err(UpdateEventError::NotFound);
                };
                if app_card_confirmation_is_forbidden(card, chat) {
                    return Err(UpdateEventError::NoChange(OCErrorCode::InvalidRequest));
                }
                // A routing-less legacy card has no external side effect and can use the ordinary
                // synchronous state transition. Payload/routing-bearing legacy cards were rejected
                // above because there is no trusted app contract to deliver them safely.
                if card.app_id.is_none() && card.app_revision.is_none() {
                    return Ok(None);
                }
                let Some(confirm_payload) = card.confirm_payload.clone() else {
                    return Ok(None);
                };
                let recipient_keys = card.all_recipient_keys();
                let stored_payload_hash = types::ai_app_card_confirm_payload_hash_v1(&confirm_payload)
                    .map_err(|_| UpdateEventError::NoChange(OCErrorCode::InvalidRequest))?;
                let confirm_payload_hash = requested_confirm_payload_hash.unwrap_or(stored_payload_hash);
                if !card.reserve_confirmation(user_id, confirm_payload_hash, now) {
                    return Err(UpdateEventError::NoChange(OCErrorCode::NoChange));
                }
                Ok(Some(ActionCardDeposit {
                    app_id: card.app_id,
                    app_revision: card.app_revision,
                    app_verified: card.app_verified,
                    action_id: card.action_id.clone(),
                    recipient_public_keys: recipient_keys,
                    confirm_payload,
                    confirm_payload_hash,
                    responded_at: card
                        .confirmation_reserved_at
                        .expect("a successful confirmation reservation must retain its original timestamp"),
                    message_id,
                    thread_root_message_index,
                    confirmed_by: user_id,
                    content_hash: card.app_content_hash,
                    confirmation_lease_generation: card.confirmation_lease_generation,
                    inbox_canister_id: card.inbox_canister_id,
                }))
            },
        ) {
            Ok(result) => Ok(result.value),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    /// Commits a previously reserved confirmation and emits the normal message update notification.
    pub fn complete_action_card_confirm(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        user_id: UserId,
        confirmation_lease_generation: u64,
        confirm_payload_hash: [u8; 32],
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess<RespondToActionCardResult>> {
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            min_visible_event_index,
            now,
            true,
            ChatEventType::MessageActionCardResponse,
            |message, _| {
                let MessageContentInternal::ActionCard(card) = &mut message.content else {
                    return Err(UpdateEventError::NotFound);
                };
                if !card.complete_confirmation_for_lease(user_id, confirmation_lease_generation, confirm_payload_hash, now) {
                    return Err(UpdateEventError::NoChange(OCErrorCode::NoChange));
                }
                Ok(RespondToActionCardResult {
                    state: card.state.clone(),
                    deposit: None,
                })
            },
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    /// Releases the caller's reservation after a failed outbound delivery.
    pub fn abort_action_card_confirm(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        user_id: UserId,
        now: TimestampMillis,
    ) -> OCResult {
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            min_visible_event_index,
            now,
            false,
            ChatEventType::MessageActionCardResponse,
            |message, _| {
                let MessageContentInternal::ActionCard(card) = &mut message.content else {
                    return Err(UpdateEventError::NotFound);
                };
                if card.abort_confirmation(user_id) {
                    Ok(())
                } else {
                    Err(UpdateEventError::NoChange(OCErrorCode::NoChange))
                }
            },
        ) {
            Ok(_) => Ok(()),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    /// Applies an action-card state change decided on ANOTHER canister. The two copies of a
    /// direct chat live on the two participants' canisters: the responder's canister runs the real
    /// transition (and emits the deposit); the other copy mirrors the outcome through this —
    /// APPLY-ONLY, gated on the local copy still being Pending, and it NEVER emits a deposit, so
    /// exactly one deposit exists per human response no matter how events interleave.
    pub fn apply_action_card_state(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        new_state: ActionCardState,
        responded_by: UserId,
        responded_at: TimestampMillis,
        now: TimestampMillis,
    ) -> OCResult {
        let chat = self.chat;
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageActionCardResponse,
            |message, _| {
                let MessageContentInternal::ActionCard(card) = &mut message.content else {
                    return Err(UpdateEventError::NotFound);
                };
                if matches!(new_state, ActionCardState::Confirmed) && app_card_confirmation_is_forbidden(card, chat) {
                    return Err(UpdateEventError::NoChange(OCErrorCode::InvalidRequest));
                }
                if !matches!(card.state, ActionCardState::Pending) {
                    return Err(UpdateEventError::NoChange(OCErrorCode::NoChange));
                }
                card.state = new_state.clone();
                card.responded_by = Some(responded_by);
                card.responded_at = Some(responded_at);
                Ok(())
            },
        ) {
            Ok(_) => Ok(()),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    pub fn end_poll(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_index: MessageIndex,
        now: TimestampMillis,
    ) -> EndPollResult {
        use EndPollResult::*;

        match self.update_message(
            thread_root_message_index,
            message_index.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessagePollEnded,
            |message, _| Self::end_poll_inner(message),
        ) {
            Ok(result) => Success(Box::new(result)),
            Err(UpdateEventError::NoChange(_)) => UnableToEndPoll,
            Err(UpdateEventError::NotFound) => PollNotFound,
        }
    }

    fn end_poll_inner(message: &mut MessageInternal) -> Result<(), UpdateEventError> {
        let MessageContentInternal::Poll(p) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if !p.ended && p.config.end_date.is_some() {
            p.ended = true;
            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn final_payments(&mut self, message_index: MessageIndex, now_nanos: TimestampNanos) -> Vec<PendingCryptoTransaction> {
        self.update_message(
            None,
            message_index.into(),
            EventIndex::default(),
            now_nanos / 1_000_000,
            false,
            ChatEventType::MessageOther,
            |message, _| Self::final_payments_inner(message, now_nanos),
        )
        .ok()
        .map(|r| r.value)
        .unwrap_or_default()
    }

    fn final_payments_inner(
        message: &mut MessageInternal,
        now_nanos: TimestampNanos,
    ) -> Result<Vec<PendingCryptoTransaction>, UpdateEventError> {
        let MessageContentInternal::Prize(p) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        Ok(p.final_payments(message.sender, now_nanos))
    }

    pub fn record_proposal_vote(
        &mut self,
        user_id: UserId,
        min_visible_event_index: EventIndex,
        message_index: MessageIndex,
        adopt: bool,
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess> {
        match self.update_message(
            None,
            message_index.into(),
            min_visible_event_index,
            now,
            false,
            ChatEventType::MessageOther,
            |message, _| Self::record_proposal_vote_inner(message, user_id, adopt),
        ) {
            Ok(success) => Ok(success),
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::PollNotFound.into()),
        }
    }

    fn record_proposal_vote_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        adopt: bool,
    ) -> Result<(), UpdateEventError<bool>> {
        let MessageContentInternal::GovernanceProposal(proposal) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        match proposal.votes.entry(user_id) {
            Vacant(e) => {
                // We choose not to update the `last_updated` field on the message here because
                // the update is private, only visible to the current user, and updating the
                // field would cause the message to be returned to all users unnecessarily.
                e.insert(adopt);
                Ok(())
            }
            Occupied(e) => Err(UpdateEventError::NoChange(*e.get())),
        }
    }

    pub fn update_proposals(&mut self, user_id: UserId, updates: Vec<ProposalUpdate>, now: TimestampMillis) -> bool {
        let mut mark_chat_updated = false;
        for update in updates {
            // If only the tally has been updated, skip marking the message as having been updated
            let should_mark_updated = update.deadline.is_some() || update.reward_status.is_some() || update.status.is_some();
            let tally_update = update.latest_tally.clone();

            if let Ok(success) = self.update_message(
                None,
                update.message_id.into(),
                EventIndex::default(),
                now,
                should_mark_updated,
                ChatEventType::MessageOther,
                |message, _| Self::update_proposal_inner(message, user_id, update, now),
            ) {
                if !matches!(success.value, ProposalRewardStatus::AcceptVotes) {
                    self.active_proposal_tallies.remove(&success.event_index);
                } else if let Some(tally) = tally_update {
                    self.active_proposal_tallies.insert(success.event_index, tally);
                }
                if should_mark_updated {
                    mark_chat_updated = true;
                }
            }
        }
        mark_chat_updated
    }

    fn update_proposal_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        update: ProposalUpdate,
        now: TimestampMillis,
    ) -> Result<ProposalRewardStatus, UpdateEventError> {
        if message.sender == user_id
            && let MessageContentInternal::GovernanceProposal(p) = &mut message.content
        {
            p.proposal.update_status(update.into(), now);
            return Ok(p.proposal.reward_status());
        }
        Err(UpdateEventError::NotFound)
    }

    pub fn active_proposal_tallies(&self) -> Vec<(EventIndex, Tally)> {
        self.active_proposal_tallies
            .iter()
            .map(|(idx, tally)| (*idx, tally.clone()))
            .collect()
    }

    pub fn add_reaction<P: EventPusher>(
        &mut self,
        args: AddRemoveReactionArgs,
        event_pusher: Option<P>,
    ) -> OCResult<UpdateMessageSuccess<MessageInternal>> {
        if !args.reaction.is_valid() {
            return Err(OCErrorCode::InvalidReaction.with_message(format!("{:?}", args.reaction)));
        }

        let user_id = args.user_id;
        let now = args.now;
        let chat = self.chat;
        let anonymized_id = self.anonymized_id.clone();

        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            now,
            true,
            ChatEventType::MessageReaction,
            |message, _| Self::add_reaction_inner(message, args, chat, anonymized_id, event_pusher),
        ) {
            Ok(result) => {
                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    user_id,
                    |m| m.incr(MetricKey::Reactions, 1),
                    now,
                );
                Ok(result)
            }
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn add_reaction_inner<P: EventPusher>(
        message: &mut MessageInternal,
        args: AddRemoveReactionArgs,
        chat: Chat,
        anonymized_id: String,
        mut event_pusher: Option<P>,
    ) -> Result<MessageInternal, UpdateEventError> {
        let added = if let Some((_, users)) = message.reactions.iter_mut().find(|(r, _)| *r == args.reaction) {
            users.insert(args.user_id)
        } else {
            message
                .reactions
                .push((args.reaction, vec![args.user_id].into_iter().collect()));
            true
        };

        if !added {
            return Err(UpdateEventError::NoChange(()));
        }

        if let Some(event_pusher) = event_pusher.as_mut() {
            let payload = ReactionAddedEventPayload {
                message_type: message.content.content_type().to_string(),
                chat_type: ChatType::from(&chat).to_string(),
                chat_id: anonymized_id.clone(),
                thread: args.thread_root_message_index.is_some(),
            };

            event_pusher.push(
                EventBuilder::new("reaction_added", args.now)
                    .with_user(args.user_id.to_string(), true)
                    .with_source(chat.canister_id().to_string(), true)
                    .with_json_payload(&payload)
                    .build(),
            );
        }

        Ok(message.clone())
    }

    pub fn remove_reaction(&mut self, args: AddRemoveReactionArgs) -> OCResult<UpdateMessageSuccess> {
        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            args.min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessageReaction,
            |message, _| Self::remove_reaction_inner(message, &args),
        ) {
            Ok(result) => {
                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    args.user_id,
                    |m| m.decr(MetricKey::Reactions, 1),
                    args.now,
                );
                Ok(result)
            }
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn remove_reaction_inner(message: &mut MessageInternal, args: &AddRemoveReactionArgs) -> Result<(), UpdateEventError> {
        let (removed, is_empty) = message
            .reactions
            .iter_mut()
            .find(|(r, _)| *r == args.reaction)
            .map(|(_, u)| (u.remove(&args.user_id), u.is_empty()))
            .unwrap_or_default();

        if !removed {
            return Err(UpdateEventError::NoChange(()));
        }

        if is_empty {
            message.reactions.retain(|(_, u)| !u.is_empty());
        }

        Ok(())
    }

    pub fn tip_message<P: EventPusher>(
        &mut self,
        args: TipMessageArgs,
        min_visible_event_index: EventIndex,
        event_pusher: Option<P>,
    ) -> OCResult<UpdateMessageSuccess> {
        let chat = self.chat;
        let anonymized_id = self.anonymized_id.clone();

        match self.update_message(
            args.thread_root_message_index,
            args.message_id.into(),
            min_visible_event_index,
            args.now,
            true,
            ChatEventType::MessageTipped,
            |message, _| Self::tip_message_inner(message, &args, chat, anonymized_id, event_pusher),
        ) {
            Ok(result) => {
                add_to_metrics(
                    &mut self.metrics,
                    &mut self.per_user_metrics,
                    args.user_id,
                    |m| m.incr(MetricKey::Tips, 1),
                    args.now,
                );
                Ok(result)
            }
            Err(UpdateEventError::NoChange(result)) => Err(result),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn tip_message_inner<P: EventPusher>(
        message: &mut MessageInternal,
        args: &TipMessageArgs,
        chat: Chat,
        anonymized_id: String,
        mut event_pusher: Option<P>,
    ) -> Result<(), UpdateEventError<OCError>> {
        if message.sender == args.user_id {
            return Err(UpdateEventError::NoChange(OCErrorCode::CannotTipSelf.into()));
        }
        if message.sender != args.recipient {
            error!(
                user = %args.user_id,
                recipient = %args.recipient,
                sender = %message.sender,
                message_index = ?message.message_index,
                message_id = ?message.message_id,
                "Tip failed due to recipient mismatch"
            );
            return Err(UpdateEventError::NoChange(OCErrorCode::RecipientMismatch.into()));
        }

        message.tips.push(args.ledger, args.user_id, args.amount);

        if let Some(event_pusher) = event_pusher.as_mut() {
            let message_type = message.content.content_type().to_string();

            event_pusher.push(
                EventBuilder::new("message_tipped", args.now)
                    .with_user(args.user_id.to_string(), true)
                    .with_source(chat.canister_id().to_string(), true)
                    .with_json_payload(&MessageTippedEventPayload {
                        message_type,
                        chat_type: ChatType::from(&chat).to_string(),
                        chat_id: anonymized_id.clone(),
                        thread: args.thread_root_message_index.is_some(),
                        token: args.token_symbol.clone(),
                        amount: args.amount,
                    })
                    .build(),
            );
        }

        Ok(())
    }

    #[expect(clippy::too_many_arguments)]
    pub fn reserve_prize(
        &mut self,
        user_id: UserId,
        min_visible_event_index: EventIndex,
        message_id: MessageId,
        now: TimestampMillis,
        is_unique_person: bool,
        diamond_status: DiamondMembershipStatus,
        total_chit_earned: u32,
        streak: u16,
        streak_ends: TimestampMillis,
        user_reauthenticated: bool,
    ) -> OCResult<ReservePrizeSuccess> {
        match self.update_message(
            None,
            message_id.into(),
            min_visible_event_index,
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| {
                Self::reserve_prize_inner(
                    message,
                    user_id,
                    now,
                    is_unique_person,
                    diamond_status,
                    total_chit_earned,
                    streak,
                    streak_ends,
                    user_reauthenticated,
                )
            },
        ) {
            Ok(result) => Ok(result.value),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::PrizeNotFound.into()),
        }
    }

    #[expect(clippy::too_many_arguments)]
    fn reserve_prize_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        now: TimestampMillis,
        is_unique_person: bool,
        diamond_status: DiamondMembershipStatus,
        total_chit_earned: u32,
        streak: u16,
        streak_ends: TimestampMillis,
        user_reauthenticated: bool,
    ) -> Result<ReservePrizeSuccess, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::Prize(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if content.streak_only > 0 && (streak < content.streak_only || streak_ends < now) {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.diamond_only && diamond_status == DiamondMembershipStatus::Inactive {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.lifetime_diamond_only && diamond_status != DiamondMembershipStatus::Lifetime {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.unique_person_only && !is_unique_person {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.min_chit_earned > total_chit_earned {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.requires_captcha && !user_reauthenticated {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeUserNotElligible));
        }

        if content.end_date < now {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeEnded));
        }

        if content.prizes_remaining.is_empty() {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeFullyClaimed));
        }

        if content.winners.contains(&user_id) || content.reservations.contains(&user_id) {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeAlreadyClaimed));
        }

        if content.ledger_error {
            return Err(UpdateEventError::NoChange(OCErrorCode::PrizeLedgerError));
        }

        // Pop the last prize and reserve it
        let amount = content.prizes_remaining.pop().expect("some prizes_remaining");
        let ledger_canister_id = content.transaction.ledger_canister_id();
        let fee = content.transaction.fee();

        content.reservations.insert(user_id);

        Ok(ReservePrizeSuccess {
            token_symbol: content.transaction.token_symbol().to_string(),
            ledger_canister_id,
            amount,
            fee,
            message_index: message.message_index,
        })
    }

    pub fn claim_prize<P: EventPusher>(
        &mut self,
        message_id: MessageId,
        winner: UserId,
        transaction: CompletedCryptoTransaction,
        new_message_id: MessageId,
        event_pusher: P,
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess<MessageIndex>> {
        let amount = transaction.units();

        match self.update_message(
            None,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessagePrizeClaim,
            |message, _| Self::claim_prize_inner(message, winner, amount),
        ) {
            Ok(result) => {
                let message_index = result.value;
                // Push a PrizeWinnerContent message to the group from the OpenChatBot
                self.push_message(
                    PushMessageArgs {
                        sender: OPENCHAT_BOT_USER_ID,
                        thread_root_message_index: Some(message_index),
                        message_id: new_message_id,
                        content: MessageContentInternal::PrizeWinner(PrizeWinnerContentInternal {
                            winner,
                            ledger: transaction.ledger_canister_id(),
                            token_symbol: transaction.token_symbol().to_string(),
                            amount,
                            fee: transaction.fee(),
                            block_index: transaction.index(),
                            prize_message: message_index,
                        }),
                        sender_context: None,
                        mentioned: Vec::new(),
                        replies_to: None,
                        forwarded: false,
                        sender_is_bot: true,
                        block_level_markdown: false,
                        og_previews: Vec::new(),
                        now,
                    },
                    Some(event_pusher),
                );
                Ok(result)
            }
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn claim_prize_inner(
        message: &mut MessageInternal,
        winner: UserId,
        amount: u128,
    ) -> Result<MessageIndex, UpdateEventError> {
        let MessageContentInternal::Prize(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        // Remove the reservation
        if content.reservations.remove(&winner) {
            // Add the user to winners list
            content.winners.insert(winner);
            content.prizes_paid += amount;
            Ok(message.message_index)
        } else {
            Err(UpdateEventError::NotFound)
        }
    }

    pub fn unreserve_prize(
        &mut self,
        message_id: MessageId,
        user_id: UserId,
        amount: u128,
        ledger_error: bool,
        now: TimestampMillis,
    ) -> OCResult {
        match self.update_message(
            None,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::unreserve_prize_inner(message, user_id, amount, ledger_error),
        ) {
            Ok(_) => Ok(()),
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn unreserve_prize_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        amount: u128,
        ledger_error: bool,
    ) -> Result<(), UpdateEventError> {
        let MessageContentInternal::Prize(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if ledger_error {
            content.ledger_error = true;
        }

        // Remove the reservation
        if content.reservations.remove(&user_id) {
            // Put the prize back
            content.prizes_remaining.push(amount);
            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn pending_prize_messages(&self, date_cutoff: TimestampMillis) -> Vec<(MessageId, PrizeContentInternal)> {
        self.main
            .iter(None, false, EventIndex::default(), None)
            .filter_map(|e| e.into_event())
            .take_while(|e| e.timestamp > date_cutoff)
            .filter_map(|e| e.event.into_message())
            .filter_map(|m| {
                if let MessageContentInternal::Prize(p) = &m.content {
                    Some((m.message_id, p.clone()))
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn reduce_final_prize_by_transfer_fee(&mut self, message_id: MessageId, now: TimestampMillis) -> bool {
        self.update_message(
            None,
            message_id.into(),
            EventIndex::default(),
            now,
            false,
            ChatEventType::MessageOther,
            |message, _| Self::reduce_final_prize_by_transfer_fee_inner(message),
        )
        .is_ok()
    }

    fn reduce_final_prize_by_transfer_fee_inner(message: &mut MessageInternal) -> Result<(), UpdateEventError> {
        let MessageContentInternal::Prize(p) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if !p.prizes_remaining.is_empty() {
            let last = p.prizes_remaining.remove(0);
            p.prizes_remaining.insert(0, last.saturating_sub(p.transaction.fee()));
            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn get_p2p_swap(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
    ) -> Option<P2PSwapContent> {
        self.message_internal(min_visible_event_index, thread_root_message_index, message_id.into())
            .and_then(|(m, _)| if let MessageContentInternal::P2PSwap(p) = m.content { Some(p.into()) } else { None })
    }

    pub fn reserve_p2p_swap(
        &mut self,
        user_id: UserId,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult<ReserveP2PSwapSuccess> {
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            min_visible_event_index,
            now,
            true,
            ChatEventType::MessageOther,
            |message, event| Self::reserve_p2p_swap_inner(message, event.timestamp, user_id, now),
        ) {
            Ok(result) => Ok(result.value),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::SwapNotFound.into()),
        }
    }

    fn reserve_p2p_swap_inner(
        message: &mut MessageInternal,
        message_timestamp: TimestampMillis,
        user_id: UserId,
        now: TimestampMillis,
    ) -> Result<ReserveP2PSwapSuccess, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::P2PSwap(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if content.reserve(user_id, now) {
            Ok(ReserveP2PSwapSuccess {
                content: content.clone().into(),
                created: message_timestamp,
                created_by: message.sender,
            })
        } else {
            Err(UpdateEventError::NoChange(content.status.error_code()))
        }
    }

    pub fn accept_p2p_swap(
        &mut self,
        user_id: UserId,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        token1_txn_in: u64,
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess<P2PSwapAccepted>> {
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::accept_p2p_swap_inner(message, user_id, token1_txn_in),
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::SwapNotFound.into()),
        }
    }

    fn accept_p2p_swap_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        token1_txn_in: u64,
    ) -> Result<P2PSwapAccepted, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::P2PSwap(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if content.accept(user_id, token1_txn_in) {
            Ok(P2PSwapAccepted {
                accepted_by: user_id,
                token1_txn_in,
            })
        } else {
            Err(UpdateEventError::NoChange(content.status.error_code()))
        }
    }

    #[expect(clippy::too_many_arguments)]
    pub fn complete_p2p_swap<P: EventPusher>(
        &mut self,
        user_id: UserId,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        token0_txn_out: u64,
        token1_txn_out: u64,
        now: TimestampMillis,
        event_pusher: P,
    ) -> OCResult<UpdateMessageSuccess<P2PSwapCompleted>> {
        let chat = self.chat;
        let anonymized_id = self.anonymized_id.clone();

        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageP2pSwapCompleted,
            |message, _| {
                Self::complete_p2p_swap_inner(
                    message,
                    user_id,
                    token0_txn_out,
                    token1_txn_out,
                    now,
                    chat,
                    anonymized_id,
                    event_pusher,
                )
            },
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::SwapNotFound.into()),
        }
    }

    #[expect(clippy::too_many_arguments)]
    fn complete_p2p_swap_inner<P: EventPusher>(
        message: &mut MessageInternal,
        user_id: UserId,
        token0_txn_out: u64,
        token1_txn_out: u64,
        now: TimestampMillis,
        chat: Chat,
        anonymized_id: String,
        mut event_pusher: P,
    ) -> Result<P2PSwapCompleted, UpdateEventError<OCErrorCode>> {
        let MessageContentInternal::P2PSwap(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if let Some(status) = content.complete(user_id, token0_txn_out, token1_txn_out) {
            let payload = P2PSwapCompletedEventPayload {
                token0: content.token0.symbol.clone(),
                token0_amount: content.token0_amount,
                token1: content.token1.symbol.clone(),
                token1_amount: content.token1_amount,
                chat_type: ChatType::from(&chat).to_string(),
                chat_id: anonymized_id.clone(),
            };

            event_pusher.push(
                EventBuilder::new("p2p_swap_completed", now)
                    .with_user(user_id.to_string(), true)
                    .with_source(chat.canister_id().to_string(), true)
                    .with_json_payload(&payload)
                    .build(),
            );

            Ok(status)
        } else {
            Err(UpdateEventError::NoChange(content.status.error_code()))
        }
    }

    pub fn unreserve_p2p_swap(
        &mut self,
        user_id: UserId,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        now: TimestampMillis,
    ) {
        let _ = self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::unreserve_p2p_swap_inner(message, user_id),
        );
    }

    fn unreserve_p2p_swap_inner(message: &mut MessageInternal, user_id: UserId) -> Result<(), UpdateEventError> {
        let MessageContentInternal::P2PSwap(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if content.unreserve(user_id) { Ok(()) } else { Err(UpdateEventError::NoChange(())) }
    }

    pub fn cancel_p2p_swap(
        &mut self,
        user_id: UserId,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess<u32>> {
        match self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageP2pSwapCancelled,
            |message, _| Self::cancel_p2p_swap_inner(message, user_id),
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(error)) => Err(error.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::SwapNotFound.into()),
        }
    }

    fn cancel_p2p_swap_inner(message: &mut MessageInternal, user_id: UserId) -> Result<u32, UpdateEventError<OCErrorCode>> {
        if message.sender == user_id
            && let MessageContentInternal::P2PSwap(content) = &mut message.content
        {
            return if content.cancel() {
                let swap_id = content.swap_id;
                Ok(swap_id)
            } else {
                Err(UpdateEventError::NoChange(content.status.error_code()))
            };
        }
        Err(UpdateEventError::NotFound)
    }

    pub fn mark_p2p_swap_expired(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        now: TimestampMillis,
    ) -> Result<UpdateMessageSuccess, UpdateEventError> {
        self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::mark_p2p_swap_expired_inner(message),
        )
    }

    fn mark_p2p_swap_expired_inner(message: &mut MessageInternal) -> Result<(), UpdateEventError> {
        let MessageContentInternal::P2PSwap(content) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if content.mark_expired() { Ok(()) } else { Err(UpdateEventError::NoChange(())) }
    }

    pub fn set_p2p_swap_status(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        status: P2PSwapStatus,
        now: TimestampMillis,
    ) -> Result<UpdateMessageSuccess, UpdateEventError> {
        self.update_message(
            thread_root_message_index,
            message_id.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::set_p2p_swap_status_inner(message, status),
        )
    }

    fn set_p2p_swap_status_inner(message: &mut MessageInternal, status: P2PSwapStatus) -> Result<(), UpdateEventError> {
        if let MessageContentInternal::P2PSwap(content) = &mut message.content {
            content.status = status;
            Ok(())
        } else {
            Err(UpdateEventError::NotFound)
        }
    }

    // Used when a group is imported into a community
    pub fn migrate_reply(&mut self, message_index: MessageIndex, old: ChatInternal, new: ChatInternal, now: TimestampMillis) {
        if self
            .update_message(
                None,
                message_index.into(),
                EventIndex::default(),
                now,
                true,
                ChatEventType::MessageOther,
                |message, _| {
                    if let Some(r) = message.replies_to.as_mut()
                        && let Some((chat, _)) = r.chat_if_other.as_mut()
                        && *chat == old
                    {
                        *chat = new;
                        return Ok(());
                    }
                    Err(UpdateEventError::NoChange(()))
                },
            )
            .is_err()
        {
            error!("Failed to migrate reply. This should never happen")
        }
    }

    pub fn follow_thread(
        &mut self,
        thread_root_message_index: MessageIndex,
        user_id: UserId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult {
        match self.update_thread_summary(
            thread_root_message_index,
            |t, _| t.followers.insert(user_id),
            min_visible_event_index,
            false,
            now,
        ) {
            Ok(_) => Ok(()),
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::ThreadNotFound.into()),
        }
    }

    pub fn unfollow_thread(
        &mut self,
        thread_root_message_index: MessageIndex,
        user_id: UserId,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult {
        match self.update_thread_summary(
            thread_root_message_index,
            |t, _| t.followers.remove(&user_id),
            min_visible_event_index,
            false,
            now,
        ) {
            Ok(_) => Ok(()),
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::NoChange.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::ThreadNotFound.into()),
        }
    }

    fn update_thread_summary<F: FnOnce(&mut ThreadSummaryInternal, UserId) -> bool>(
        &mut self,
        thread_root_message_index: MessageIndex,
        update_fn: F,
        min_visible_event_index: EventIndex,
        create_if_not_exists: bool,
        now: TimestampMillis,
    ) -> Result<UpdateMessageSuccess, UpdateEventError> {
        self.update_message(
            None,
            thread_root_message_index.into(),
            min_visible_event_index,
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::update_thread_summary_inner(message, create_if_not_exists, update_fn),
        )
    }

    fn update_thread_summary_inner<F: FnOnce(&mut ThreadSummaryInternal, UserId) -> bool>(
        root_message: &mut MessageInternal,
        create_if_not_exists: bool,
        update_fn: F,
    ) -> Result<(), UpdateEventError> {
        let summary = if create_if_not_exists {
            root_message.thread_summary.get_or_insert(ThreadSummaryInternal::default())
        } else if let Some(s) = root_message.thread_summary.as_mut() {
            s
        } else {
            return Err(UpdateEventError::NotFound);
        };

        if update_fn(summary, root_message.sender) { Ok(()) } else { Err(UpdateEventError::NoChange(())) }
    }

    // Note: this method assumes that if there is some thread_root_message_index then the thread exists
    fn push_event(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        event: ChatEventInternal,
        now: TimestampMillis,
    ) -> PushEventResultInternal {
        if self.frozen {
            // We should never hit this because if the chat is frozen it should be handled earlier,
            // this is just here as a safety net.
            panic!("This chat is frozen");
        }

        let valid = if thread_root_message_index.is_some() {
            event.is_valid_for_thread()
        } else {
            match self.chat {
                Chat::Direct(_) => event.is_valid_for_direct_chat(),
                Chat::Group(_) | Chat::Channel(..) => event.is_valid_for_group(),
            }
        };

        let Some(event_type) = valid.then(|| event.event_type()).flatten() else {
            panic!("Event type is not valid: {event:?}");
        };

        let expires_at = self.expiry_date(&event, thread_root_message_index.is_some(), now);

        let events_list = if let Some(root_message_index) = thread_root_message_index {
            self.threads.get_mut(&root_message_index).unwrap()
        } else {
            if let ChatEventInternal::Message(m) = &event {
                self.search_index.push(m.message_index, m.sender, Document::from(&m.content));
            }
            &mut self.main
        };

        let event_index = events_list.push_event(event.clone(), expires_at, now);

        if let Some(timestamp) = expires_at {
            self.expiring_events.insert(event_index, timestamp);
        }

        let bots_to_notify = self.bots_to_notify(&event_type);
        let bot_notification = if bots_to_notify.is_empty() {
            None
        } else {
            let event = event.chat_event(None);
            Some(BotNotification {
                event: types::BotEvent::Chat(BotChatEvent {
                    event,
                    chat: self.chat,
                    thread: thread_root_message_index,
                    event_index,
                    latest_event_index: event_index,
                }),
                recipients: bots_to_notify,
                timestamp: now,
            })
        };

        PushEventResultInternal {
            index: event_index,
            timestamp: now,
            expires_at,
            bot_notification,
        }
    }

    pub fn get_events_time_to_live(&self) -> &Timestamped<Option<Milliseconds>> {
        &self.events_ttl
    }

    pub fn set_events_time_to_live(
        &mut self,
        user_id: UserId,
        events_ttl: Option<Milliseconds>,
        now: TimestampMillis,
    ) -> Option<PushEventResultInternal> {
        if events_ttl != self.events_ttl.value {
            self.events_ttl = Timestamped::new(events_ttl, now);
            Some(self.push_main_event(
                ChatEventInternal::EventsTimeToLiveUpdated(Box::new(EventsTimeToLiveUpdated {
                    updated_by: user_id,
                    new_ttl: events_ttl,
                })),
                now,
            ))
        } else {
            None
        }
    }

    pub fn search_messages(
        &self,
        min_visible_message_index: MessageIndex,
        query: Query,
        users: HashSet<UserId>,
        max_results: u8,
    ) -> Vec<MessageMatch> {
        self.search_index
            .search_messages(min_visible_message_index, query, users)
            .map(|message_index| MessageMatch { message_index, score: 1 })
            .take(max_results as usize)
            .collect()
    }

    pub fn push_main_event(&mut self, event: ChatEventInternal, now: TimestampMillis) -> PushEventResultInternal {
        self.push_event(None, event, now)
    }

    pub fn push_thread_event(
        &mut self,
        thread_root_message_index: MessageIndex,
        event: ChatEventInternal,
        now: TimestampMillis,
    ) -> EventIndex {
        let events = self
            .threads
            .entry(thread_root_message_index)
            .or_insert_with(|| ChatEventsList::new(self.chat, Some(thread_root_message_index)));
        events.push_event(event, None, now)
    }

    pub fn mark_message_reminder_created_message_hidden(&mut self, message_index: MessageIndex, now: TimestampMillis) -> bool {
        self.update_message(
            None,
            message_index.into(),
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageOther,
            |message, _| Self::mark_message_reminder_created_message_hidden_inner(message),
        )
        .is_ok()
    }

    fn mark_message_reminder_created_message_hidden_inner(message: &mut MessageInternal) -> Result<(), UpdateEventError> {
        if let MessageContentInternal::MessageReminderCreated(r) = &mut message.content {
            r.hidden = true;
            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn hydrate_mention(&self, min_visible_event_index: EventIndex, mention: &Mention) -> Option<HydratedMention> {
        let events_reader = self.events_reader(min_visible_event_index, mention.thread_root_message_index, None)?;
        events_reader.hydrate_mention(mention)
    }

    pub fn metrics(&self) -> &ChatMetricsInternal {
        &self.metrics
    }

    pub fn user_metrics(&self, user_id: &UserId, if_updated_since: Option<TimestampMillis>) -> Option<&ChatMetricsInternal> {
        self.per_user_metrics
            .get(user_id)
            .filter(|m| if let Some(since) = if_updated_since { m.last_active > since } else { true })
    }

    pub fn event_count_since<F: Fn(&ChatEventInternal) -> bool>(&self, since: TimestampMillis, filter: F) -> usize {
        self.main.event_count_since(since, &filter)
            + self
                .threads
                .values()
                .map(|e| e.event_count_since(since, &filter))
                .sum::<usize>()
    }

    pub fn is_accessible(
        &self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
    ) -> bool {
        if let Some(events_list) = self.events_reader(min_visible_event_index, thread_root_message_index, None) {
            events_list.is_accessible(event_key, min_visible_event_index)
        } else {
            false
        }
    }

    pub fn message_ids(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
    ) -> Option<(EventIndex, MessageIndex, MessageId)> {
        self.message_internal(EventIndex::default(), thread_root_message_index, event_key)
            .map(|(m, e)| (e, m.message_index, m.message_id))
    }

    pub fn message_already_finalised(
        &self,
        thread_root_message_index: Option<MessageIndex>,
        message_id: MessageId,
        is_v2_bot: bool,
    ) -> bool {
        if let Some((message, _)) = self.message_internal(EventIndex::default(), thread_root_message_index, message_id.into()) {
            !is_v2_bot || message.bot_context().is_none_or(|b| b.finalised)
        } else {
            false
        }
    }

    pub fn freeze(&mut self, user_id: UserId, reason: Option<String>, now: TimestampMillis) -> PushEventResultInternal {
        let push_event_result = self.push_event(
            None,
            ChatEventInternal::ChatFrozen(Box::new(GroupFrozen {
                frozen_by: user_id,
                reason,
            })),
            now,
        );
        self.frozen = true;
        push_event_result
    }

    pub fn unfreeze(&mut self, user_id: UserId, now: TimestampMillis) -> PushEventResultInternal {
        self.frozen = false;
        self.push_event(
            None,
            ChatEventInternal::ChatUnfrozen(Box::new(GroupUnfrozen { unfrozen_by: user_id })),
            now,
        )
    }

    pub fn mark_members_added_to_public_channel(
        &mut self,
        mut user_ids: Vec<UserId>,
        now: TimestampMillis,
    ) -> Option<BotNotification> {
        if user_ids.is_empty() {
            return None;
        }

        if let Some(last_event_index) = self.latest_event_index()
            && self
                .update_event(None, last_event_index.into(), EventIndex::default(), Some(now), |event| {
                    // If the last event is of type `MembersAddedToPublicChannel` then add this user_id to that
                    // event and mark the event as updated, else push a new event
                    if let ChatEventInternal::MembersAddedToPublicChannel(m) = &mut event.event {
                        m.user_ids.extend(mem::take(&mut user_ids));
                        event.timestamp = now;
                        Ok(())
                    } else {
                        Err(UpdateEventError::NoChange(()))
                    }
                })
                .is_ok()
        {
            return None;
        };

        self.push_main_event(
            ChatEventInternal::MembersAddedToPublicChannel(Box::new(MembersAddedToPublicChannelInternal { user_ids })),
            now,
        )
        .bot_notification
    }

    pub fn next_event_expiry(&self) -> Option<TimestampMillis> {
        self.expiring_events.next_event_expiry()
    }

    pub fn remove_expired_events(&mut self, now: TimestampMillis) -> RemoveEventsResult {
        let mut results = RemoveEventsResult::default();

        while let Some(event_index) = self.expiring_events.take_next_expired_event(now) {
            if let Some(result) = self.remove_event(event_index, now) {
                results.merge_result(event_index, result);
            }
        }

        results
    }

    pub fn any_events_to_delete(&self, before: TimestampMillis) -> bool {
        self.main.iter(None, true, EventIndex::default(), None).any(|e| match e {
            EventOrExpiredRangeInternal::Event(event) => self.can_delete_event(&event.event) && event.timestamp < before,
            _ => false,
        })
    }

    pub fn remove_old_events_batch(
        &mut self,
        before: TimestampMillis,
        now: TimestampMillis,
        batch_size: u16,
    ) -> RemoveEventsResult {
        let mut batch_result = RemoveEventsResult::default();

        let batch_to_remove: Vec<_> = self
            .main
            .iter(None, true, EventIndex::default(), None)
            .filter_map(|e| match e {
                EventOrExpiredRangeInternal::Event(event) => Some(event),
                _ => None,
            })
            .filter(|e| self.can_delete_event(&e.event))
            .take(batch_size as usize)
            .take_while(|event| event.timestamp < before)
            .collect();

        for event in batch_to_remove {
            if let Some(result) = self.remove_event(event.index, now) {
                batch_result.merge_result(event.index, result);
            }
        }

        batch_result
    }

    pub fn remove_event(&mut self, event_index: EventIndex, now: TimestampMillis) -> Option<RemoveEventResult> {
        let event = self.main.remove(event_index)?;

        let mut result = RemoveEventResult::default();

        if let ChatEventInternal::Message(m) = event.event {
            if let Some(thread) = m.thread_summary {
                self.threads.remove(&m.message_index);
                result.thread = Some(ExpiredThread {
                    root_message_index: m.message_index,
                    followers: thread.followers,
                });
            }
            result.files = m.content.blob_references();
            if let MessageContentInternal::Prize(mut p) = m.content {
                result.final_prize_payments = p.final_payments(m.sender, now * 1_000_000);
            }
        }

        Some(result)
    }

    pub fn main_events_reader(&self) -> ChatEventsListReader<'_> {
        ChatEventsListReader::new(&self.main, &self.last_updated_timestamps)
    }

    pub fn visible_main_events_reader(&self, min_visible_event_index: EventIndex) -> ChatEventsListReader<'_> {
        ChatEventsListReader::with_min_visible_event_index(
            &self.main,
            &self.last_updated_timestamps,
            min_visible_event_index,
            None,
        )
    }

    pub fn events_reader(
        &self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
        bot_permitted_event_types: Option<HashSet<ChatEventCategory>>,
    ) -> Option<ChatEventsListReader<'_>> {
        let events_list = self.events_list(min_visible_event_index, thread_root_message_index)?;

        if thread_root_message_index.is_some() {
            Some(ChatEventsListReader::new(events_list, &self.last_updated_timestamps))
        } else {
            Some(ChatEventsListReader::with_min_visible_event_index(
                events_list,
                &self.last_updated_timestamps,
                min_visible_event_index,
                bot_permitted_event_types,
            ))
        }
    }

    pub fn latest_event_index(&self) -> Option<EventIndex> {
        self.main.latest_event_index()
    }

    pub fn latest_event_timestamp(&self) -> Option<TimestampMillis> {
        self.main.latest_event_timestamp()
    }

    pub fn convert_to_message_ranges(&self, event_ranges: &[(EventIndex, EventIndex)]) -> Vec<(MessageIndex, MessageIndex)> {
        self.main.convert_to_message_ranges(event_ranges)
    }

    pub fn main_events_list(&self) -> &ChatEventsList {
        &self.main
    }

    pub fn end_video_call<P: EventPusher>(
        &mut self,
        event_key: EventKey,
        now: TimestampMillis,
        event_pusher: Option<P>,
    ) -> OCResult<UpdateMessageSuccess> {
        let chat = self.chat;
        let anonymized_id = self.anonymized_id.clone();

        match self.update_message(
            None,
            event_key,
            EventIndex::default(),
            now,
            true,
            ChatEventType::MessageVideoCall,
            |message, event| Self::end_video_call_inner(message, event.timestamp, now, chat, anonymized_id, event_pusher),
        ) {
            Ok(result) => {
                self.video_call_in_progress = Timestamped::new(None, now);
                Ok(result)
            }
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::VideoCallAlreadyEnded.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn end_video_call_inner<P: EventPusher>(
        message: &mut MessageInternal,
        message_timestamp: TimestampMillis,
        now: TimestampMillis,
        chat: Chat,
        anonymized_id: String,
        mut event_pusher: Option<P>,
    ) -> Result<(), UpdateEventError> {
        let MessageContentInternal::VideoCall(video_call) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if video_call.ended.is_none() {
            let mut participants = 0;
            let mut hidden = 0;
            for p in video_call.participants.values() {
                if matches!(p.presence, VideoCallPresence::Hidden) {
                    hidden += 1;
                } else {
                    participants += 1;
                }
            }
            if let Some(event_pusher) = event_pusher.as_mut() {
                event_pusher.push(
                    EventBuilder::new("video_call_ended", now)
                        .with_source(chat.canister_id().to_string(), true)
                        .with_json_payload(&VideoCallEndedEventPayload {
                            chat_type: ChatType::from(&chat).to_string(),
                            chat_id: anonymized_id,
                            participants,
                            hidden,
                            duration_secs: (now.saturating_sub(message_timestamp) / 1000) as u32,
                        })
                        .build(),
                );
            }
            video_call.ended = Some(now);
            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn set_video_call_presence(
        &mut self,
        user_id: UserId,
        message_id: MessageId,
        presence: VideoCallPresence,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
    ) -> OCResult<UpdateMessageSuccess> {
        match self.update_message(
            None,
            message_id.into(),
            min_visible_event_index,
            now,
            true,
            ChatEventType::MessageVideoCall,
            |message, _| Self::set_video_presence_inner(message, user_id, presence, now),
        ) {
            Ok(result) => Ok(result),
            Err(UpdateEventError::NoChange(_)) => Err(OCErrorCode::VideoCallAlreadyEnded.into()),
            Err(UpdateEventError::NotFound) => Err(OCErrorCode::MessageNotFound.into()),
        }
    }

    fn set_video_presence_inner(
        message: &mut MessageInternal,
        user_id: UserId,
        presence: VideoCallPresence,
        now: TimestampMillis,
    ) -> Result<(), UpdateEventError> {
        let MessageContentInternal::VideoCall(video_call) = &mut message.content else {
            return Err(UpdateEventError::NotFound);
        };

        if video_call.ended.is_none() {
            video_call
                .participants
                .entry(user_id)
                .and_modify(|e| {
                    e.last_updated = Some(now);
                    e.presence = presence.clone();
                })
                .or_insert(CallParticipantInternal {
                    joined: now,
                    last_updated: None,
                    presence,
                });

            Ok(())
        } else {
            Err(UpdateEventError::NoChange(()))
        }
    }

    pub fn video_call_in_progress(&self, caller: Option<UserId>) -> Option<VideoCall> {
        let message_index = self.video_call_in_progress.as_ref()?.message_index;
        let event = self.main_events_reader().message_event_internal(message_index.into())?;
        let message = event.event;

        let MessageContentInternal::VideoCall(vc) = message.content else {
            return None;
        };

        Some(VideoCall {
            started: event.timestamp,
            started_by: message.sender,
            event_index: event.index,
            message_index,
            message_id: message.message_id,
            call_type: vc.call_type,
            joined_by_current_user: caller.is_some_and(|u| vc.participants.contains_key(&u)),
        })
    }

    pub fn video_call_in_progress_updates(&self, caller: Option<UserId>, since: TimestampMillis) -> OptionUpdate<VideoCall> {
        if let Some(message_index) = self.video_call_in_progress.as_ref().map(|vc| vc.message_index) {
            let Some(event) = self.main_events_reader().message_event_internal(message_index.into()) else {
                return OptionUpdate::SetToNone;
            };
            let message = event.event;

            let MessageContentInternal::VideoCall(vc) = message.content else {
                return OptionUpdate::SetToNone;
            };

            let current_user_joined_at = caller.and_then(|u| vc.participants.get(&u).map(|p| p.joined));

            if event.timestamp > since || current_user_joined_at > Some(since) {
                OptionUpdate::SetToSome(VideoCall {
                    started: event.timestamp,
                    started_by: message.sender,
                    event_index: event.index,
                    message_index,
                    message_id: message.message_id,
                    call_type: vc.call_type,
                    joined_by_current_user: current_user_joined_at.is_some(),
                })
            } else {
                OptionUpdate::NoChange
            }
        } else if self.video_call_in_progress.timestamp > since {
            OptionUpdate::SetToNone
        } else {
            OptionUpdate::NoChange
        }
    }

    pub fn video_call_participants(
        &self,
        message_id: MessageId,
        updated_since: TimestampMillis,
        min_visible_event_index: EventIndex,
    ) -> Option<VideoCallParticipants> {
        let (message, _) = self.message_internal(min_visible_event_index, None, message_id.into())?;

        if let MessageContentInternal::VideoCall(vc) = &message.content {
            let mut participants = Vec::new();
            let mut hidden = Vec::new();
            let mut last_updated = 0;
            for (u, p) in vc.participants.iter() {
                let participant_last_updated = p.last_updated.unwrap_or(p.joined);
                if participant_last_updated < updated_since {
                    continue;
                }

                let participant = CallParticipant {
                    user_id: *u,
                    joined: p.joined,
                };
                if matches!(p.presence, VideoCallPresence::Hidden) {
                    hidden.push(participant);
                } else {
                    participants.push(participant);
                }
                if participant_last_updated > last_updated {
                    last_updated = participant_last_updated;
                }
            }
            Some(VideoCallParticipants {
                participants,
                hidden,
                last_updated,
            })
        } else {
            None
        }
    }

    pub fn subscribe_bot_to_events(
        &mut self,
        bot_id: UserId,
        event_types: HashSet<ChatEventType>,
        permitted_categories: &HashSet<ChatEventCategory>,
    ) {
        // Remove any existing subscriptions
        self.unsubscribe_bot_from_events(bot_id);

        // Add any permitted new subscriptions
        let permitted_event_types: HashSet<ChatEventType> = event_types
            .into_iter()
            .filter(|t| permitted_categories.contains(&ChatEventCategory::from(*t)))
            .collect();

        for event_type in permitted_event_types {
            self.bot_subscriptions.entry(event_type).or_default().insert(bot_id);
        }
    }

    pub fn unsubscribe_bot_from_events(&mut self, bot_id: UserId) {
        for subscriptions in self.bot_subscriptions.values_mut() {
            subscriptions.remove(&bot_id);
        }
        self.bot_subscriptions.retain(|_, subscriptions| !subscriptions.is_empty());
    }

    fn events_list(
        &self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
    ) -> Option<&ChatEventsList> {
        if let Some(root_message_index) = thread_root_message_index {
            if self.main.is_accessible(root_message_index.into(), min_visible_event_index) {
                self.threads.get(&root_message_index)
            } else {
                None
            }
        } else {
            Some(&self.main)
        }
    }

    fn events_list_mut(
        &mut self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
    ) -> Option<&mut ChatEventsList> {
        if let Some(root_message_index) = thread_root_message_index {
            if self.main.is_accessible(root_message_index.into(), min_visible_event_index) {
                self.threads.get_mut(&root_message_index)
            } else {
                None
            }
        } else {
            Some(&mut self.main)
        }
    }

    pub fn event_wrapper_internal(
        &self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
    ) -> Option<EventWrapperInternal<ChatEventInternal>> {
        self.events_list(min_visible_event_index, thread_root_message_index)
            .and_then(|l| l.get_event(event_key, min_visible_event_index, None))
    }

    pub fn message_internal(
        &self,
        min_visible_event_index: EventIndex,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
    ) -> Option<(MessageInternal, EventIndex)> {
        self.event_wrapper_internal(min_visible_event_index, thread_root_message_index, event_key)
            .and_then(|e| e.event.into_message().map(|m| (m, e.index)))
    }

    fn expiry_date(&self, event: &ChatEventInternal, is_thread_event: bool, now: TimestampMillis) -> Option<TimestampMillis> {
        if !is_thread_event && let Some(ttl) = self.events_ttl.value {
            if self.can_delete_event(event) { Some(now + ttl) } else { None }
        } else {
            None
        }
    }

    fn can_delete_event(&self, event: &ChatEventInternal) -> bool {
        !matches!(
            event,
            ChatEventInternal::DirectChatCreated(_)
                | ChatEventInternal::GroupChatCreated(_)
                | ChatEventInternal::GroupNameChanged(_)
                | ChatEventInternal::GroupDescriptionChanged(_)
                | ChatEventInternal::GroupRulesChanged(_)
                | ChatEventInternal::AvatarChanged(_)
                | ChatEventInternal::GroupVisibilityChanged(_)
                | ChatEventInternal::GroupGateUpdated(_)
                | ChatEventInternal::ChatFrozen(_)
                | ChatEventInternal::ChatUnfrozen(_)
                | ChatEventInternal::EventsTimeToLiveUpdated(_)
                | ChatEventInternal::HistoryDeleted(_)
        )
    }

    fn update_event<F: FnOnce(&mut EventWrapperInternal<ChatEventInternal>) -> Result<T, UpdateEventError<E>>, T, E>(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
        min_visible_event_index: EventIndex,
        now_if_should_mark_updated: Option<TimestampMillis>,
        update_event_fn: F,
    ) -> Result<UpdateEventSuccess<T>, UpdateEventError<E>> {
        let Some(event_list) = self.events_list_mut(min_visible_event_index, thread_root_message_index) else {
            return Err(UpdateEventError::NotFound);
        };

        let result = event_list.update_event(event_key, update_event_fn);
        let latest_event_index = event_list.latest_event_index().unwrap_or_default();

        if let Some(now) = now_if_should_mark_updated
            && let Ok(success) = &result
        {
            self.last_updated_timestamps
                .mark_updated(thread_root_message_index, success.event_index, now);
        }

        result.map(|success| UpdateEventSuccess {
            event_index: success.event_index,
            latest_event_index,
            event: success.event.chat_event(None),
            value: success.value,
        })
    }

    #[expect(clippy::too_many_arguments)]
    fn update_message<F: FnOnce(&mut MessageInternal, EventMetaData) -> Result<T, UpdateEventError<E>>, T, E>(
        &mut self,
        thread_root_message_index: Option<MessageIndex>,
        event_key: EventKey,
        min_visible_event_index: EventIndex,
        now: TimestampMillis,
        should_mark_updated: bool,
        event_type: ChatEventType,
        update_message_fn: F,
    ) -> Result<UpdateMessageSuccess<T>, UpdateEventError<E>> {
        self.update_event(
            thread_root_message_index,
            event_key,
            min_visible_event_index,
            should_mark_updated.then_some(now),
            |event| Self::update_message_inner(event, update_message_fn),
        )
        .map(|r| {
            let bots_to_notify = self.bots_to_notify(&event_type);
            let bot_notification = if !bots_to_notify.is_empty() {
                Some(BotNotification {
                    event: types::BotEvent::Chat(BotChatEvent {
                        event: r.event,
                        chat: self.chat,
                        thread: thread_root_message_index,
                        event_index: r.event_index,
                        latest_event_index: r.latest_event_index,
                    }),
                    recipients: bots_to_notify,
                    timestamp: now,
                })
            } else {
                None
            };

            UpdateMessageSuccess {
                event_index: r.event_index,
                latest_event_index: r.latest_event_index,
                value: r.value,
                bot_notification,
            }
        })
    }

    fn update_message_inner<F: FnOnce(&mut MessageInternal, EventMetaData) -> Result<T, UpdateEventError<E>>, T, E>(
        event: &mut EventWrapperInternal<ChatEventInternal>,
        update_message_fn: F,
    ) -> Result<T, UpdateEventError<E>> {
        if let ChatEventInternal::Message(m) = &mut event.event {
            update_message_fn(
                m.deref_mut(),
                EventMetaData {
                    index: event.index,
                    timestamp: event.timestamp,
                    expires_at: event.expires_at,
                },
            )
        } else {
            Err(UpdateEventError::NotFound)
        }
    }

    pub fn latest_event_update_removed(&self) -> TimestampMillis {
        self.last_updated_timestamps.latest_update_removed()
    }

    pub fn bots_to_notify(&self, event_type: &ChatEventType) -> Vec<UserId> {
        self.bot_subscriptions
            .get(event_type)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }
}

fn add_to_metrics<F: FnMut(&mut ChatMetricsInternal)>(
    metrics: &mut ChatMetricsInternal,
    per_user_metrics: &mut BTreeMap<UserId, ChatMetricsInternal>,
    user_id: UserId,
    mut action: F,
    timestamp: TimestampMillis,
) {
    action(metrics);
    metrics.last_active = max(metrics.last_active, timestamp);

    let user_metrics = per_user_metrics.entry(user_id).or_default();
    action(user_metrics);
    user_metrics.last_active = max(user_metrics.last_active, timestamp);
}

pub struct PushMessageArgs {
    pub sender: UserId,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub content: MessageContentInternal,
    pub sender_context: Option<SenderContext>,
    pub mentioned: Vec<UserId>,
    pub replies_to: Option<ReplyContextInternal>,
    pub forwarded: bool,
    pub sender_is_bot: bool,
    pub block_level_markdown: bool,
    pub og_previews: Vec<OgPreview>,
    pub now: TimestampMillis,
}

pub struct EditMessageArgs {
    pub sender: UserId,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub content: MessageContentInternal,
    pub block_level_markdown: Option<bool>,
    pub og_previews: Vec<OgPreview>,
    pub finalise_bot_message: bool,
    pub now: TimestampMillis,
}

pub struct DeleteUndeleteMessagesArgs {
    pub caller: UserId,
    pub is_admin: bool,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_ids: Vec<MessageId>,
    pub now: TimestampMillis,
}

pub struct DeleteUndeleteMessageArgs {
    pub caller: UserId,
    pub is_admin: bool,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub now: TimestampMillis,
}

impl DeleteUndeleteMessagesArgs {
    pub fn iter(&self) -> impl Iterator<Item = DeleteUndeleteMessageArgs> + '_ {
        self.message_ids.iter().map(|m| DeleteUndeleteMessageArgs {
            caller: self.caller,
            is_admin: self.is_admin,
            min_visible_event_index: self.min_visible_event_index,
            thread_root_message_index: self.thread_root_message_index,
            message_id: *m,
            now: self.now,
        })
    }
}

pub struct RegisterPollVoteArgs {
    pub user_id: UserId,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_index: MessageIndex,
    pub option_index: u32,
    pub operation: VoteOperation,
    pub now: TimestampMillis,
}

pub struct RespondToActionCardArgs {
    pub user_id: UserId,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub response: ActionCardResponse,
    pub now: TimestampMillis,
}

#[derive(Clone, Debug)]
pub struct AiAppCardCapabilitySource {
    pub app_id: types::AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub content_hash: [u8; 32],
}

pub struct RespondToActionCardResult {
    pub state: ActionCardState,
    // Present only on a confirm transition of a card that carries delivery routing.
    pub deposit: Option<ActionCardDeposit>,
}

// An opaque confirmed-action payload to be encrypted to EACH of `recipient_public_keys` (fan-out: the
// proposer's key plus every chat member with a registered app key, resolved at propose time; deduped,
// never empty) and deposited to action_inbox. `message_id`/`confirmed_by` identify WHERE/BY WHOM the
// confirm happened; the chat identity itself is added at the canister layer (each canister knows
// itself) so the consumer receives full provenance context.
pub struct ActionCardDeposit {
    pub app_id: Option<types::AiAppId>,
    pub app_revision: Option<TimestampMillis>,
    pub app_verified: bool,
    pub action_id: String,
    pub recipient_public_keys: Vec<String>,
    pub confirm_payload: ByteBuf,
    pub confirm_payload_hash: [u8; 32],
    pub responded_at: TimestampMillis,
    pub message_id: MessageId,
    pub thread_root_message_index: Option<MessageIndex>,
    pub confirmed_by: UserId,
    pub content_hash: Option<[u8; 32]>,
    pub confirmation_lease_generation: u64,
    // Per-app inbox override carried from the card; None routes to the global action_inbox.
    pub inbox_canister_id: Option<CanisterId>,
}

pub struct RegisterPollVoteSuccess {
    pub poll_creator: UserId,
    pub votes: PollVotes,
    pub existing_vote_removed: bool,
    pub updated: bool,
}

pub enum EndPollResult {
    Success(Box<UpdateMessageSuccess>),
    PollNotFound,
    UnableToEndPoll,
}

pub enum RecordProposalVoteResult {
    Success,
    AlreadyVoted(bool),
    Error(OCError),
}

pub struct AddRemoveReactionArgs {
    pub user_id: UserId,
    pub min_visible_event_index: EventIndex,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub reaction: Reaction,
    pub now: TimestampMillis,
}

#[derive(Clone)]
pub struct TipMessageArgs {
    pub user_id: UserId,
    pub recipient: UserId,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub ledger: CanisterId,
    pub token_symbol: String,
    pub amount: u128,
    pub now: TimestampMillis,
}

pub struct ReservePrizeSuccess {
    pub token_symbol: String,
    pub ledger_canister_id: CanisterId,
    pub amount: u128,
    pub fee: u128,
    pub message_index: MessageIndex,
}

#[derive(Default)]
pub struct RemoveEventsResult {
    pub events: Vec<EventIndex>,
    pub threads: Vec<ExpiredThread>,
    pub files: Vec<BlobReference>,
    pub final_prize_payments: Vec<PendingCryptoTransaction>,
}

impl RemoveEventsResult {
    pub fn merge_result(&mut self, event_index: EventIndex, result: RemoveEventResult) {
        self.events.push(event_index);
        if let Some(thread) = result.thread {
            self.threads.push(thread);
        }
        self.files.extend(result.files);
        self.final_prize_payments.extend(result.final_prize_payments);
    }

    pub fn merge(&mut self, results: RemoveEventsResult) {
        self.events.extend(results.events);
        self.threads.extend(results.threads);
        self.files.extend(results.files);
        self.final_prize_payments.extend(results.final_prize_payments);
    }
}

#[derive(Default)]
pub struct RemoveEventResult {
    pub thread: Option<ExpiredThread>,
    pub files: Vec<BlobReference>,
    pub final_prize_payments: Vec<PendingCryptoTransaction>,
}

#[derive(Clone, Debug)]
pub struct ExpiredThread {
    pub root_message_index: MessageIndex,
    pub followers: BTreeSet<UserId>,
}

pub struct EditMessageSuccess {
    pub message_index: MessageIndex,
    pub event: EventMetaData,
    pub bot_notification: Option<BotNotification>,
}

pub struct DeleteMessageSuccess {
    pub sender: UserId,
    pub bot_notification: Option<BotNotification>,
}

pub struct UndeleteMessageSuccess {
    pub message: Message,
    pub bot_notification: Option<BotNotification>,
}

#[derive(Copy, Clone)]
pub enum EventKey {
    EventIndex(EventIndex),
    MessageIndex(MessageIndex),
    MessageId(MessageId),
}

impl From<EventIndex> for EventKey {
    fn from(value: EventIndex) -> Self {
        EventKey::EventIndex(value)
    }
}

impl From<MessageIndex> for EventKey {
    fn from(value: MessageIndex) -> Self {
        EventKey::MessageIndex(value)
    }
}

impl From<MessageId> for EventKey {
    fn from(value: MessageId) -> Self {
        EventKey::MessageId(value)
    }
}

pub struct PushEventResultInternal {
    pub index: EventIndex,
    pub timestamp: TimestampMillis,
    pub expires_at: Option<TimestampMillis>,
    pub bot_notification: Option<BotNotification>,
}

pub struct UpdateMessageSuccess<T = ()> {
    pub event_index: EventIndex,
    pub latest_event_index: EventIndex,
    pub value: T,
    pub bot_notification: Option<BotNotification>,
}

impl<T> UpdateMessageSuccess<T> {
    pub fn drop_value(self) -> UpdateMessageSuccess {
        UpdateMessageSuccess {
            event_index: self.event_index,
            latest_event_index: self.latest_event_index,
            value: (),
            bot_notification: self.bot_notification,
        }
    }
}

pub struct UpdateEventSuccess<T> {
    pub event_index: EventIndex,
    pub latest_event_index: EventIndex,
    pub event: ChatEvent,
    pub value: T,
}

pub struct UpdateEventInternalSuccess<T> {
    pub event_index: EventIndex,
    pub event: ChatEventInternal,
    pub value: T,
}

pub enum UpdateEventError<E = ()> {
    NoChange(E),
    NotFound,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoCallInternal {
    pub message_index: MessageIndex,
    pub call_type: VideoCallType,
}

#[cfg(test)]
mod action_card_security_tests {
    use super::*;
    use candid::Principal;
    use types::{ActionCardContentInitial, ActionCardRow};

    #[derive(Serialize)]
    struct LegacyActionCard {
        #[serde(rename = "ti")]
        title: String,
        #[serde(rename = "r")]
        rows: Vec<ActionCardRow>,
        #[serde(rename = "cl")]
        confirm_label: String,
        #[serde(rename = "xl")]
        cancel_label: String,
        #[serde(rename = "ai")]
        action_id: String,
        #[serde(rename = "s")]
        state: ActionCardState,
        #[serde(rename = "cp")]
        confirm_payload: Option<ByteBuf>,
    }

    fn chat_id(byte: u8) -> types::ChatId {
        Principal::from_slice(&[byte]).into()
    }

    fn card(app_verified: bool, app_content_verified: bool) -> MessageContentInternal {
        let initial = ActionCardContentInitial {
            title: "Approve operation".to_string(),
            rows: vec![ActionCardRow {
                label: "Value".to_string(),
                value: "42".to_string(),
            }],
            confirm_label: "Confirm".to_string(),
            cancel_label: "Cancel".to_string(),
            action_id: "sample.action".to_string(),
            app_id: Some(7),
            app_revision: Some(11),
            app_provenance: Some(ByteBuf::from(vec![1; 32])),
            disclosure: None,
            expires_at: None,
            recipient_public_key: None,
            recipient_public_keys: Vec::new(),
            confirm_payload: Some(ByteBuf::from(b"payload".to_vec())),
            inbox_canister_id: None,
        };
        let mut internal: ActionCardContentInternal = initial.into();
        internal.app_verified = app_verified;
        internal.app_content_verified = app_content_verified;
        MessageContentInternal::ActionCard(internal)
    }

    fn text() -> MessageContentInternal {
        MessageContentInternal::Text(TextContentInternal {
            text: "hello".to_string(),
        })
    }

    #[test]
    fn action_cards_cannot_be_edited_in_either_direction() {
        assert!(action_card_edit_is_forbidden(&card(true, true), &text()));
        assert!(action_card_edit_is_forbidden(&text(), &card(true, true)));
        assert!(!action_card_edit_is_forbidden(&text(), &text()));
    }

    #[test]
    fn app_confirmation_requires_directory_and_content_attestation_in_group_chats() {
        let MessageContentInternal::ActionCard(unverified) = card(false, false) else {
            unreachable!();
        };
        let MessageContentInternal::ActionCard(coordinates_only) = card(true, false) else {
            unreachable!();
        };
        let MessageContentInternal::ActionCard(fully_attested) = card(true, true) else {
            unreachable!();
        };
        let group = Chat::Group(chat_id(1));

        assert!(app_card_confirmation_is_forbidden(&unverified, group));
        assert!(app_card_confirmation_is_forbidden(&coordinates_only, group));
        assert!(!app_card_confirmation_is_forbidden(&fully_attested, group));
    }

    #[test]
    fn raw_sender_card_cannot_confirm_with_coordinate_provenance_alone_but_can_cancel() {
        // Raw msgpack ingress can obtain valid directory-coordinate provenance, but it has no field
        // or trusted path capable of setting the internal full-content attestation bit.
        let MessageContentInternal::ActionCard(mut card) = card(true, false) else {
            unreachable!();
        };
        let group = Chat::Group(chat_id(1));

        assert!(app_card_confirmation_is_forbidden(&card, group));
        assert!(card.cancel(Principal::from_slice(&[21]).into(), 123));
        assert_eq!(card.state, ActionCardState::Cancelled);
    }

    #[test]
    fn coordinate_provenance_alone_cannot_release_private_viewer_context() {
        let MessageContentInternal::ActionCard(coordinates_only) = card(true, false) else {
            unreachable!();
        };
        let MessageContentInternal::ActionCard(fully_attested) = card(true, true) else {
            unreachable!();
        };

        assert!(app_card_private_handoff_is_forbidden(&coordinates_only));
        assert!(!app_card_private_handoff_is_forbidden(&fully_attested));
    }

    #[test]
    fn app_confirmation_is_explicitly_out_of_scope_in_direct_chats() {
        let MessageContentInternal::ActionCard(verified) = card(true, true) else {
            unreachable!();
        };

        assert!(app_card_confirmation_is_forbidden(&verified, Chat::Direct(chat_id(2))));
    }

    #[test]
    fn partial_app_binding_fails_closed() {
        let MessageContentInternal::ActionCard(mut card) = card(true, true) else {
            unreachable!();
        };
        card.app_revision = None;

        assert!(app_card_confirmation_is_forbidden(&card, Chat::Group(chat_id(3))));
    }

    #[test]
    fn old_serialized_payload_card_is_readable_but_confirmation_fails_closed() {
        let legacy = LegacyActionCard {
            title: "Legacy".to_string(),
            rows: Vec::new(),
            confirm_label: "Confirm".to_string(),
            cancel_label: "Cancel".to_string(),
            action_id: "legacy.action".to_string(),
            state: ActionCardState::Pending,
            confirm_payload: Some(ByteBuf::from(b"legacy".to_vec())),
        };
        let restored: ActionCardContentInternal =
            msgpack::deserialize_then_unwrap(&msgpack::serialize_to_vec(&legacy).unwrap());
        assert_eq!(restored.app_id, None);
        assert_eq!(restored.app_revision, None);
        assert!(!restored.app_verified);
        assert!(!restored.app_content_verified);
        assert!(app_card_confirmation_is_forbidden(&restored, Chat::Group(chat_id(4))));

        let mut routing_less = restored;
        routing_less.confirm_payload = None;
        assert!(!app_card_confirmation_is_forbidden(&routing_less, Chat::Group(chat_id(4))));
    }
}
