export const POLICY_EFFECTIVE_DATE = "2026-10-03";

export const CURRENT_POLICY_VERSIONS = Object.freeze({
  termsVersion: "2026-10-03",
  privacyVersion: "2026-10-03",
  dataUseVersion: "2026-10-03",
  guideVersion: "2026-10-03",
});

export function acknowledgementsComplete(value) {
  return (
    value?.termsAccepted === true &&
    value?.privacyAccepted === true &&
    value?.dataAuthorityAccepted === true &&
    value?.guideAcknowledged === true
  );
}

export function createCurrentPolicyAcceptance(acceptedAt = new Date()) {
  return {
    ...CURRENT_POLICY_VERSIONS,
    acceptedAt: new Date(acceptedAt).toISOString(),
  };
}

export function policyStatus(acceptance) {
  const acceptedAt = acceptance?.acceptedAt
    ? new Date(acceptance.acceptedAt)
    : null;

  const current =
    Boolean(acceptedAt) &&
    !Number.isNaN(acceptedAt?.getTime()) &&
    acceptance?.termsVersion === CURRENT_POLICY_VERSIONS.termsVersion &&
    acceptance?.privacyVersion === CURRENT_POLICY_VERSIONS.privacyVersion &&
    acceptance?.dataUseVersion === CURRENT_POLICY_VERSIONS.dataUseVersion &&
    acceptance?.guideVersion === CURRENT_POLICY_VERSIONS.guideVersion;

  return {
    required: !current,
    effectiveDate: POLICY_EFFECTIVE_DATE,
    ...CURRENT_POLICY_VERSIONS,
    acceptedAt: current ? acceptedAt.toISOString() : null,
  };
}
