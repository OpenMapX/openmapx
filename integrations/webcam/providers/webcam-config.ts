export interface CameraSourceCredentials {
  "se-trafikverket-api-key"?: string;
  "no-npra-username"?: string;
  "no-npra-password"?: string;
  "au-nsw-webcam-api-key"?: string;
  "tw-tdx-webcam-client-id"?: string;
  "tw-tdx-webcam-client-secret"?: string;
}

let credentials: CameraSourceCredentials = {};

export function setCameraSourceCredentials(next: CameraSourceCredentials): void {
  credentials = next;
}

export function credential(name: keyof CameraSourceCredentials): string | undefined {
  return credentials[name];
}
