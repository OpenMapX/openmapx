import type {
  EvChargingConnector,
  EvChargingTariff,
  EvTariffConnectorGroup,
} from "@openmapx/mobility-core/ev-charging";
import { groupConnectors } from "./utils.js";

/**
 * Content key for a tariff, ignoring the connectors it was seen on. Several
 * EVSEs of one station routinely resolve to byte-identical tariffs (OCPDB emits
 * one association per EVSE; the OCPI feeds repeat the same `tariff_ids` on every
 * connector), so the payload must carry one copy per distinct tariff — with the
 * connectors of every EVSE that resolved to it folded in.
 */
function tariffKey(tariff: EvChargingTariff): string {
  return JSON.stringify({
    elements: tariff.elements,
    restrictions: tariff.restrictions,
    isDirectPayment: tariff.isDirectPayment,
    scope: tariff.scope,
    source: tariff.source,
    altText: tariff.altText,
    sourceUrl: tariff.sourceUrl,
  });
}

/** Identity of a connector group for set comparison — quantity deliberately excluded. */
function groupKey(group: EvTariffConnectorGroup): string {
  return `${group.type ?? ""}|${group.powerKw ?? ""}|${group.currentType ?? ""}`;
}

function toGroups(connectors: EvChargingConnector[]): EvTariffConnectorGroup[] {
  return groupConnectors(connectors).map((conn) => ({
    type: conn.type,
    powerKw: conn.powerKw,
    currentType: conn.currentType,
    quantity: conn.quantity,
  }));
}

export interface TariffCollector {
  /**
   * Records that `connectors` (one EVSE's, or a single connector's) are priced
   * by `tariffs`. Call once per EVSE/connector while walking the location, and
   * pass a distinct connector object per physical connector — identity is what
   * separates two same-model plugs from one plug recorded twice.
   */
  add(connectors: readonly EvChargingConnector[], tariffs: Iterable<EvChargingTariff>): void;
  /**
   * Content-deduped tariffs, each stamped with the connector groups it was
   * joined to. `allConnectors` is the station's full connector list: a tariff
   * covering all of it is left unstamped, since "everything" and "unknown" are
   * the same thing to consumers and the stamp would only bloat the payload.
   */
  build(allConnectors: readonly EvChargingConnector[]): EvChargingTariff[] | undefined;
}

export function createTariffCollector(): TariffCollector {
  // Connectors are held as a Set of the very objects the parser built, so a
  // connector listing one tariff twice — or two tariff ids resolving to the
  // same content — records it once instead of doubling the stamped quantity.
  const entries = new Map<
    string,
    { tariff: EvChargingTariff; connectors: Set<EvChargingConnector> }
  >();

  return {
    add(connectors, tariffs) {
      for (const tariff of tariffs) {
        const key = tariffKey(tariff);
        const existing = entries.get(key);
        if (existing) for (const conn of connectors) existing.connectors.add(conn);
        else entries.set(key, { tariff, connectors: new Set(connectors) });
      }
    },

    build(allConnectors) {
      if (entries.size === 0) return undefined;
      const stationGroups = new Set(toGroups([...allConnectors]).map(groupKey));
      return Array.from(entries.values(), ({ tariff, connectors }) => {
        const groups = toGroups([...connectors]);
        const coversStation =
          groups.length === stationGroups.size &&
          groups.every((g) => stationGroups.has(groupKey(g)));
        if (groups.length === 0 || coversStation) return tariff;
        return { ...tariff, appliesTo: groups };
      });
    },
  };
}
