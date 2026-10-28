//! An admitted native endpoint. Room authority is the shared Rust RoomHost;
//! WebRTC peers implement only the domain's current transport leases.
pub mod app;
mod data;
mod file;
pub mod hosted_room;
mod media;
pub mod peer;
pub mod session;
