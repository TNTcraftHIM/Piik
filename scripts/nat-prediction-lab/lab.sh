#!/usr/bin/env bash
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LAB_DIR
readonly STATE_DIR="${NATLAB_STATE_DIR:-/tmp/screener-nat-prediction-lab}"
readonly NS_A="snl-a"
readonly NS_B="snl-b"
readonly NAT_A="snl-na"
readonly NAT_B="snl-nb"
readonly WAN_BRIDGE="snl-wan"
readonly SIGNAL_ADDRESS="198.18.0.20"
readonly SIGNAL_PORT="8080"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "This lab requires root for network namespaces and nftables." >&2
    exit 1
  fi
}

require_commands() {
  local command_name
  for command_name in ip nft conntrack turnserver node chromium-browser curl jq; do
    command -v "$command_name" >/dev/null || {
      echo "Missing required command: $command_name" >&2
      exit 1
    }
  done
}

kill_namespace_processes() {
  local namespace="$1"
  if ip netns list | awk '{print $1}' | grep -qx "$namespace"; then
    local process_id
    while read -r process_id; do
      [[ -n "$process_id" ]] && kill "$process_id" 2>/dev/null || true
    done < <(ip netns pids "$namespace")
  fi
}

stop_service_pid() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local process_id
    process_id="$(cat "$pid_file")"
    kill "$process_id" 2>/dev/null || true
    wait "$process_id" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

cleanup() {
  mkdir -p "$STATE_DIR"
  stop_service_pid "$STATE_DIR/harness.pid"
  stop_service_pid "$STATE_DIR/stun-a.pid"
  stop_service_pid "$STATE_DIR/stun-b.pid"
  stop_service_pid "$STATE_DIR/stun-c.pid"

  kill_namespace_processes "$NS_A"
  kill_namespace_processes "$NS_B"
  kill_namespace_processes "$NAT_A"
  kill_namespace_processes "$NAT_B"

  local namespace
  for namespace in "$NS_A" "$NS_B" "$NAT_A" "$NAT_B"; do
    ip netns del "$namespace" 2>/dev/null || true
  done
  ip link del "$WAN_BRIDGE" 2>/dev/null || true
}

configure_endpoint() {
  local namespace="$1"
  local interface_name="$2"
  local address="$3"
  local gateway="$4"
  ip -n "$namespace" link set lo up
  ip -n "$namespace" link set "$interface_name" name eth0
  ip -n "$namespace" address add "$address" dev eth0
  ip -n "$namespace" link set eth0 up
  ip -n "$namespace" route add default via "$gateway"
}

configure_nat_namespace() {
  local namespace="$1"
  local lan_interface="$2"
  local wan_interface="$3"
  local lan_address="$4"
  local wan_address="$5"
  ip -n "$namespace" link set lo up
  ip -n "$namespace" link set "$lan_interface" name lan0
  ip -n "$namespace" link set "$wan_interface" name wan0
  ip -n "$namespace" address add "$lan_address" dev lan0
  ip -n "$namespace" address add "$wan_address" dev wan0
  ip -n "$namespace" link set lan0 up
  ip -n "$namespace" link set wan0 up
  ip -n "$namespace" route add default via 198.18.0.254
  ip netns exec "$namespace" sysctl -q -w net.ipv4.ip_forward=1
  ip netns exec "$namespace" sysctl -q -w net.ipv4.conf.all.rp_filter=0
  ip netns exec "$namespace" sysctl -q -w net.ipv4.conf.default.rp_filter=0
}

