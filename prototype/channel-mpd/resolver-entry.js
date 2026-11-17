import {
  stringToMpdXml,
  inheritAttributes,
  toPlaylists,
  toM3u8,
} from "mpd-parser";
import { XMLSerializer } from "@xmldom/xmldom";
const children = (node, name) =>
  Array.from(node.childNodes).filter(
    (n) => n.nodeType === 1 && n.localName === name,
  );
function document(xml, uri) {
  const root = stringToMpdXml(xml);
  if (
    (root.getAttribute("type") || "static") !== "static" ||
    root.getElementsByTagNameNS("*", "ContentProtection").length
  )
    throw Error("unsupported_mpd");
  for (const n of [root, ...Array.from(root.getElementsByTagName("*"))])
    for (const a of Array.from(n.attributes || []))
      if (
        a.namespaceURI === "http://www.w3.org/1999/xlink" &&
        a.localName === "href"
      )
        throw Error("external_mpd");
  let ordinal = 0;
  for (const p of children(root, "Period"))
    for (const a of children(p, "AdaptationSet"))
      for (const r of children(a, "Representation"))
        r.setAttribute("piikSourceNode", String(ordinal++));
  const inherited = inheritAttributes(root, { manifestUri: uri });
  return { root, inherited };
}
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);
function catalog(d) {
  const infos = d.inherited.representationInfo;
  // Let the public parser's logical-playlist conversion own cross-Period grouping.
  // Empty metadata playlists avoid expanding all unselected segment timelines.
  const logical = toM3u8({
    dashPlaylists: infos.map((r) => ({
      attributes: { ...r.attributes },
      segments: [],
    })),
  });
  const allStarts = [
    ...new Set(
      infos
        .filter((r) =>
          ["video", "audio"].includes(
            (r.attributes.mimeType || "").split("/")[0],
          ),
        )
        .map((r) => r.attributes.periodStart),
    ),
  ];
  const candidates = [
    ...(logical.playlists || []).map((p) => ({
      p,
      kind: "video",
      language: "",
    })),
    ...Object.values(logical.mediaGroups?.AUDIO || {}).flatMap((g) =>
      Object.values(g).flatMap((a) =>
        a.playlists.map((p) => ({
          p,
          kind: "audio",
          language: a.language || "",
        })),
      ),
    ),
  ];
  return candidates.flatMap(({ p, kind, language }) => {
    const indices = infos.flatMap((r, i) => {
      const a = r.attributes;
      return a.id === p.attributes.NAME &&
        a.baseUrl === p.resolvedUri &&
        (a.lang || "") === language &&
        (a.mimeType || "").split("/")[0] === kind
        ? [i]
        : [];
    });
    const values = indices.map((i) => infos[i].attributes),
      starts = values.map((a) => a.periodStart);
    if (
      starts.length !== allStarts.length ||
      new Set(starts).size !== allStarts.length ||
      allStarts.some((t) => !starts.includes(t))
    )
      return [];
    const first = values[0];
    if (
      values.some(
        (a) => a.mimeType !== first.mimeType || a.codecs !== first.codecs,
      )
    )
      return [];
    return [
      {
        indices,
        kind,
        label: first.label || first.id || "",
        mimeType: first.mimeType,
        codec: first.codecs || "",
        language,
        role: first.role?.value || "",
        width: positive(first.width),
        height: positive(first.height),
        bandwidth: positive(first.bandwidth),
        frameRate: positive(first.frameRate),
      },
    ];
  });
}
globalThis.inspectMpd = (xml, uri) =>
  JSON.stringify(catalog(document(xml, uri)));
const resource = (r) =>
  r ? { url: r.resolvedUri, range: r.byterange ?? null } : null;
