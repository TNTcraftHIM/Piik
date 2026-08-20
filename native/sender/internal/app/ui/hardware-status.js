export const HARDWARE_PREFERENCE = "prefer-hardware";

export const HARDWARE_STATUS = Object.freeze({
  UNREQUESTED: "unrequested",
  PREFERENCE_ACCEPTED: "preference-accepted",
  FALLBACK: "fallback",
  UNSUPPORTED: "unsupported",
  UNVERIFIED: "hardware-unverified",
});

export function retainsHardwarePreference(support) {
  return support?.supported === true &&
    support.config?.hardwareAcceleration === HARDWARE_PREFERENCE;
}
