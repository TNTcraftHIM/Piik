export function deliveryEffect(metadata, payload) {
  const effect = JSON.parse(metadata);
  if (payload !== undefined) {
    if ("frame" in effect) effect.frame = payload;
    else if ("bytes" in effect) effect.bytes = payload;
    else effect.result.bytes = payload;
  }
  return effect;
}
