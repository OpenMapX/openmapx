import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { useSession } from "../auth/useSession";
import type { MangroveReviewPayload } from "../mangrove/sign";
import { signMangroveReview } from "../mangrove/sign";
import { buildMangroveSubjectUri } from "../mangrove/subject";
import { useUserKeypair } from "./useUserKeypair";

export interface SubmitReviewInput {
  subject: { lat: number; lng: number; name: string; osmId?: string };
  /** 0..5 stars — converted to Mangrove's 0..100 scale (0/20/40/60/80/100). */
  stars?: number;
  /** Free-form opinion text (≤1000 chars enforced by the signer). */
  opinion?: string;
  /** Already-uploaded image URLs (call `useUploadReviewImage` first). */
  images?: { src: string; label?: string }[];
  /** Optional metadata — nickname, experience, affiliation flag, license. */
  nickname?: string;
  /** Mangrove `metadata.experience_context`. Free-form, but see EXPERIENCE_CONTEXT_GEO. */
  experience?: string;
  isAffiliated?: boolean;
  license?: "CC-BY-4.0" | "CC-BY-SA-4.0";
  /** For edits/deletes: target another review by its id (signature). */
  editTargetId?: string;
  action?: "edit" | "delete" | "report_abuse";
}

interface SubmitResponse {
  id: string;
}

/**
 * Mutation: sign a Mangrove JWT locally with the user's keypair and post it
 * through our backend proxy. Invalidates the relevant queries on success.
 */
export function useSubmitReview() {
  const qc = useQueryClient();
  const { keypair } = useUserKeypair();
  const { data: session } = useSession();
  // Default nickname from the Better Auth profile — explicit `input.nickname`
  // still wins so callers can override per-submission.
  const sessionNickname = session?.user?.name?.trim();

  return useMutation({
    mutationFn: async (input: SubmitReviewInput): Promise<SubmitResponse> => {
      if (!keypair) {
        throw new Error("Not signed in. A Mangrove keypair is required to submit a review.");
      }

      let sub: string;
      if (input.action && input.editTargetId) {
        // edits / deletes / abuse reports target another review by signature
        sub = `urn:maresi:${input.editTargetId}`;
      } else {
        sub = buildMangroveSubjectUri(input.subject);
      }

      const payload: MangroveReviewPayload = {
        sub,
        // Mangrove rating is an integer 0..100 (spec: int16, [0..100]). Our 0..5
        // star UI maps linearly — 0★ → 0, 5★ → 100. A value of 0 is a valid
        // "terrible" rating and MUST be sent (not elided as falsy).
        rating: input.stars !== undefined ? Math.round(input.stars) * 20 : undefined,
        opinion: input.opinion?.trim() || undefined,
        images: input.images?.length ? input.images : undefined,
        action: input.action,
        metadata: {
          nickname: input.nickname?.trim() || sessionNickname?.slice(0, 50) || undefined,
          experience_context: input.experience,
          is_affiliated: input.isAffiliated || undefined,
          osm_id: input.subject.osmId,
          license: input.license ?? "CC-BY-4.0",
        },
      };

      const jwt = await signMangroveReview(payload, keypair);
      return apiClient.post<SubmitResponse>(API_ENDPOINTS.reviewSubmit, {
        jwt,
        invalidate: { lat: input.subject.lat, lng: input.subject.lng, name: input.subject.name },
      });
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["placeReviews", vars.subject.lat, vars.subject.lng, vars.subject.name],
      });
      qc.invalidateQueries({
        queryKey: ["placeReviewAggregate", vars.subject.lat, vars.subject.lng, vars.subject.name],
      });
    },
  });
}
