// Package route ports src/server/room-route-controller.ts: the pure,
// synchronous decision logic that owns one room's media route graph, its
// single in-flight route operation, the quality/opportunity ledgers and the
// privacy-safe diagnostic snapshot.
//
// The controller performs no I/O, starts no timers and never locks. Every
// method is a state transition over the nowMs the caller passes in; the
// caller (signal.Server) holds the global mutex around every call and
// releases exactly the *Resource values a method returns, in order.
//
// Resources are compared by pointer identity, mirroring the JS Set semantics
// of the TypeScript source. Programming-error throws in the source
// (assertGraph, bad reservations, bad options) become panics with the same
// messages.
package route
