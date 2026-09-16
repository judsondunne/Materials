export type ExperimentId = string;
export type FieldId = string;
export type FamilyId = string;

export type FieldRole = 'formulation' | 'process' | 'output';
export type FieldKind = 'continuous' | 'ordinal';

export interface FieldMeta {
  id: FieldId;
  label: string;
  short: string;
  role: FieldRole;
  kind: FieldKind;
  family: FamilyId | null;
  unit: string | null;
  decimals: number;
  domain: [number, number];
  /** Domain across rows where the value is greater than zero. */
  domainPresent: [number, number];
  presentCount: number;
  levels: number[] | null;
  isConstant: boolean;
}

export interface Experiment {
  id: ExperimentId;
  label: string;
  date: Date | null;
  dateKey: string;
  runNumber: number | null;
  index: number;
}

export type Exclusivity = 'exactly-one' | 'at-most-one' | 'multi';

export interface Family {
  id: FamilyId;
  label: string;
  members: FieldId[];
  exclusivity: Exclusivity;
  totalDomain: [number, number];
  colorVar: string;
}

/** A categorical dimension derived from the data, not present in the source file. */
export interface DerivedDimension {
  id: string;
  label: string;
  provenance: string;
  levels: { key: string; label: string; rows: number[] }[];
  /** Row index -> level key */
  assignment: string[];
}

export interface QualityIssue {
  kind: 'coerced' | 'missing' | 'unparseable-id' | 'constant' | 'composition' | 'duplicate';
  detail: string;
  rows: string[];
}

export interface DataQualityReport {
  issues: QualityIssue[];
  checks: { label: string; passed: boolean; detail: string }[];
  clean: boolean;
}

export interface Dataset {
  experiments: Experiment[];
  fields: Map<FieldId, FieldMeta>;
  fieldOrder: FieldId[];
  outputs: FieldId[];
  formulation: FieldId[];
  process: FieldId[];
  columns: Map<FieldId, Float64Array>;
  families: Family[];
  derived: DerivedDimension[];
  quality: DataQualityReport;
  /** True when formulation fields sum to a near-constant total on every row. */
  isMixture: boolean;
  mixtureTotal: number | null;
  rowCount: number;
}

export type RawDataset = Record<
  string,
  { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }
>;
