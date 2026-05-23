/**
 * Shared types for the `reviews` domain.
 *
 * Providers (e.g. reviews-mangrove) implement `ReviewProvider` and are
 * discovered via `ctx.getIntegrationsByDomain("reviews")`.
 */

export type {
  Review,
  ReviewAction,
  ReviewAggregate,
  ReviewAuthor,
  ReviewImage,
  ReviewMetadata,
  ReviewProvider,
  ReviewSubject,
} from "@openmapx/integration-framework";
