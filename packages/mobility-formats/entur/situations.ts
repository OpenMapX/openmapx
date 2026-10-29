import type {
  SituationFieldsFragment,
  SituationStopFieldsFragment,
} from "./journey-planner.generated.js";

/** Read the current affects union, including dated-only service journeys. */
export function affectedLineIds(situation: SituationFieldsFragment): string[] {
  const ids = situation.affects.flatMap((affect) => {
    switch (affect.__typename) {
      case "AffectedLine":
      case "AffectedStopPlaceOnLine":
        return affect.line?.id ? [affect.line.id] : [];
      case "AffectedServiceJourney":
      case "AffectedStopPlaceOnServiceJourney": {
        const id =
          affect.serviceJourney?.line.id ?? affect.datedServiceJourney?.serviceJourney?.line.id;
        return id ? [id] : [];
      }
      default:
        return [];
    }
  });
  return [...new Set(ids)];
}

/** Stop places, quays and their parents share this generated coordinate selection. */
export function affectedStops(situation: SituationFieldsFragment): SituationStopFieldsFragment[] {
  return situation.affects.flatMap((affect) => {
    if (!("stopPlace" in affect)) return [];
    return [affect.stopPlace, affect.quay, affect.quay?.stopPlace].filter(
      (stop): stop is NonNullable<typeof stop> => stop != null,
    );
  });
}