setup_topology() {
  cleanup
  mkdir -p "$STATE_DIR"

  ip netns add "$NS_A"
  ip netns add "$NS_B"
  ip netns add "$NAT_A"
  ip netns add "$NAT_B"

  ip link add nlaep type veth peer name nlalan
  ip link set nlaep netns "$NS_A"
  ip link set nlalan netns "$NAT_A"
  configure_endpoint "$NS_A" nlaep 10.10.1.2/24 10.10.1.1

  ip link add nlbep type veth peer name nlblan
  ip link set nlbep netns "$NS_B"
  ip link set nlblan netns "$NAT_B"
  configure_endpoint "$NS_B" nlbep 10.10.2.2/24 10.10.2.1

  ip link add "$WAN_BRIDGE" type bridge
  ip address add 198.18.0.254/24 dev "$WAN_BRIDGE"
  ip address add 198.18.0.10/32 dev "$WAN_BRIDGE"
  ip address add 198.18.0.11/32 dev "$WAN_BRIDGE"
  ip address add 198.18.0.12/32 dev "$WAN_BRIDGE"
  ip address add "$SIGNAL_ADDRESS"/32 dev "$WAN_BRIDGE"
  ip link set "$WAN_BRIDGE" up

  ip link add nlaw type veth peer name nlawan
  ip link set nlaw master "$WAN_BRIDGE"
  ip link set nlaw up
  ip link set nlawan netns "$NAT_A"
  configure_nat_namespace "$NAT_A" nlalan nlawan 10.10.1.1/24 198.18.0.2/24

  ip link add nlbw type veth peer name nlbwan
  ip link set nlbw master "$WAN_BRIDGE"
  ip link set nlbw up
  ip link set nlbwan netns "$NAT_B"
  configure_nat_namespace "$NAT_B" nlblan nlbwan 10.10.2.1/24 198.18.0.3/24
}

sequential_port_map() {
  local first=1
  local index
  for index in $(seq 0 63); do
    if [[ "$first" -eq 0 ]]; then printf ', '; fi
    printf '%s : %s' "$index" "$((40000 + index))"
    first=0
  done
}

apply_profile() {
  local namespace="$1"
  local profile="$2"
  local external_address="$3"
  local internal_address="$4"
  local cone_forward=""
  local cone_dnat=""
  local pre_conntrack_filter=""
  local source_nat=""

  case "$profile" in
    cone)
      cone_forward='iifname "wan0" oifname "lan0" meta l4proto udp accept'
      cone_dnat="iifname \"wan0\" meta l4proto udp dnat to $internal_address"
      source_nat="oifname \"wan0\" snat to $external_address"
      ;;
    restricted)
      pre_conntrack_filter='iifname "wan0" meta l4proto udp ip saddr . udp sport @allowed_peers accept
    iifname "wan0" meta l4proto udp drop'
      source_nat="oifname \"wan0\" snat to $external_address"
      ;;
    sequential)
      pre_conntrack_filter='iifname "wan0" meta l4proto udp ip saddr . udp sport @allowed_peers accept
    iifname "wan0" meta l4proto udp drop'
      source_nat="oifname \"wan0\" meta l4proto udp snat to $external_address : numgen inc mod 64 map { $(sequential_port_map) }
    oifname \"wan0\" snat to $external_address"
      ;;
    random)
      pre_conntrack_filter='iifname "wan0" meta l4proto udp ip saddr . udp sport @allowed_peers accept
    iifname "wan0" meta l4proto udp drop'
      source_nat="oifname \"wan0\" meta l4proto udp snat to $external_address:40000-60000 fully-random
    oifname \"wan0\" snat to $external_address"
      ;;
    *)
      echo "Unknown NAT profile: $profile" >&2
      exit 1
      ;;
  esac

  ip netns exec "$namespace" nft flush ruleset
  ip netns exec "$namespace" nft -f - <<EOF
table ip filter {
  set allowed_peers {
    type ipv4_addr . inet_service
    flags dynamic,timeout
    timeout 30s
  }
  chain raw_prerouting {
    type filter hook prerouting priority raw; policy accept;
    $pre_conntrack_filter
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    iifname "lan0" oifname "wan0" meta l4proto udp update @allowed_peers { ip daddr . udp dport timeout 30s } accept
    iifname "lan0" oifname "wan0" accept
    iifname "wan0" oifname "lan0" ct state established,related accept
    $cone_forward
  }
}
table ip nat {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    $cone_dnat
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    $source_nat
  }
}
EOF
  ip netns exec "$namespace" conntrack -F >/dev/null 2>&1 || true
}

