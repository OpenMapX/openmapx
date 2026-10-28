/** Compatibility surface for fixed descriptors and the sole guarded family index. */
export * from "./configuration-fence-settlement-descriptors";
export {
  assertNoUnissuedConfigurationReceiverPublication,
  configurationSettlementDescriptorDigest,
  readConfigurationSettlementCell,
  writeConfigurationSettlementCell,
} from "./retention-family";
