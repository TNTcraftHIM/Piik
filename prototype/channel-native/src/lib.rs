//! An admitted native endpoint. Room authority is the shared Rust RoomHost;
//! WebRTC peers implement only the domain's current transport leases.
pub mod capture;
mod data;
mod file;
pub mod hosted_room;
pub mod input;
mod media;
pub mod peer;
pub mod session;
mod shutdown;

pub use shutdown::shutdown_signal;

pub use media::{
    vp8::{Vp8FrameMetadata, Vp8PictureId},
    EncodedFrame,
};
