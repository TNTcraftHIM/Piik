use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProductVersion {
    pub major: u32,
    pub minor: u32,
}

impl ProductVersion {
    pub fn is_compatible(self) -> bool {
        self.major == PRODUCT_VERSION.major
    }
}

pub const PRODUCT_VERSION: ProductVersion =
    include!(concat!(env!("OUT_DIR"), "/product_version.rs"));
