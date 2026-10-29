import {
  buildMangroveSubjectUri,
  type MangroveReviewPayload,
  matchesMangrovePayload,
  normalizeMangrovePayload,
  signMangroveReview,
  verifyMangroveReview,
} from "@openmapx/mangrove-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { keypairOwner, useKeypairStore } from "./keypairStore";
import { useMangroveCurrentUser, useMangroveTransport } from "./provider";
import { useMangroveSigner } from "./signerProvider";
import { useUserKeypair } from "./useKeypair";

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

/**
 * Mutation: sign a Mangrove JWT locally with the user's keypair and post it
 * through the host transport. Invalidates the matching `placeReviews` /
 * `placeReviewAggregate` queries on success.
 */
export function useSubmitReview() {
  const qc = useQueryClient();
  const transport = useMangroveTransport();
  const currentUser = useMangroveCurrentUser();
  const { keypair } = useUserKeypair();
  const signer = useMangroveSigner();
  const lifetime = useRef(new AbortController());
  const authority = useRef(currentUser);
  authority.current = currentUser;
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  // Default nickname from the host-provided session — explicit `input.nickname`
  // still wins so callers can override per-submission.
  const sessionNickname = currentUser?.nickname?.trim() || null;

  return useMutation({
    mutationFn: async (input: SubmitReviewInput): Promise<{ id: string }> => {
      const owner = currentUser;
      const signal = lifetime.current.signal;
      const assertOwner = () => {
        if (!owner || authority.current !== owner || signal.aborted)
          throw new Error("Review session changed. Please try again.");
      };
      assertOwner();
      if (signer.mode === "local" && !keypair) throw new Error("Unlock your review key first.");

      let sub: string;
      if (input.action && input.editTargetId) {
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

      const normalized = structuredClone(normalizeMangrovePayload(payload));
      let jwt: string;
      let submitSignal = signal;
      if (signer.mode === "signer") {
        if (!signer.controller) throw new Error("Connect to Mangrove first.");
        const result = await signer.controller.sign(normalized);
        const verified = await verifyMangroveReview({ jwt: result.jwt, kid: result.publicPem });
        result.assertCurrent();
        submitSignal = AbortSignal.any([signal, result.signal]);
        assertOwner();
        if (!verified.ok || !matchesMangrovePayload(verified.payload, normalized))
          throw new Error("Mangrove returned an invalid signed review.");
        jwt = result.jwt;
      } else {
        const binding = useKeypairStore.getState().getSigningSnapshot(keypairOwner(currentUser));
        if (!binding || !useKeypairStore.getState().touch(binding))
          throw new Error("Unlock your review key first.");
        submitSignal = AbortSignal.any([signal, binding.signal]);
        jwt = await signMangroveReview(normalized, binding.keypair);
        assertOwner();
        if (!useKeypairStore.getState().isCurrent(binding))
          throw new Error("Review key changed. Unlock it again.");
      }
      assertOwner();
      return transport.submitReview(
        {
          jwt,
          invalidate: {
            lat: input.subject.lat,
            lng: input.subject.lng,
            name: input.subject.name,
            osmId: input.subject.osmId,
          },
        },
        { signal: submitSignal },
      );
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: ["placeReviews", vars.subject.lat, vars.subject.lng, vars.subject.name],
      });
      void qc.invalidateQueries({
        queryKey: ["placeReviewAggregate", vars.subject.lat, vars.subject.lng, vars.subject.name],
      });
    },
  });
}
