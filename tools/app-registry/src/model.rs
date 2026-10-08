use candid::{CandidType, Principal};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};
use url::Url;

pub const SCHEMA_VERSION: u32 = 1;
pub const PAGE_SIZE: usize = 16;
pub const MAX_PUBLISHED: usize = 256;
pub const MAX_RECORDS: usize = 1024;
pub const MAX_PENDING_PER_OWNER: usize = 16;
pub const MAX_DESCRIPTOR_BYTES: usize = 7 * 1024;
pub const MAX_PAGE_BYTES: usize = 128 * 1024;
pub const DRAFT_TTL_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const MAX_ARTIFACT_BYTES: u32 = 1024 * 1024;

static HIDDEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cf}\x00-\x1f\x7f-\x9f]").unwrap());
static IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$").unwrap());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    #[serde(rename = "byteLength")]
    pub byte_length: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(deny_unknown_fields)]
pub struct Publisher {
    pub principal: String,
    pub origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub revision: String,
    pub catalog: Artifact,
    pub processor: Artifact,
    #[serde(rename = "setupUrl")]
    pub setup_url: String,
    pub publisher: Publisher,
}

// Publisher identity never comes from request JSON. The authenticated caller owns it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Submission {
    id: String,
    name: String,
    description: String,
    revision: String,
    catalog: Artifact,
    processor: Artifact,
    setup_url: String,
    publisher_origin: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct Init {
    pub operator: Principal,
    pub allow_loopback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct Review {
    pub id: String,
    pub owner: Principal,
    pub commitment: String,
    pub proposal_revision: u64,
    pub descriptor_json: String,
    pub published_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ReviewPage {
    pub apps: Vec<Review>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct Status {
    pub operator: Principal,
    pub registry: Principal,
    pub allow_loopback: bool,
    pub generation: u64,
    pub published_count: u32,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct Proposal {
    pub descriptor: Descriptor,
    pub commitment: String,
    pub proposal_revision: u64,
    pub submitted_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct Record {
    pub owner: Principal,
    pub pending: Proposal,
    pub published: Option<Proposal>,
    pub ever_published: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct Registry {
    pub schema_version: u32,
    pub registry: Principal,
    pub operator: Principal,
    pub allow_loopback: bool,
    pub generation: u64,
    pub next_revision: u64,
    // Owner + ID permits competing unpublished drafts, not exclusive name squatting.
    pub records: BTreeMap<String, Record>,
    // Permanent ID binding survives unpublish. Reuse must never inherit chat permissions.
    pub bindings: BTreeMap<String, Principal>,
}

#[derive(Serialize)]
struct DirectoryPage<'a> {
    version: u8,
    generation: String,
    page: usize,
    apps: Vec<&'a Descriptor>,
    next: Option<String>,
}

fn fail(message: &str) -> String {
    message.to_owned()
}
fn authenticated(principal: Principal) -> Result<(), String> {
    if principal == Principal::anonymous() || principal == Principal::management_canister() {
        return Err(fail(
            "A non-anonymous publisher or operator identity is required",
        ));
    }
    Ok(())
}
fn text(value: &str, limit: usize) -> Result<(), String> {
    // JS length uses UTF-16 units; match the client's validation bound.
    if value.is_empty()
        || value.encode_utf16().count() > limit
        || value.trim() != value
        || HIDDEN.is_match(value)
    {
        return Err(fail("Invalid bounded public metadata"));
    }
    Ok(())
}
fn record_key(owner: Principal, id: &str) -> String {
    format!("{}\0{id}", owner.to_text())
}
fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}
fn origin(value: &str, allow_loopback: bool) -> Result<Url, String> {
    text(value, 2048)?;
    let url = Url::parse(value).map_err(|_| fail("Invalid publisher origin"))?;
    if url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || (url.scheme() != "https"
            && !(allow_loopback && url.scheme() == "http" && is_loopback(&url)))
        || (!allow_loopback && is_loopback(&url))
    {
        return Err(fail(
            "Publisher must use a canonical HTTPS origin; loopback is explicit local mode only",
        ));
    }
    Ok(url)
}
fn resource(value: &str, publisher: &Url) -> Result<String, String> {
    text(value, 2048)?;
    let url = publisher
        .join(value)
        .map_err(|_| fail("Invalid publisher resource"))?;
    if url.origin() != publisher.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().encode_utf16().count() > 2048
    {
        return Err(fail(
            "All package and setup resources must stay on the approved publisher origin",
        ));
    }
    Ok(url.into())
}
fn artifact(value: &mut Artifact, publisher: &Url) -> Result<(), String> {
    if value.byte_length == 0
        || value.byte_length > MAX_ARTIFACT_BYTES
        || value.sha256.len() != 64
        || !value
            .sha256
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(fail(
            "Artifact requires an exact lowercase SHA-256 and bounded byte length",
        ));
    }
    value.url = resource(&value.url, publisher)?;
    Ok(())
}
fn validate_descriptor(
    descriptor: &mut Descriptor,
    owner: Principal,
    allow_loopback: bool,
) -> Result<(), String> {
    authenticated(owner)?;
    if descriptor.publisher.principal != owner.to_text() {
        return Err(fail("Publisher identity mismatch"));
    }
    text(&descriptor.id, 128)?;
    text(&descriptor.revision, 128)?;
    if !IDENTIFIER.is_match(&descriptor.id) || !IDENTIFIER.is_match(&descriptor.revision) {
        return Err(fail("Invalid app ID or revision"));
    }
    text(&descriptor.name, 200)?;
    text(&descriptor.description, 4096)?;
    let publisher = origin(&descriptor.publisher.origin, allow_loopback)?;
    artifact(&mut descriptor.catalog, &publisher)?;
    artifact(&mut descriptor.processor, &publisher)?;
    descriptor.setup_url = resource(&descriptor.setup_url, &publisher)?;
    if serde_json::to_vec(descriptor)
        .map_err(|_| fail("Invalid descriptor JSON"))?
        .len()
        > MAX_DESCRIPTOR_BYTES
    {
        return Err(fail("Public app descriptor exceeds the 7 KiB bound"));
    }
    Ok(())
}
fn commitment(
    registry: Principal,
    owner: Principal,
    revision: u64,
    descriptor: &Descriptor,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(b"openchat-fork.app-registry.proposal.v1\0");
    // Candid provides unambiguous framing; include authority and monotonic revision.
    hash.update(
        candid::encode_args((registry, owner, revision, descriptor))
            .map_err(|_| fail("Cannot encode commitment"))?,
    );
    Ok(hex::encode(hash.finalize()))
}

impl Registry {
    pub fn new(init: Init, registry: Principal) -> Result<Self, String> {
        authenticated(init.operator)?;
        authenticated(registry)?;
        Ok(Self {
            schema_version: SCHEMA_VERSION,
            registry,
            operator: init.operator,
            allow_loopback: init.allow_loopback,
            generation: 0,
            next_revision: 0,
            records: BTreeMap::new(),
            bindings: BTreeMap::new(),
        })
    }
    pub fn status(&self) -> Status {
        Status {
            operator: self.operator,
            registry: self.registry,
            allow_loopback: self.allow_loopback,
            generation: self.generation,
            published_count: self
                .records
                .values()
                .filter(|r| r.published.is_some())
                .count() as u32,
            schema_version: self.schema_version,
        }
    }
    pub fn register(&mut self, caller: Principal, json: &str, now: u64) -> Result<Review, String> {
        authenticated(caller)?;
        if json.len() > MAX_DESCRIPTOR_BYTES {
            return Err(fail("Submission exceeds the 7 KiB bound"));
        }
        let input: Submission = serde_json::from_str(json)
            .map_err(|_| fail("Invalid registration JSON or unexpected fields"))?;
        let mut descriptor = Descriptor {
            id: input.id,
            name: input.name,
            description: input.description,
            revision: input.revision,
            catalog: input.catalog,
            processor: input.processor,
            setup_url: input.setup_url,
            publisher: Publisher {
                principal: caller.to_text(),
                origin: input.publisher_origin,
            },
        };
        validate_descriptor(&mut descriptor, caller, self.allow_loopback)?;
        if self
            .bindings
            .get(&descriptor.id)
            .is_some_and(|owner| *owner != caller)
        {
            return Err(fail("App ID is permanently bound to another publisher"));
        }
        let key = record_key(caller, &descriptor.id);
        if let Some(existing) = self.records.get(&key) {
            if existing.pending.descriptor == descriptor
                && (existing.ever_published
                    || now.saturating_sub(existing.pending.submitted_at) < DRAFT_TTL_NS)
            {
                return Self::review(existing);
            }
        }
        // Expire only never-published drafts. Published IDs/owner bindings are never reclaimed.
        self.records.retain(|_, record| {
            record.ever_published || now.saturating_sub(record.pending.submitted_at) < DRAFT_TTL_NS
        });
        let is_new_pending = self.records.get(&key).is_none_or(|r| {
            r.published
                .as_ref()
                .is_some_and(|p| p.commitment == r.pending.commitment)
        });
        let pending_count = self
            .records
            .values()
            .filter(|r| {
                r.owner == caller
                    && r.published
                        .as_ref()
                        .is_none_or(|p| p.commitment != r.pending.commitment)
            })
            .count();
        if is_new_pending && pending_count >= MAX_PENDING_PER_OWNER {
            return Err(fail("Publisher has too many pending submissions"));
        }
        if !self.records.contains_key(&key) && self.records.len() >= MAX_RECORDS {
            return Err(fail("Registry is at its bounded record capacity"));
        }
        let revision = self
            .next_revision
            .checked_add(1)
            .ok_or_else(|| fail("Revision counter exhausted"))?;
        let proposal = Proposal {
            commitment: commitment(self.registry, caller, revision, &descriptor)?,
            descriptor,
            proposal_revision: revision,
            submitted_at: now,
        };
        self.next_revision = revision;
        let record = self.records.entry(key).or_insert_with(|| Record {
            owner: caller,
            pending: proposal.clone(),
            published: None,
            ever_published: false,
        });
        record.pending = proposal;
        Self::review(record)
    }
    fn review(record: &Record) -> Result<Review, String> {
        Ok(Review {
            id: record.pending.descriptor.id.clone(),
            owner: record.owner,
            commitment: record.pending.commitment.clone(),
            proposal_revision: record.pending.proposal_revision,
            descriptor_json: serde_json::to_string(&record.pending.descriptor)
                .map_err(|_| fail("Cannot encode public descriptor"))?,
            published_revision: record.published.as_ref().map(|p| p.proposal_revision),
        })
    }
    pub fn pending(&self, caller: Principal, owner: Principal, id: &str) -> Result<Review, String> {
        authenticated(caller)?;
        if caller != owner && caller != self.operator {
            return Err(fail(
                "Pending registrations are private to their publisher and operator",
            ));
        }
        Self::review(
            self.records
                .get(&record_key(owner, id))
                .ok_or_else(|| fail("Registration not found"))?,
        )
    }
    pub fn mine(&self, caller: Principal, after_id: Option<&str>) -> Result<ReviewPage, String> {
        authenticated(caller)?;
        if let Some(after) = after_id {
            if !IDENTIFIER.is_match(after) {
                return Err(fail("Invalid publisher page cursor"));
            }
        }
        let mut matches = self.records.values().filter(|r| {
            r.owner == caller
                && after_id.is_none_or(|after| r.pending.descriptor.id.as_str() > after)
        });
        let apps: Vec<Review> = matches
            .by_ref()
            .take(PAGE_SIZE)
            .map(Self::review)
            .collect::<Result<_, _>>()?;
        let next = matches
            .next()
            .and_then(|_| apps.last().map(|app| app.id.clone()));
        Ok(ReviewPage { apps, next })
    }
    pub fn publish(
        &mut self,
        caller: Principal,
        owner: Principal,
        id: &str,
        expected: &str,
        now: u64,
    ) -> Result<Review, String> {
        if caller != self.operator {
            return Err(fail(
                "Only the registry operator may publish a reviewed revision",
            ));
        }
        if self.bindings.get(id).is_some_and(|bound| *bound != owner) {
            return Err(fail("App ID is permanently bound to another publisher"));
        }
        let key = record_key(owner, id);
        let record = self
            .records
            .get(&key)
            .ok_or_else(|| fail("Registration not found"))?;
        if record.pending.commitment != expected {
            return Err(fail(
                "Pending revision changed; review the new exact commitment",
            ));
        }
        if !record.ever_published && now.saturating_sub(record.pending.submitted_at) >= DRAFT_TTL_NS
        {
            return Err(fail("Pending registration expired"));
        }
        if record
            .published
            .as_ref()
            .is_some_and(|p| p.commitment == expected)
        {
            return Self::review(record);
        }
        if record.published.is_none() && self.status().published_count as usize >= MAX_PUBLISHED {
            return Err(fail("Published app capacity reached"));
        }
        // Validate all future pages before committing any visible mutation.
        let mut candidate = self.clone();
        candidate.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| fail("Generation counter exhausted"))?;
        candidate.bindings.insert(id.to_owned(), owner);
        let record = candidate.records.get_mut(&key).unwrap();
        record.published = Some(record.pending.clone());
        record.ever_published = true;
        let review = Self::review(record)?;
        candidate.pages()?;
        *self = candidate;
        Ok(review)
    }
    pub fn unpublish(
        &mut self,
        caller: Principal,
        id: &str,
        expected_revision: u64,
    ) -> Result<u64, String> {
        authenticated(caller)?;
        let owner = *self
            .bindings
            .get(id)
            .ok_or_else(|| fail("Published app not found"))?;
        if caller != owner && caller != self.operator {
            return Err(fail("Only publisher or operator may unpublish"));
        }
        let key = record_key(owner, id);
        let record = self
            .records
            .get(&key)
            .ok_or_else(|| fail("Published app not found"))?;
        if record.published.as_ref().map(|p| p.proposal_revision) != Some(expected_revision) {
            return Err(fail(
                "Published revision changed or app is already unpublished",
            ));
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| fail("Generation counter exhausted"))?;
        // Revocation invalidates every approval prepared before it, including an approval for
        // a different pending update. Preserve the pending content, but require a fresh review
        // of a newly committed revision before this app can become visible again.
        let revision = self
            .next_revision
            .checked_add(1)
            .ok_or_else(|| fail("Revision counter exhausted"))?;
        let pending_commitment =
            commitment(self.registry, owner, revision, &record.pending.descriptor)?;
        // All fallible work precedes mutation so an exhausted counter cannot partly revoke.
        let record = self.records.get_mut(&key).unwrap();
        record.pending.proposal_revision = revision;
        record.pending.commitment = pending_commitment;
        record.published = None;
        self.next_revision = revision;
        self.generation = generation;
        Ok(generation)
    }
    pub fn pages(&self) -> Result<BTreeMap<String, Vec<u8>>, String> {
        let mut apps: Vec<&Descriptor> = self
            .records
            .values()
            .filter_map(|r| r.published.as_ref().map(|p| &p.descriptor))
            .collect();
        apps.sort_by(|a, b| a.id.cmp(&b.id));
        if apps.len() > MAX_PUBLISHED {
            return Err(fail("Too many published apps"));
        }
        let page_count = apps.len().div_ceil(PAGE_SIZE).max(1);
        let mut pages = BTreeMap::new();
        for page in 0..page_count {
            let data = DirectoryPage {
                version: 2,
                generation: self.generation.to_string(),
                page,
                apps: apps
                    .iter()
                    .skip(page * PAGE_SIZE)
                    .take(PAGE_SIZE)
                    .copied()
                    .collect(),
                next: (page + 1 < page_count)
                    .then(|| format!("/pages/{}/{}.json", self.generation, page + 1)),
            };
            let bytes =
                serde_json::to_vec(&data).map_err(|_| fail("Cannot serialize directory page"))?;
            if bytes.len() > MAX_PAGE_BYTES {
                return Err(fail("Directory page exceeds response bound"));
            }
            let path = if page == 0 {
                "/apps-v2.json".to_owned()
            } else {
                format!("/pages/{}/{page}.json", self.generation)
            };
            pages.insert(path, bytes);
        }
        Ok(pages)
    }
    pub fn validate_restored(&self, registry: Principal) -> Result<(), String> {
        authenticated(self.operator)?;
        if self.schema_version != SCHEMA_VERSION
            || self.registry != registry
            || self.records.len() > MAX_RECORDS
            || self.bindings.len() > MAX_RECORDS
        {
            return Err(fail("Incompatible or invalid stable registry state"));
        }
        let mut published_ids = BTreeSet::new();
        let mut revisions = BTreeMap::new();
        for (key, record) in &self.records {
            authenticated(record.owner)?;
            if *key != record_key(record.owner, &record.pending.descriptor.id) {
                return Err(fail("Stable owner/ID mismatch"));
            }
            if record.ever_published
                != (self.bindings.get(&record.pending.descriptor.id) == Some(&record.owner))
            {
                return Err(fail("Stable publisher binding mismatch"));
            }
            for proposal in std::iter::once(&record.pending).chain(record.published.iter()) {
                let mut normalized = proposal.descriptor.clone();
                validate_descriptor(&mut normalized, record.owner, self.allow_loopback)?;
                if normalized != proposal.descriptor
                    || proposal.proposal_revision == 0
                    || proposal.proposal_revision > self.next_revision
                    || proposal.commitment
                        != commitment(
                            self.registry,
                            record.owner,
                            proposal.proposal_revision,
                            &proposal.descriptor,
                        )?
                {
                    return Err(fail("Stable descriptor or commitment is invalid"));
                }
                if let Some(previous) =
                    revisions.insert(proposal.proposal_revision, &proposal.commitment)
                {
                    if previous != &proposal.commitment {
                        return Err(fail("Stable revision was reused"));
                    }
                }
            }
            if let Some(published) = &record.published {
                if !record.ever_published
                    || published.descriptor.id != record.pending.descriptor.id
                    || published.proposal_revision > record.pending.proposal_revision
                    || !published_ids.insert(&published.descriptor.id)
                {
                    return Err(fail("Invalid stable publication"));
                }
            }
        }
        for (id, owner) in &self.bindings {
            if !self
                .records
                .get(&record_key(*owner, id))
                .is_some_and(|record| record.ever_published)
            {
                return Err(fail("Orphaned stable binding"));
            }
        }
        self.pages()?;
        Ok(())
    }
}
