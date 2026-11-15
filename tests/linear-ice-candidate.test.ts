import { afterEach, expect, test, vi } from "vitest";
import { LinearCandidateAdmission, currentCandidateGeneration } from "../src/client/webrtc/linear-ice-candidate";
import { recordLinearCandidate, remoteCandidateTraversalPath, observeDebugConnection } from "../src/client/lib/debug-webrtc";
import { ChannelTransport } from "../src/client/channel/transport";
import { signalSchema } from "../src/client/channel/protocol";
const sdp = (ufrag = "current") => `v=0\r\na=group:BUNDLE data video\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=ice-ufrag:${ufrag}\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\n`;
const candidate = (port: number, usernameFragment = "current") => ({ candidate: `candidate:base 1 udp 100 203.0.113.7 ${port} typ srflx raddr 192.0.2.7 rport 50000`, sdpMid: "data", usernameFragment, origin: "linear" as const });
const nativeCandidate = (port: number, usernameFragment = "current") => {
  const { sdpMid: _mid, ...value } = candidate(port, usernameFragment);
  return { ...value, sdpMLineIndex: 0 };
};
const nativeSdp = () => sdp().replace("BUNDLE data video", "BUNDLE LXg video").replace("a=mid:data", "a=mid:LXg");
const pc = () => ({connectionState:"new", iceConnectionState:"checking", remoteDescription:{type:"offer",sdp:sdp()}} as RTCPeerConnection);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test("linear gates use accepted SDP generation and one lifetime target allowance", () => {
  vi.spyOn(performance,"now").mockReturnValue(0);
  const gate = new LinearCandidateAdmission(), connection = pc();
  expect(gate.admit(connection,candidate(40000,"old"))).toBe(false);
  expect(currentCandidateGeneration(connection,{...candidate(40000),sdpMid:"video"})).toBe(true);
  expect(currentCandidateGeneration(connection,{...candidate(40000),sdpMid:"missing"})).toBe(false);
  Object.defineProperty(connection,"remoteDescription",{value:{type:"offer",sdp:nativeSdp()},configurable:true});
  expect(gate.admit(connection,nativeCandidate(40000))).toBe(true);
  for(let i=1;i<16;i++) expect(gate.admit(connection,nativeCandidate(40000+i))).toBe(true);
  expect(gate.admit(connection,candidate(40000))).toBe(false);
  Object.defineProperty(connection,"remoteDescription",{value:{type:"offer",sdp:sdp("next")},configurable:true});
  expect(gate.admit(connection,candidate(45000,"next"))).toBe(false);
});
test("linear append window does not restart and terminal ICE stops additional candidates", () => {
  const clock=vi.spyOn(performance,"now").mockReturnValue(0), connection=pc(), gate=new LinearCandidateAdmission();
  clock.mockReturnValue(5000);expect(gate.admit(connection,candidate(40000))).toBe(false);
  clock.mockReturnValue(0);
  for(const state of ["connected","completed","failed","closed"] as RTCIceConnectionState[]) {
    Object.defineProperty(connection,"iceConnectionState",{value:state,configurable:true});
    expect(new LinearCandidateAdmission().admit(connection,candidate(40000))).toBe(false);
  }
});
test("typed linear diagnostics correlate the actual tuple without changing its foundation", () => {
  const connection=pc(), release=observeDebugConnection(connection,{});
  recordLinearCandidate(connection,candidate(40000));
  const remote={foundation:"base",address:"203.0.113.7",port:40000,protocol:"udp"};
  expect(remoteCandidateTraversalPath(connection,remote)).toBe("predicted");
  expect(remoteCandidateTraversalPath(connection,{foundation:"base"})).toBe("unknown");
  expect(remoteCandidateTraversalPath(connection,{...remote,port:40001})).toBe("ordinary");
  Object.defineProperty(connection,"remoteDescription",{value:{type:"offer",sdp:sdp("next")},configurable:true});
  expect(remoteCandidateTraversalPath(connection,remote)).toBe("unknown");
  release();expect(remoteCandidateTraversalPath(connection,remote)).toBe("ordinary");
});
class Peer extends EventTarget {
  connectionState="new";iceConnectionState="checking";signalingState="stable";remoteDescription:RTCSessionDescriptionInit|null=null;localDescription:RTCSessionDescriptionInit|null=null;
  addIceCandidate=vi.fn(async (_candidate:RTCIceCandidateInit) => {});
  setRemoteDescription=vi.fn(async (value:RTCSessionDescriptionInit)=>{this.remoteDescription=value;});
  setLocalDescription=vi.fn(async (value:RTCSessionDescriptionInit)=>{this.localDescription=value;});
  createAnswer=vi.fn(async()=>({type:"answer" as const,sdp:sdp()}));
  getStats=vi.fn(async()=>new Map());getSenders=()=>[];getReceivers=()=>[];getTransceivers=()=>[];close=vi.fn();
}
test("pre-SDP linear origin survives flush, API rejection spends a slot and ordinary ICE stays usable",async()=>{
  vi.stubGlobal("RTCPeerConnection",Peer);
  const transport=new ChannelTransport({polite:true,iceServers:[],send:vi.fn(),receive:vi.fn(),connected:vi.fn(),base:vi.fn(),failed:vi.fn()});
  const peer=transport.pc as unknown as Peer;
  try {
    peer.addIceCandidate.mockRejectedValueOnce(new DOMException("rejected","OperationError"));
    for(let i=0;i<17;i++)transport.signal({candidate:nativeCandidate(40000+i)});
    transport.signal({exchangeId:crypto.randomUUID(),description:{type:"offer",sdp:nativeSdp()}});
    await vi.waitFor(()=>expect(peer.addIceCandidate).toHaveBeenCalledTimes(16));
    for(const [input] of peer.addIceCandidate.mock.calls) {
      expect(input).not.toHaveProperty("origin");
      expect(input).not.toHaveProperty("sdpMid");
      expect(input.sdpMLineIndex).toBe(0);
      expect(input.usernameFragment).toBe("current");
    }
    transport.signal({candidate:{...candidate(46000),origin:undefined}});
    await vi.waitFor(()=>expect(peer.addIceCandidate).toHaveBeenCalledTimes(17));
    expect(peer.close).not.toHaveBeenCalled();
  } finally {transport.close();}
});
test("wire linear metadata requires a candidate and generation",()=>{
  expect(signalSchema.safeParse({candidate:candidate(40000)}).success).toBe(true);
  expect(signalSchema.safeParse({candidate:nativeCandidate(40000)}).success).toBe(true);
  expect(signalSchema.safeParse({candidate:{...candidate(40000),usernameFragment:null}}).success).toBe(false);
  expect(signalSchema.safeParse({candidate:{...candidate(40000),candidate:""}}).success).toBe(false);
});
