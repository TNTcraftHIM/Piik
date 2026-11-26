//! Hole punching through NATs that are hard without being random.
//!
//! [`mapping`] reads a NAT's port allocator from a survey and plans the search it allows. It is pure
//! arithmetic. [`stun`] is the little of RFC 8489 that a survey needs. The binary `piik-nat-lab`
//! runs a survey on a real network and prints what the model reads from it.
pub mod mapping;
pub mod stun;