start_services() {
  turnserver -S -L 198.18.0.10 -p 3478 --no-tls --no-dtls \
    --no-stdout-log --log-file /dev/null >/dev/null 2>&1 &
  echo "$!" > "$STATE_DIR/stun-a.pid"
  turnserver -S -L 198.18.0.11 -p 3478 --no-tls --no-dtls \
    --no-stdout-log --log-file /dev/null >/dev/null 2>&1 &
  echo "$!" > "$STATE_DIR/stun-b.pid"
  turnserver -S -L 198.18.0.12 -p 3478 --no-tls --no-dtls \
    --no-stdout-log --log-file /dev/null >/dev/null 2>&1 &
  echo "$!" > "$STATE_DIR/stun-c.pid"
  NATLAB_BIND="$SIGNAL_ADDRESS" NATLAB_PORT="$SIGNAL_PORT" \
    node "$LAB_DIR/harness.mjs" >/dev/null 2>&1 &
  echo "$!" > "$STATE_DIR/harness.pid"

  local attempt
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    if curl -fs "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/health" >/dev/null; then
      return
    fi
    sleep 0.1
  done
  echo "The lab harness did not become healthy." >&2
  exit 1
}

setup() {
  require_root
  require_commands
  setup_topology
  apply_profile "$NAT_A" restricted 198.18.0.2 10.10.1.2
  apply_profile "$NAT_B" restricted 198.18.0.3 10.10.2.2
  start_services
  echo "NAT prediction lab ready."
}

ensure_ready() {
  ip netns list | awk '{print $1}' | grep -qx "$NS_A" || {
    echo "Run '$0 setup' first." >&2
    exit 1
  }
  curl -fsS "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/health" >/dev/null || {
    echo "Lab harness is not healthy; rerun setup." >&2
    exit 1
  }
}

stop_browsers() {
  local process_id
  for process_id in "$@"; do
    kill "$process_id" 2>/dev/null || true
  done
  sleep 0.2
  kill_namespace_processes "$NS_A"
  kill_namespace_processes "$NS_B"
}

consume_udp_mappings() {
  local namespace="$1"
  local count="$2"
  local index
  for index in $(seq 1 "$count"); do
    printf x | ip netns exec "$namespace" socat -u - \
      "UDP-DATAGRAM:$SIGNAL_ADDRESS:$((5000 + index))" >/dev/null 2>&1
  done
}

