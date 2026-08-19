export interface VideoCodecEvidence {
  codec: string | null;
  profile: string | null;
  parameters: string | null;
}

interface CodecParameterRule {
  profileKey: string | null;
  parameterKeys: readonly string[];
  validators: Readonly<Record<string, RegExp>>;
}

const VIDEO_CODEC_PARAMETER_RULES: Readonly<
  Record<string, CodecParameterRule>
> = {
  "video/h264": {
    profileKey: "profile-level-id",
    parameterKeys: ["packetization-mode", "level-asymmetry-allowed"],
    validators: {
      "profile-level-id": /^[0-9a-f]{6}$/,
      "packetization-mode": /^[0-2]$/,
      "level-asymmetry-allowed": /^[01]$/,
    },
  },
  "video/vp9": {
    profileKey: "profile-id",
    parameterKeys: ["max-fr", "max-fs"],
    validators: {
      "profile-id": /^[0-3]$/,
      "max-fr": /^[1-9][0-9]{0,9}$/,
      "max-fs": /^[1-9][0-9]{0,9}$/,
    },
  },
  "video/vp8": {
    profileKey: null,
    parameterKeys: ["max-fr", "max-fs"],
    validators: {
      "max-fr": /^[1-9][0-9]{0,9}$/,
      "max-fs": /^[1-9][0-9]{0,9}$/,
    },
  },
  "video/av1": {
    profileKey: "profile",
    parameterKeys: ["level-idx", "tier"],
    validators: {
      profile: /^[0-2]$/,
      "level-idx": /^(?:[0-9]|[12][0-9]|3[01])$/,
      tier: /^[01]$/,
    },
  },
};

const VIDEO_MIME_TYPE = /^video\/[A-Za-z0-9.+-]{1,32}$/i;

export function deriveVideoCodecEvidence(
  codec: string | null,
  rawParameters: string | null,
): VideoCodecEvidence {
  if (!codec || !VIDEO_MIME_TYPE.test(codec)) {
    return { codec: null, profile: null, parameters: null };
  }
  const rule = VIDEO_CODEC_PARAMETER_RULES[codec.toLowerCase()];
  if (!rule || !rawParameters || rawParameters.length > 2_048) {
    return { codec, profile: null, parameters: null };
  }

  const segments = rawParameters.split(";");
  if (segments.length > 32) {
    return { codec, profile: null, parameters: null };
  }
  const values = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = segment.slice(0, separator).trim().toLowerCase();
    const validator = rule.validators[key];
    if (!validator) {
      continue;
    }
    if (seenKeys.has(key)) {
      values.delete(key);
      continue;
    }
    seenKeys.add(key);
    const value = segment.slice(separator + 1).trim().toLowerCase();
    if (validator.test(value)) {
      values.set(key, value);
    }
  }

  const profileValue = rule.profileKey
    ? values.get(rule.profileKey)
    : undefined;
  const parameters = rule.parameterKeys
    .flatMap((key) => {
      const value = values.get(key);
      return value ? [`${key}=${value}`] : [];
    })
    .join("; ");
  return {
    codec,
    profile:
      rule.profileKey && profileValue
        ? `${rule.profileKey}=${profileValue}`
        : null,
    parameters: parameters || null,
  };
}

export function isCanonicalVideoCodecEvidence(value: {
  codec: string | null;
  codecProfile: string | null;
  codecParameters: string | null;
}): boolean {
  const rule = value.codec
    ? VIDEO_CODEC_PARAMETER_RULES[value.codec.toLowerCase()]
    : undefined;
  if (!rule) {
    return value.codecProfile === null && value.codecParameters === null;
  }
  return (
    canonicalValuesMatch(
      value.codecProfile,
      rule.profileKey ? [rule.profileKey] : [],
      rule.validators,
    ) &&
    canonicalValuesMatch(
      value.codecParameters,
      rule.parameterKeys,
      rule.validators,
    )
  );
}

function canonicalValuesMatch(
  encoded: string | null,
  orderedKeys: readonly string[],
  validators: Readonly<Record<string, RegExp>>,
): boolean {
  if (encoded === null) {
    return true;
  }
  const segments = encoded.split("; ");
  if (segments.length > orderedKeys.length) {
    return false;
  }
  let previousKeyIndex = -1;
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    const key = separator < 1 ? "" : segment.slice(0, separator);
    const keyIndex = orderedKeys.indexOf(key);
    const candidate = separator < 1 ? "" : segment.slice(separator + 1);
    if (
      keyIndex <= previousKeyIndex ||
      keyIndex < 0 ||
      !validators[key]?.test(candidate)
    ) {
      return false;
    }
    previousKeyIndex = keyIndex;
  }
  return true;
}
