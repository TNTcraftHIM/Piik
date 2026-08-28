# Screener Native Sender Research

This directory retains Native sender and shared-encode evidence. It is not a
current product or distribution surface and its private wire is not compatible
with the current Browser/server contract. Do not package or distribute it.

[ADR-0006](../../docs/adr/0006-fixed-high-native-sender-canary.md) owns the stop
line; [Native sender research](../../docs/research/native-sender.md) owns the
retained evidence and the gates required before this work can resume.

The retained Go checks remain available from `native/sender`:

```sh
go test ./...
go vet ./...
```
