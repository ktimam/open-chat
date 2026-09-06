pub use crate::updates::c2c_validate_ai_app_card_authority_v1::{Args, SuccessResult};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "The success response carries the complete consumed authority binding; keep the existing API representation"
)]
pub enum Response {
    Success(SuccessResult),
    NotFound,
    Expired,
    InvalidBinding,
    RouteChanged,
}
