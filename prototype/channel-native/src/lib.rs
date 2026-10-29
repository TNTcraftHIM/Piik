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
