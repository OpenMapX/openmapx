/** OpenChargeMap API v3 response types */

export interface OcmAddressInfo {
  ID: number;
  Title: string;
  AddressLine1?: string;
  AddressLine2?: string;
  Town?: string;
  StateOrProvince?: string;
  Postcode?: string;
  CountryID?: number;
  Country?: { ID: number; ISOCode: string; ContinentCode: string; Title: string };
  Latitude: number;
  Longitude: number;
  ContactTelephone1?: string;
  ContactTelephone2?: string;
  ContactEmail?: string;
  AccessComments?: string;
  RelatedURL?: string;
  Distance?: number;
  DistanceUnit?: number;
}

export interface OcmConnectionType {
  ID: number;
  Title: string;
  FormalName?: string;
  IsDiscontinued?: boolean;
  IsObsolete?: boolean;
}

export interface OcmStatusType {
  ID: number;
  Title: string;
  IsOperational?: boolean;
  IsUserSelectable?: boolean;
}

export interface OcmLevelType {
  ID: number;
  Title: string;
  Comments?: string;
  IsFastChargeCapable?: boolean;
}

export interface OcmSupplyType {
  ID: number;
  Title: string;
}

export interface OcmConnectionInfo {
  ID: number;
  ConnectionTypeID?: number;
  ConnectionType?: OcmConnectionType;
  StatusTypeID?: number;
  StatusType?: OcmStatusType;
  LevelID?: number;
  Level?: OcmLevelType;
  CurrentTypeID?: number;
  CurrentType?: OcmSupplyType;
  Amps?: number;
  Voltage?: number;
  PowerKW?: number;
  Quantity?: number;
  Reference?: string;
  Comments?: string;
}

export interface OcmOperatorInfo {
  ID: number;
  Title: string;
  WebsiteURL?: string;
  Comments?: string;
  PhonePrimaryContact?: string;
  PhoneSecondaryContact?: string;
  IsPrivateIndividual?: boolean;
  ContactEmail?: string;
  FaultReportEmail?: string;
  IsRestrictedEdit?: boolean;
}

export interface OcmUsageType {
  ID: number;
  Title: string;
  IsPayAtLocation?: boolean;
  IsMembershipRequired?: boolean;
  IsAccessKeyRequired?: boolean;
}

export interface OcmDataProvider {
  ID: number;
  Title: string;
  WebsiteURL?: string;
  DataProviderStatusType?: { ID: number; Title: string; IsProviderEnabled?: boolean };
  IsRestrictedEdit?: boolean;
  IsOpenDataLicensed?: boolean;
  IsApprovedImport?: boolean;
  License?: string;
}

export interface OcmPoi {
  ID: number;
  UUID?: string;
  DataProviderID?: number;
  DataProvider?: OcmDataProvider;
  OperatorID?: number;
  OperatorInfo?: OcmOperatorInfo;
  UsageTypeID?: number;
  UsageType?: OcmUsageType;
  UsageCost?: string;
  AddressInfo: OcmAddressInfo;
  Connections?: OcmConnectionInfo[];
  NumberOfPoints?: number;
  StatusTypeID?: number;
  StatusType?: OcmStatusType;
  DateLastStatusUpdate?: string;
  DateLastVerified?: string;
  DateCreated?: string;
  DateLastConfirmed?: string;
  IsRecentlyVerified?: boolean;
  DatePlanned?: string;
}

export interface OcmReferenceData {
  ConnectionTypes: OcmConnectionType[];
  StatusTypes: OcmStatusType[];
  UsageTypes: OcmUsageType[];
  Operators: OcmOperatorInfo[];
  DataProviders: OcmDataProvider[];
  ChargerTypes: OcmLevelType[];
  CurrentTypes: OcmSupplyType[];
}
