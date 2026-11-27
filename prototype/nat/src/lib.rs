//! Hole punching through NATs that are hard without being random.
//!
//! [`mapping`] reads a NAT's port allocator from a survey and gives the ports a peer should send
//! to. It is pure arithmetic. [`stun`] is the little of RFC 8489 that a survey needs. The binary `piik-nat-lab`
//! runs a survey on a real network and prints what the model reads from it. [`sim`] is a NAT in memory,
//! for trying a plan against a kind of NAT without sending anything. [`search`] is the order in
//! which one side sends to the other's ports when no port can be named.
pub mod mapping;
pub mod search;
pub mod sim;
pub mod stun;