run_pair() {
  local profile_a="$1"
  local profile_b="$2"
  local mode="${3:-baseline}"
  local window_size="${4:-16}"
  local run_suffix="${5:-1}"
  local noise_mappings="${6:-0}"

  [[ "$mode" == "baseline" || "$mode" == "predict" || "$mode" == "predict-first" ]] || {
    echo "Mode must be baseline, predict, or predict-first." >&2
    exit 1
  }
  [[ "$window_size" =~ ^[0-9]+$ ]] && [[ "$window_size" -le 32 ]] || {
    echo "Prediction window must be an integer from 0 through 32." >&2
    exit 1
  }
  [[ "$noise_mappings" =~ ^[0-9]+$ ]] && [[ "$noise_mappings" -le 32 ]] || {
    echo "Noise mappings must be an integer from 0 through 32." >&2
    exit 1
  }

  ensure_ready
  stop_browsers
  apply_profile "$NAT_A" "$profile_a" 198.18.0.2 10.10.1.2
  apply_profile "$NAT_B" "$profile_b" 198.18.0.3 10.10.2.2

  local run_id="${profile_a}-${profile_b}-${mode}-${run_suffix}-n${noise_mappings}"
  curl -fsS -X POST -H 'content-type: application/json' \
    --data "{\"run\":\"$run_id\"}" \
    "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/reset" >/dev/null

  local profile_dir_a="$STATE_DIR/chrome-$run_id-a"
  local profile_dir_b="$STATE_DIR/chrome-$run_id-b"
  rm -rf "$profile_dir_a" "$profile_dir_b"

  local common_flags=(
    --headless=new
    --no-sandbox
    --disable-background-networking
    --disable-gpu
    --disable-dev-shm-usage
    --disable-extensions
    --no-first-run
    --no-default-browser-check
    --no-proxy-server
  )
  local hold_query=""
  if [[ "$noise_mappings" -gt 0 ]]; then hold_query='&hold=1'; fi
  local url_base="http://$SIGNAL_ADDRESS:$SIGNAL_PORT/?run=$run_id&mode=$mode&window=$window_size$hold_query"

  ip netns exec "$NS_A" chromium-browser "${common_flags[@]}" \
    --user-data-dir="$profile_dir_a" "$url_base&side=a&nat=$profile_a" \
    >/dev/null 2>&1 &
  local browser_a_pid="$!"
  ip netns exec "$NS_B" chromium-browser "${common_flags[@]}" \
    --user-data-dir="$profile_dir_b" "$url_base&side=b&nat=$profile_b" \
    >/dev/null 2>&1 &
  local browser_b_pid="$!"

  if [[ "$noise_mappings" -gt 0 ]]; then
    local ready="false"
    local ready_attempt
    for ((ready_attempt = 0; ready_attempt < 100; ready_attempt += 1)); do
      ready="$(curl -fsS "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/state?run=$run_id" | jq -r '.readyForRelease')"
      [[ "$ready" == "true" ]] && break
      sleep 0.1
    done
    if [[ "$ready" != "true" ]]; then
      stop_browsers "$browser_a_pid" "$browser_b_pid"
      echo "Browsers did not finish gathering before the noise gate." >&2
      exit 1
    fi
    if [[ "$profile_a" == "sequential" ]]; then
      consume_udp_mappings "$NS_A" "$noise_mappings"
    fi
    if [[ "$profile_b" == "sequential" ]]; then
      consume_udp_mappings "$NS_B" "$noise_mappings"
    fi
    curl -fsS -X POST -H 'content-type: application/json' \
      --data "{\"run\":\"$run_id\"}" \
      "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/release" >/dev/null
  fi

  local result=""
  local attempt
  for ((attempt = 0; attempt < 160; attempt += 1)); do
    result="$(curl -fsS "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/result?run=$run_id")"
    if jq -e '.complete == true' >/dev/null <<<"$result"; then
      break
    fi
    sleep 0.1
  done

  stop_browsers "$browser_a_pid" "$browser_b_pid"
  rm -rf "$profile_dir_a" "$profile_dir_b"
  if [[ -z "$result" ]]; then
    echo "Run did not return a result." >&2
    exit 1
  fi
  jq -c '.' <<<"$result"
}

run_matrix() {
  local repeats="${1:-3}"
  local window_size="${2:-16}"
  local output_file="$STATE_DIR/matrix.jsonl"
  : > "$output_file"
  local profile_a profile_b repetition
  for profile_a in cone restricted sequential random; do
    for profile_b in cone restricted sequential random; do
      for repetition in $(seq 1 "$repeats"); do
        run_pair "$profile_a" "$profile_b" baseline "$window_size" "$repetition" | tee -a "$output_file"
      done
    done
  done
  echo "$output_file"
}

