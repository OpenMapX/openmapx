export interface PrivacyReleaseValidationEvidence {
  version: number;
  sourceBuildFingerprint: string;
  validatedAt: string;
  checks: {
    translationsConsistent: boolean;
    openApiConsistent: boolean;
    policyConsistent: boolean;
  };
}

export function validatePrivacyRelease(options?: {
  repoRoot?: string;
  fingerprint?: () => Promise<string>;
  runCheck?: (command: string) => boolean | Promise<boolean>;
}): Promise<PrivacyReleaseValidationEvidence>;
