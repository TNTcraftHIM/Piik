// Package route owns synchronous decisions over one room's media route graph, its
// single in-flight route operation, the quality/opportunity ledgers and the
// privacy-safe diagnostic snapshot.
//
// The controller performs no I/O, starts no timers and never locks. Every
// method is a state transition over the nowMs the caller passes in; the
// caller (signal.Server) holds the global mutex around every call and
// releases exactly the *Resource values a method returns, in order.
//
// Resources are compared by pointer identity. Invalid graphs, reservations or
// constructor options are programming errors and panic; ordinary unavailable
// routes remain decision outcomes.
package route
