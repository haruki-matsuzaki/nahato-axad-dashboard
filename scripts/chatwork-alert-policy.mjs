export const chatworkAlertPolicy = Object.freeze({
  enabled: false,
  disabledReason: "temporarily_disabled_by_request",
});

export function isChatworkAlertEnabled() {
  return chatworkAlertPolicy.enabled;
}
