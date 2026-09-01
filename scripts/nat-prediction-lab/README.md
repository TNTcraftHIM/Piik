# Browser NAT Prediction Lab

This disposable lab answers one question: can bounded predicted ICE candidates
improve direct Browser connectivity through sequential endpoint-dependent NAT?
It does not change Screener product code or production ICE.

## Boundary

- Linux, root, network namespaces, nftables, coturn, Node.js, Chromium, curl,
  and jq are required.
- Two real headless Chromium processes run on isolated endpoint namespaces.
- `cone`, `restricted`, `sequential`, and `random` describe measured mapping
  and filtering behavior in this lab, not a persistent participant capability.
- Raw candidate addresses and ports exist only in the in-memory signaling
  session. Results contain profile names, candidate counts, signed port deltas,
  connection success, and elapsed time.
- Prediction never removes or reprioritizes a normal ICE candidate. It appends
  at most 32 synthetic srflx candidates in the experiment only.

The topology uses documentation-only address space and has no route to
production:

```text
Chromium A -> NAT A -> controlled WAN <- NAT B <- Chromium B
                         |       |
                    STUN x2/3  HTTP signal
```

## Commands

```sh
./lab.sh setup
./lab.sh pair restricted sequential baseline 16
./lab.sh pair restricted sequential predict 16
./lab.sh pair sequential sequential predict-first 16
./lab.sh pair sequential restricted predict 8 jitter 4
./lab.sh matrix 3 16
./lab.sh calibrate 3
./lab.sh survey sequential 6
./lab.sh survey sequential 6 2
./lab.sh cleanup
```

`predict` appends predictions after normal candidates. `predict-first` adds the
same bounded predictions first while retaining every normal candidate; it is a
calibration variable, not an accepted product behavior. `setup` is idempotent
and starts three STUN-only coturn listeners plus the local HTTP harness. `pair`
rebuilds both NAT profiles before each run. `matrix` writes
JSON Lines to `/tmp/screener-nat-prediction-lab/matrix.jsonl`; it is intentionally
sequential so no run shares Browser sockets or conntrack state.

`calibrate` compares 1, 4, 16, 24, and 32-candidate windows, both candidate
orders for sequential-to-sequential pairs, random-map negative controls, and a
known-reachable regression control. It writes `calibration.jsonl` beside the
matrix.

The optional final `pair` argument inserts that many unrelated UDP mappings on
each sequential side after gathering and before candidates are released. This
measures prediction-window tolerance to competing NAT allocations without
pretending the Browser exposes its UDP socket.

`survey` runs the field-mapper prototype against one controlled profile. The
page keeps candidate endpoints in Browser memory only and reports aggregate
enums for mapping variation, delta stability, and allocation direction. The
same `/survey` page accepts two or three repeated `stun=` query parameters for a
future explicitly approved field deployment; this lab does not deploy it.

The baseline matrix is the gate. If it does not reproduce the expected
reachability classes, fix or reject the lab before interpreting prediction
results.
