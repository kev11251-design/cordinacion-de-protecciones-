export interface TransformerConfig {
  sn: number;          // Power in kVA (e.g. 1000)
  v1: number;          // Primary voltage in kV (e.g. 13.2)
  v2: number;          // Secondary voltage in kV (e.g. 0.4)
  z: number;           // Short-circuit impedance in % (e.g. 6.0)
  inrushMult: number;  // Inrush multiplier (e.g. 10)
  inrushTime: number;  // Inrush time in seconds (e.g. 0.1)
}

export type RelayCurveType = 
  | 'iec-si'   // IEC Standard Inverse
  | 'iec-vi'   // IEC Very Inverse
  | 'iec-ei'   // IEC Extremely Inverse
  | 'iec-lti'  // IEC Long-time Inverse
  | 'ieee-mi'  // IEEE Moderately Inverse
  | 'ieee-vi'  // IEEE Very Inverse
  | 'ieee-ei'; // IEEE Extremely Inverse

export interface UpstreamConfig {
  enabled: boolean;
  ctRatio: number;        // Primary rating of CT in Amperes (e.g. 50)
  curveType: RelayCurveType;
  pickup: number;         // Pickup current setting in primary Amperes (e.g. 50)
  tms: number;            // Time multiplier setting (TMS or TD, e.g. 0.1)
  instPickup: number;     // Instantaneous pickup in primary Amperes (e.g. 400)
  instDelay: number;      // Instantaneous delay in seconds (e.g. 0.05)
}

export interface MccbConfig {
  in: number;             // Sensor rating / Frame rating in Amperes (e.g. 400)
  ir: number;             // Thermal setting in Amperes (e.g. 320)
  tr: number;             // Thermal delay at 6xIr in seconds (e.g. 10)
  isd: number;            // Short-time delay pickup in Amperes (e.g. 1600)
  tsd: number;            // Short-time delay in seconds (e.g. 0.1)
  ii: number;             // Instantaneous pickup in Amperes (e.g. 4000)
}

export interface FuseConfig {
  in: number;             // Nominal current in Amperes (e.g. 160)
  curveFitA: number;      // Curve coefficient A (default 120)
  curveFitB: number;      // Curve exponent B (default 3.2)
}

export type DownstreamType = 'mccb' | 'fuse';

export interface DownstreamConfig {
  type: DownstreamType;
  mccb: MccbConfig;
  fuse: FuseConfig;
}

export interface CableConfig {
  enabled: boolean;
  material: 'cu' | 'al';
  insulation: 'xlpe' | 'pvc';
  section: number; // mm2
}

export interface ProtectionSystemState {
  transformer: TransformerConfig;
  upstream: UpstreamConfig;
  downstream: DownstreamConfig;
  cable: CableConfig;
  refVoltage: 'v1' | 'v2' | 'pu';
}

export interface TripTimeCalculationResult {
  current: number;       // Current in Amperes or p.u.
  refVoltage: 'v1' | 'v2' | 'pu';
  upstreamTime: number | null; // null means no trip or infinity
  downstreamTime: number | null; // null means no trip or infinity
  selectivityMargin: number | null; // upstreamTime - downstreamTime (if downstream trips first)
  selectivityStatus: 'ok' | 'crossover' | 'none';
}

export interface SelectivityAnalysisReport {
  state: ProtectionSystemState;
  nominalSecCurrent: number;   // In2
  nominalPriCurrent: number;   // In1
  iccSecCurrent: number;       // Icc2
  iccPriCurrent: number;       // Icc1
  isSelective: boolean;
  selectivityType: 'total' | 'parcial' | 'ninguna';
  criticalPoints: {
    current: number; // referred to current view
    currentPri: number;
    currentSec: number;
    upstreamTime: number;
    downstreamTime: number;
    type: string; // 'thermal_overlap' | 'magnetic_overlap' | 'insufficient_margin' | etc.
    description: string;
  }[];
  marginAtIcc: number | null;  // margin at Icc
  marginAt5In: number | null;  // margin at 5x In of downstream
  inrushCoordinationStatus: 'ok' | 'risk'; // check if upstream trips on inrush
  transformerProtectionStatus: 'ok' | 'risk'; // check if transformer curve is below upstream protection
  aiEvaluation?: string;       // AI expert summary output
}