run_calibration() {
  local repeats="${1:-3}"
  local output_file="$STATE_DIR/calibration.jsonl"
  : > "$output_file"
  local window_size repetition
  for window_size in 1 4 16 24 32; do
    for repetition in $(seq 1 "$repeats"); do
      run_pair sequential restricted predict "$window_size" "w${window_size}r${repetition}" | tee -a "$output_file"
      run_pair sequential sequential predict "$window_size" "w${window_size}r${repetition}" | tee -a "$output_file"
      run_pair sequential sequential predict-first "$window_size" "w${window_size}r${repetition}" | tee -a "$output_file"
    done
  done
  for repetition in $(seq 1 "$repeats"); do
    run_pair random restricted predict 16 "negative-r${repetition}" | tee -a "$output_file"
    run_pair sequential random predict-first 16 "negative-r${repetition}" | tee -a "$output_file"
    run_pair sequential cone predict-first 32 "regression-r${repetition}" | tee -a "$output_file"
  done
  echo "$output_file"
}

run_survey() {
  local profile="$1"
  local samples="${2:-6}"
  local stun_destinations="${3:-3}"
  [[ "$samples" =~ ^[0-9]+$ ]] && [[ "$samples" -ge 3 ]] && [[ "$samples" -le 12 ]] || {
    echo "Survey samples must be an integer from 3 through 12." >&2
    exit 1
  }
  [[ "$stun_destinations" == "2" || "$stun_destinations" == "3" ]] || {
    echo "Survey STUN destination count must be 2 or 3." >&2
    exit 1
  }
  ensure_ready
  stop_browsers
  apply_profile "$NAT_A" "$profile" 198.18.0.2 10.10.1.2
  curl -fsS -X POST "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/survey-reset" >/dev/null

  local profile_dir="$STATE_DIR/chrome-survey-$profile"
  local stun_query=""
  if [[ "$stun_destinations" == "2" ]]; then
    stun_query='&stun=stun%3A198.18.0.10%3A3478&stun=stun%3A198.18.0.11%3A3478'
  fi
  rm -rf "$profile_dir"
  ip netns exec "$NS_A" chromium-browser \
    --headless=new \
    --no-sandbox \
    --disable-background-networking \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-extensions \
    --no-first-run \
    --no-default-browser-check \
    --no-proxy-server \
    --user-data-dir="$profile_dir" \
    "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/survey?samples=$samples$stun_query" \
    >/dev/null 2>&1 &
  local browser_pid="$!"

  local result=""
  local attempt
  for ((attempt = 0; attempt < 300; attempt += 1)); do
    result="$(curl -fsS "http://$SIGNAL_ADDRESS:$SIGNAL_PORT/api/survey-summary")"
    if jq -e '.total >= 1' >/dev/null <<<"$result"; then
      break
    fi
    sleep 0.1
  done
  stop_browsers "$browser_pid"
  rm -rf "$profile_dir"
  jq -c --arg profile "$profile" '{profile: $profile, survey: .}' <<<"$result"
}

case "${1:-}" in
  setup)
    setup
    ;;
  pair)
    require_root
    require_commands
    run_pair "${2:?profile A required}" "${3:?profile B required}" "${4:-baseline}" "${5:-16}" "${6:-1}" "${7:-0}"
    ;;
  matrix)
    require_root
    require_commands
    ensure_ready
    run_matrix "${2:-3}" "${3:-16}"
    ;;
  calibrate)
    require_root
    require_commands
    ensure_ready
    run_calibration "${2:-3}"
    ;;
  survey)
    require_root
    require_commands
    run_survey "${2:?profile required}" "${3:-6}" "${4:-3}"
    ;;
  cleanup)
    require_root
    cleanup
    ;;
  *)
    echo "Usage: $0 {setup|pair PROFILE_A PROFILE_B [baseline|predict|predict-first] [WINDOW] [RUN] [NOISE_MAPPINGS]|matrix [REPEATS] [WINDOW]|calibrate [REPEATS]|survey PROFILE [SAMPLES] [STUN_DESTINATIONS]|cleanup}" >&2
    exit 1
    ;;
esac