globalThis.resolveMpd = (xml, uri, indicesJson) => {
  const d = document(xml, uri),
    indices = JSON.parse(indicesJson),
    selected = indices.map((i) => d.inherited.representationInfo[i]);
  if (selected.some((x) => !x)) throw Error("invalid_choice");
  return JSON.stringify(
    toPlaylists(selected).map((p, i) => ({
      index: indices[i],
      mimeType: p.attributes.mimeType,
      period: p.attributes.periodStart,
      codecs: p.attributes.codecs || "",
      indexResource: resource(p.sidx),
      indexInit: resource(p.sidx?.map),
      segments: p.segments.map((s) => ({
        resource: resource(s),
        initialization: resource(s.map),
        duration: s.duration,
        presentationTime: s.presentationTime,
        timeline: s.timeline,
      })),
    })),
  );
};
// Serialization is added at the same trusted manifest boundary, not by a Viewer URL recipe.
export { document, catalog, children, XMLSerializer };
globalThis.serializeMpd = (xml, uri, indicesJson, bindingsJson) => {
  const d = document(xml, uri),
    indices = JSON.parse(indicesJson),
    bindings = JSON.parse(bindingsJson),
    infos = d.inherited.representationInfo,
    selected = indices.map((i) => infos[i]);
  const tracks = toPlaylists(selected),
    byNode = new Map();
  for (let i = 0; i < selected.length; i++) {
    const k = String(selected[i].attributes.piikSourceNode);
    if (byNode.has(k)) throw Error("ambiguous_base");
    byNode.set(k, { info: selected[i], track: tracks[i] });
  }
  const opaque = (u) => {
    const id = bindings[u];
    if (typeof id !== "string" || !/[0-9a-f-]{36}/.test(id))
      throw Error("unadmitted_resource");
    return id;
  };
  const mergeAddress = (r, p, a, name) => {
    let merged;
    for (const n of [p, a, r]) {
      const node = children(n, name)[0];
      if (!node) continue;
      if (!merged) merged = node.cloneNode(true);
      else {
        for (const at of Array.from(node.attributes))
          merged.setAttributeNS(at.namespaceURI, at.name, at.value);
        for (const c of Array.from(node.childNodes).filter(
          (x) => x.nodeType === 1,
        )) {
          for (const old of children(merged, c.localName))
            merged.removeChild(old);
          merged.appendChild(c.cloneNode(true));
        }
      }
    }
    return merged;
  };
  const setRange = (node, range) => {
    if (range)
      node.setAttribute(
        "range",
        range.offset + "-" + (range.offset + range.length - 1),
      );
    else node.removeAttribute("range");
  };
  for (const period of children(d.root, "Period"))
    for (const adaptation of children(period, "AdaptationSet")) {
      for (const r of children(adaptation, "Representation")) {
        const item = byNode.get(r.getAttribute("piikSourceNode"));
        if (!item) {
          adaptation.removeChild(r);
          continue;
        }
        const { info, track } = item;
        const base = mergeAddress(r, period, adaptation, "SegmentBase"),
          template = mergeAddress(r, period, adaptation, "SegmentTemplate"),
          list = mergeAddress(r, period, adaptation, "SegmentList");
        for (const name of [
          "BaseURL",
          "SegmentBase",
          "SegmentTemplate",
          "SegmentList",
        ])
          for (const n of children(r, name)) r.removeChild(n);
        r.removeAttribute("piikSourceNode");
        if (track.sidx) {
          if (!base) throw Error("missing_index");
          const b = r.ownerDocument.createElementNS(
            d.root.namespaceURI,
            "BaseURL",
          );
          b.textContent = opaque(track.sidx.resolvedUri);
          r.appendChild(b);
          const init = children(base, "Initialization")[0];
          if (init && track.sidx.map) {
            init.setAttribute("sourceURL", opaque(track.sidx.map.resolvedUri));
            setRange(init, track.sidx.map.byterange);
          }
          r.appendChild(base);
        } else {
          if (!track.segments.length) throw Error("unsupported_address");
          const address = template || list;
          if (!address) throw Error("unsupported_address");
          const normalized = r.ownerDocument.createElementNS(
            d.root.namespaceURI,
            "SegmentList",
          );
          for (const at of Array.from(address.attributes))
            if (
              ![
                "media",
                "initialization",
                "index",
                "bitstreamSwitching",
              ].includes(at.name)
            )
              normalized.setAttributeNS(at.namespaceURI, at.name, at.value);
          for (const t of children(address, "SegmentTimeline"))
            normalized.appendChild(t.cloneNode(true));
          const first = track.segments[0].map;
          if (first) {
            const init = r.ownerDocument.createElementNS(
              d.root.namespaceURI,
              "Initialization",
            );
            init.setAttribute("sourceURL", opaque(first.resolvedUri));
            setRange(init, first.byterange);
            normalized.appendChild(init);
          }
          for (const segment of track.segments) {
            if (first && segment.map?.resolvedUri !== first.resolvedUri)
              throw Error("changing_init");
            const part = r.ownerDocument.createElementNS(
              d.root.namespaceURI,
              "SegmentURL",
            );
            part.setAttribute("media", opaque(segment.resolvedUri));
            if (segment.byterange)
              part.setAttribute(
                "mediaRange",
                segment.byterange.offset +
                  "-" +
                  (segment.byterange.offset + segment.byterange.length - 1),
              );
            normalized.appendChild(part);
          }
          r.appendChild(normalized);
        }
      }
      for (const name of [
        "BaseURL",
        "SegmentBase",
        "SegmentTemplate",
        "SegmentList",
      ])
        for (const n of children(adaptation, name)) adaptation.removeChild(n);
      if (!children(adaptation, "Representation").length)
        period.removeChild(adaptation);
    }
  for (const period of children(d.root, "Period"))
    for (const name of [
      "BaseURL",
      "SegmentBase",
      "SegmentTemplate",
      "SegmentList",
    ])
      for (const n of children(period, name)) period.removeChild(n);
  for (const name of [
    "BaseURL",
    "Location",
    "UTCTiming",
    "ContentSteering",
    "PatchLocation",
    "Metrics",
  ])
    for (const n of children(d.root, name)) d.root.removeChild(n);
  return new XMLSerializer().serializeToString(d.root);
};
