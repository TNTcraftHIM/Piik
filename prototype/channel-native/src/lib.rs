//! An admitted native endpoint. Room authority is the shared Rust RoomHost;
//! WebRTC peers implement only the domain's current transport leases.
mod media;
mod file;
pub mod peer;
pub mod session;
