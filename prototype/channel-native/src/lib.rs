//! An admitted native endpoint. Room authority is the shared Rust RoomHost;
//! WebRTC peers implement only the domain's current transport leases.
pub mod backup;
pub mod capture;
mod data;
pub mod diagnostics;
mod file;
pub mod hosted_room;
pub mod input;
#[cfg(target_os = "windows")]
pub mod windows_hotkeys;
#[cfg(target_os = "windows")]
pub mod windows_job;
mod media;
pub mod peer;
#[cfg(all(feature = "capture", target_os = "linux"))]
mod portal;
pub mod session;
mod shutdown;
pub mod watch;

pub use shutdown::shutdown_signal;

pub use media::{
    vp8::{Vp8FrameMetadata, Vp8PictureId},
    EncodedFrame,
};
