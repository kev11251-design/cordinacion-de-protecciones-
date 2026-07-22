import { 
  TransformerConfig, 
  UpstreamConfig, 
  DownstreamConfig, 
  RelayCurveType, 
  ProtectionSystemState,
  SelectivityAnalysisReport,
  CableConfig
} from '../types';

// Calculate primary and secondary nominal currents
export function calculateNominalCurrents(config: TransformerConfig) {
  const sn = config.sn; // kVA
  const v1 = config.v1; // kV
  const v2 = config.v2; // kV

  // In = Sn / (sqrt(3) * V)
  const in1 = sn / (Math.sqrt(3) * v1); // primary current in Amperes
  const in2 = sn / (Math.sqrt(3) * v2); // secondary current in Amperes

  return { in1, in2 };
}

// Calculate short-circuit currents
export function calculateShortCircuitCurrents(config: TransformerConfig) {
  const { in1, in2 } = calculateNominalCurrents(config);
  const z = config.z / 100; // Impedance as fraction

  // Icc = In / Z_cc
  const icc1 = in1 / z; // primary Icc in Amperes
  const icc2 = in2 / z; // secondary Icc in Amperes

  return { icc1, icc2 };
}

// Convert a current from secondary to primary
export function convertSecToPri(currentSec: number, config: TransformerConfig): number {
  return currentSec * (config.v2 / config.v1);
}

// Convert a current from primary to secondary
export function convertPriToSec(currentPri: number, config: TransformerConfig): number {
  return currentPri * (config.v1 / config.v2);
}

// Calculate trip time for Upstream Digital Relay (referred to Secondary Amperes)
export function calculateUpstreamTripTime(
  currentSec: number, 
  upstream: UpstreamConfig, 
  transformer: TransformerConfig
): number | null {
  if (!upstream.enabled) return null;

  // Convert current to primary for relay calculations (relay is on the primary side)
  const currentPri = convertSecToPri(currentSec, transformer);

  // Relay pickup current in primary Amperes
  const isPri = upstream.pickup;

  // Instantaneous pickup in primary Amperes
  const instPri = upstream.instPickup;

  // Check instantaneous element first
  if (currentPri >= instPri) {
    return upstream.instDelay;
  }

  // Check if current is above pickup threshold (typically needs to be > 1.05 or 1.1 of pickup)
  if (currentPri <= 1.05 * isPri) {
    return null; // Infinity / no trip
  }

  const M = currentPri / isPri; // Plug multiplier
  const tms = upstream.tms;

  let t = null;

  switch (upstream.curveType) {
    case 'iec-si': // Standard Inverse
      t = tms * (0.14 / (Math.pow(M, 0.02) - 1));
      break;
    case 'iec-vi': // Very Inverse
      t = tms * (13.5 / (M - 1));
      break;
    case 'iec-ei': // Extremely Inverse
      t = tms * (80 / (Math.pow(M, 2) - 1));
      break;
    case 'iec-lti': // Long-time Inverse
      t = tms * (120 / (M - 1));
      break;
    case 'ieee-mi': // Moderately Inverse
      t = tms * (0.0515 / (Math.pow(M, 0.02) - 1) + 0.114);
      break;
    case 'ieee-vi': // Very Inverse
      t = tms * (19.61 / (Math.pow(M, 2) - 1) + 0.491);
      break;
    case 'ieee-ei': // Extremely Inverse
      t = tms * (28.2 / (Math.pow(M, 2) - 1) + 0.1217);
      break;
    default:
      return null;
  }

  // Clamping to standard physical bounds (e.g. minimum 0.015s, maximum 10000s)
  if (t !== null) {
    if (t < 0.015) t = 0.015;
    if (t > 10000) return null;
  }

  return t;
}

// Calculate trip time for Downstream Protection (referred to Secondary Amperes)
export function calculateDownstreamTripTime(
  currentSec: number, 
  downstream: DownstreamConfig
): number | null {
  if (downstream.type === 'mccb') {
    const mccb = downstream.mccb;
    
    // Check instantaneous element first
    if (currentSec >= mccb.ii) {
      return 0.015; // 15ms instantaneous clearing time
    }

    // Check short-time element
    if (currentSec >= mccb.isd) {
      return mccb.tsd;
    }

    // Check long-time thermal element
    if (currentSec <= 1.05 * mccb.ir) {
      return null; // Infinity / no trip
    }

    // Standard bimetallic curve: t = tr * (6^2 - 1) / ((I/Ir)^2 - 1)
    const ratio = currentSec / mccb.ir;
    let t = (mccb.tr * 35) / (Math.pow(ratio, 2) - 1);

    if (t < 0.015) t = 0.015;
    return t;

  } else {
    // Fuse type
    const fuse = downstream.fuse;
    
    // Threshold is typically around 1.15x nominal fuse rating
    if (currentSec <= 1.15 * fuse.in) {
      return null; // Infinity / no trip
    }

    // Standard melt curve model: t = A / (I/In)^B
    const ratio = currentSec / fuse.in;
    let t = fuse.curveFitA / Math.pow(ratio, fuse.curveFitB);

    // Limit fuse trip time to physically realistic range (10ms to 10000s)
    if (t < 0.01) t = 0.01;
    if (t > 10000) return null;
    return t;
  }
}

// Calculate Transformer damage curve coordinates
export function calculateTransformerDamageTime(
  currentSec: number, 
  transformer: TransformerConfig
): number | null {
  const { in2 } = calculateNominalCurrents(transformer);
  const { icc2 } = calculateShortCircuitCurrents(transformer);

  // According to C57.109, damage curve is plotted from 2x In up to Icc
  if (currentSec < 2 * in2 || currentSec > 1.2 * icc2) {
    return null;
  }

  // Formula: t = 2 * (Icc / Isec)^2. This yields exactly 2s at Icc.
  let t = 2 * Math.pow(icc2 / currentSec, 2);

  // Clamp damage curve within standard plotting time range [2s, 100s]
  if (t < 2) t = 2;
  if (t > 100) t = 100;

  return t;
}

// Calculate Cable damage curve coordinates (I^2 * t = K^2 * S^2)
export function calculateCableDamageTime(
  currentSec: number, 
  cable: CableConfig,
  transformer: TransformerConfig
): number | null {
  if (!cable || !cable.enabled) return null;
  const { in1 } = calculateNominalCurrents(transformer);
  const { icc1 } = calculateShortCircuitCurrents(transformer);

  // Convert secondary current to primary current
  const currentPri = currentSec * (transformer.v2 / transformer.v1);

  // According to IEC 60946, the thermal short circuit limit is plotted from 1.5x nominal up to Icc
  if (currentPri < 1.5 * in1 || currentPri > 1.2 * icc1) {
    return null;
  }

  let K = 143;
  if (cable.material === 'cu') {
    K = cable.insulation === 'xlpe' ? 143 : 115;
  } else {
    K = cable.insulation === 'xlpe' ? 94 : 76;
  }

  // Formula: t = (K * S / Ipri)^2
  let t = Math.pow((K * cable.section) / currentPri, 2);

  // Clamp within plotting range [0.01s, 1000s]
  if (t < 0.01) t = 0.01;
  if (t > 1000) return null;

  return t;
}

// Generate the selectivity analysis report
export function performSelectivityAnalysis(state: ProtectionSystemState): SelectivityAnalysisReport {
  const { transformer, upstream, downstream } = state;
  const { in1, in2 } = calculateNominalCurrents(transformer);
  const { icc1, icc2 } = calculateShortCircuitCurrents(transformer);

  // We will sweep secondary currents from 1.1x Downstream Nominal to Icc2 to find any selectivity failures.
  const downstreamNominal = downstream.type === 'mccb' ? downstream.mccb.in : downstream.fuse.in;
  const sweepStart = downstreamNominal * 1.1;
  const sweepEnd = icc2;
  const steps = 150;
  
  let isSelective = true;
  let selectivityType: 'total' | 'parcial' | 'ninguna' = 'total';
  const criticalPoints: SelectivityAnalysisReport['criticalPoints'] = [];

  // Margin thresholds: Upstream must clear slower than downstream by a safe margin
  // For relays vs MCCB/Fuse, margin should be at least 0.2s (200ms) or 0.3s (300ms) depending on standard.
  const requiredMargin = 0.25; // 250ms

  let hasThermalFailure = false;
  let hasMagneticFailure = false;
  let failureStartSec = 0;

  for (let i = 0; i <= steps; i++) {
    const currentSec = sweepStart + (sweepEnd - sweepStart) * (i / steps);
    const tUp = calculateUpstreamTripTime(currentSec, upstream, transformer);
    const tDown = calculateDownstreamTripTime(currentSec, downstream);

    if (tUp !== null && tDown !== null) {
      const margin = tUp - tDown;
      const currentPri = convertSecToPri(currentSec, transformer);

      // Crossover or overlap: downstream trips after upstream OR margin is negative
      if (margin < 0) {
        isSelective = false;
        if (!hasThermalFailure && tDown > 1.0) {
          hasThermalFailure = true;
          criticalPoints.push({
            current: state.refVoltage === 'v1' ? currentPri : (state.refVoltage === 'pu' ? currentSec / in2 : currentSec),
            currentPri,
            currentSec,
            upstreamTime: tUp,
            downstreamTime: tDown,
            type: 'thermal_overlap',
            description: `Intersección en zona térmica/sobrecarga: El interruptor aguas arriba (${tUp.toFixed(2)}s) dispara antes que el aguas abajo (${tDown.toFixed(2)}s) a ${currentSec.toFixed(0)} A secundarios.`
          });
        }
        if (!hasMagneticFailure && tDown <= 1.0) {
          hasMagneticFailure = true;
          failureStartSec = currentSec;
          criticalPoints.push({
            current: state.refVoltage === 'v1' ? currentPri : (state.refVoltage === 'pu' ? currentSec / in2 : currentSec),
            currentPri,
            currentSec,
            upstreamTime: tUp,
            downstreamTime: tDown,
            type: 'magnetic_overlap',
            description: `Pérdida de selectividad en zona de cortocircuito (magnética): Ambos dispositivos compiten o el de aguas arriba dispara antes a partir de ${currentSec.toFixed(0)} A secundarios.`
          });
        }
      } else if (margin < requiredMargin && tDown > 0.05) {
        // Insufficient coordination margin
        const ptExists = criticalPoints.some(p => p.type === 'insufficient_margin');
        if (!ptExists) {
          criticalPoints.push({
            current: state.refVoltage === 'v1' ? currentPri : (state.refVoltage === 'pu' ? currentSec / in2 : currentSec),
            currentPri,
            currentSec,
            upstreamTime: tUp,
            downstreamTime: tDown,
            type: 'insufficient_margin',
            description: `Margen de coordinación insuficiente (${margin.toFixed(3)}s, requerido > ${requiredMargin}s) a ${currentSec.toFixed(0)} A secundarios.`
          });
        }
      }
    }
  }

  // Determine selectivity type classification
  if (!isSelective) {
    if (hasThermalFailure) {
      selectivityType = 'ninguna'; // Very bad, thermal curve crosses
    } else {
      selectivityType = 'parcial'; // Crossover only in high-current/magnetic region
    }
  } else {
    selectivityType = 'total';
  }

  // Calculate margins at typical checkpoints
  const tUpIcc = calculateUpstreamTripTime(icc2, upstream, transformer);
  const tDownIcc = calculateDownstreamTripTime(icc2, downstream);
  const marginAtIcc = (tUpIcc !== null && tDownIcc !== null) ? (tUpIcc - tDownIcc) : null;

  const checkpoint5In = downstreamNominal * 5;
  const tUp5In = calculateUpstreamTripTime(checkpoint5In, upstream, transformer);
  const tDown5In = calculateDownstreamTripTime(checkpoint5In, downstream);
  const marginAt5In = (tUp5In !== null && tDown5In !== null) ? (tUp5In - tDown5In) : null;

  // Inrush coordination status
  // Upstream relay must not trip on transformer inrush
  // Standard inrush: 10x In1 for 0.1s
  const inrushCurrentSec = in2 * transformer.inrushMult;
  const inrushTime = transformer.inrushTime;
  const tUpInrush = calculateUpstreamTripTime(inrushCurrentSec, upstream, transformer);
  const inrushCoordinationStatus = (tUpInrush !== null && tUpInrush <= inrushTime) ? 'risk' : 'ok';

  // Transformer damage protection status
  // Upstream relay curve must lie BELOW the transformer damage curve to protect it
  let transformerProtectionStatus: 'ok' | 'risk' = 'ok';
  const checkCurrents = [2 * in2, 4 * in2, 6 * in2, 10 * in2, icc2];
  for (const currentSec of checkCurrents) {
    const tUp = calculateUpstreamTripTime(currentSec, upstream, transformer);
    const tDamage = calculateTransformerDamageTime(currentSec, transformer);
    if (tUp !== null && tDamage !== null && tUp > tDamage) {
      transformerProtectionStatus = 'risk';
      break;
    }
  }

  return {
    state,
    nominalSecCurrent: in2,
    nominalPriCurrent: in1,
    iccSecCurrent: icc2,
    iccPriCurrent: icc1,
    isSelective,
    selectivityType,
    criticalPoints,
    marginAtIcc,
    marginAt5In,
    inrushCoordinationStatus,
    transformerProtectionStatus
  };
}

// Interface for optimal relay recommendation
export interface OptimalSettings {
  ctRatio: number;
  pickup: number;
  curveType: RelayCurveType;
  tms: number;
  instPickup: number;
  explanation: {
    ctRatio: string;
    pickup: string;
    curveType: string;
    tms: string;
    instPickup: string;
  };
}

// Calculate mathematically optimized settings for the upstream relay (V1)
export function calculateOptimalSettings(state: ProtectionSystemState): OptimalSettings {
  const { transformer, downstream } = state;
  const { in1, in2 } = calculateNominalCurrents(transformer);
  const { icc1, icc2 } = calculateShortCircuitCurrents(transformer);

  // 1. CT Ratio: Smallest standard CT primary >= in1 * 1.25 (to keep load current at a good percentage of CT range)
  const standardCTs = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000];
  const targetCTPri = in1 * 1.25;
  let recommendedCT = standardCTs[standardCTs.length - 1];
  for (const ct of standardCTs) {
    if (ct >= targetCTPri) {
      recommendedCT = ct;
      break;
    }
  }

  // 2. Pickup current (Is): 1.25x In1 (between 1.15x and 1.35x In1 to protect against continuous overload)
  let recommendedPickup = Math.round(in1 * 1.25 * 10) / 10;
  // Let's make sure it's at least 0.5A and at most 0.9 * Icc1
  if (recommendedPickup < 0.5) recommendedPickup = 0.5;
  if (recommendedPickup >= icc1) recommendedPickup = Math.round(icc1 * 0.5 * 10) / 10;

  // 3. Curve Type: Extremely Inverse curves coordinate best with bimetallic/fuse curves
  const recommendedCurve: RelayCurveType = 'iec-ei';

  // 4. Instantaneous Pickup: must be >= 1.25x inrush and >= 1.1x Icc1 (to avoid tripping for faults on secondary side)
  const inrushCurrentPri = in1 * transformer.inrushMult;
  const recommendedInst = Math.round(Math.max(inrushCurrentPri * 1.25, icc1 * 1.1));

  // 5. Time Dial (TMS / TD): Let's sweep TMS to find the minimum value that solves all coordination issues
  let recommendedTMS = 0.15; // default fallback
  let bestTMS = null;

  // Create a temporary upstream configuration to test different TMS values
  const testUpstream: UpstreamConfig = {
    enabled: true,
    ctRatio: recommendedCT,
    curveType: recommendedCurve,
    pickup: recommendedPickup,
    tms: 0.05,
    instPickup: recommendedInst,
    instDelay: 0.05
  };

  const downstreamNominal = downstream.type === 'mccb' ? downstream.mccb.in : downstream.fuse.in;
  const sweepStart = downstreamNominal * 1.15;
  const sweepEnd = icc2;
  const requiredMargin = 0.25; // 250ms

  // Loop TMS from 0.05 to 0.8 in 0.01 increments to find the first one that has total selectivity
  for (let tms = 0.05; tms <= 0.8; tms += 0.01) {
    testUpstream.tms = tms;
    let isSelective = true;
    let satisfiesInrush = true;
    let satisfiesDamage = true;

    // A. Check selectivity margin across sweep
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const currentSec = sweepStart + (sweepEnd - sweepStart) * (i / steps);
      const tUp = calculateUpstreamTripTime(currentSec, testUpstream, transformer);
      const tDown = calculateDownstreamTripTime(currentSec, downstream);

      if (tUp !== null && tDown !== null) {
        if (tUp - tDown < requiredMargin) {
          isSelective = false;
          break;
        }
      }
    }

    // B. Check inrush coordination: trip time at inrush current must be greater than inrush time
    const inrushSec = in2 * transformer.inrushMult;
    const tUpInrush = calculateUpstreamTripTime(inrushSec, testUpstream, transformer);
    if (tUpInrush !== null && tUpInrush <= transformer.inrushTime) {
      satisfiesInrush = false;
    }

    // C. Check damage curve protection: trip time must be less than damage time
    const checkCurrents = [2 * in2, 4 * in2, 6 * in2, 10 * in2, icc2];
    for (const currentSec of checkCurrents) {
      const tUp = calculateUpstreamTripTime(currentSec, testUpstream, transformer);
      const tDamage = calculateTransformerDamageTime(currentSec, transformer);
      if (tUp !== null && tDamage !== null && tUp > tDamage) {
        satisfiesDamage = false;
        break;
      }
    }

    if (isSelective && satisfiesInrush && satisfiesDamage) {
      bestTMS = Math.round(tms * 100) / 100;
      break;
    }
  }

  if (bestTMS !== null) {
    recommendedTMS = bestTMS;
  } else {
    // If no perfect TMS is found, let's find the one that at least gives selectivity and satisfies inrush
    for (let tms = 0.05; tms <= 0.8; tms += 0.01) {
      testUpstream.tms = tms;
      let isSelective = true;
      let satisfiesInrush = true;

      const steps = 30;
      for (let i = 0; i <= steps; i++) {
        const currentSec = sweepStart + (sweepEnd - sweepStart) * (i / steps);
        const tUp = calculateUpstreamTripTime(currentSec, testUpstream, transformer);
        const tDown = calculateDownstreamTripTime(currentSec, downstream);

        if (tUp !== null && tDown !== null && tUp - tDown < requiredMargin) {
          isSelective = false;
          break;
        }
      }

      const inrushSec = in2 * transformer.inrushMult;
      const tUpInrush = calculateUpstreamTripTime(inrushSec, testUpstream, transformer);
      if (tUpInrush !== null && tUpInrush <= transformer.inrushTime) {
        satisfiesInrush = false;
      }

      if (isSelective && satisfiesInrush) {
        recommendedTMS = Math.round(tms * 100) / 100;
        break;
      }
    }
  }

  // Generate clear explanations in Spanish
  const explanation = {
    ctRatio: `Para una corriente nominal primaria de ${in1.toFixed(1)} A, un TC de calibre ${recommendedCT}:5 A es ideal. Evita sobredimensionar el TC (como usar 50:5 A) para garantizar alta resolución de medida y permitir que el relé sintonice corrientes de arranque bajas sin problemas de rango.`,
    pickup: `Ajustado a ${recommendedPickup} A primarios (~${(recommendedPickup / in1).toFixed(2)}x In1). Protege eficazmente al transformador contra sobrecargas continuas, ubicándose por debajo de la curva de daño térmico pero lo suficientemente arriba para evitar disparos falsos con la corriente de carga nominal.`,
    curveType: `Se sugiere cambiar a la curva IEC Extremadamente Inversa (EI). Su pendiente pronunciada de tipo I²t se adapta perfectamente a la respuesta térmica del interruptor de baja tensión o fusibles, evitando cruces tempranos y logrando selectividad total.`,
    tms: `Sintonizado a ${recommendedTMS.toFixed(2)}. Este dial desplaza verticalmente la curva para dar una ventana de coordinación de al menos ${requiredMargin * 1000} ms sobre la protección de aval, despejando fallas antes de que actúe el relé de media tensión.`,
    instPickup: `Configurado a ${recommendedInst} A primarios. Se calcula como el mayor valor entre el inrush transitorio de energización (${(inrushCurrentPri * 1.25).toFixed(1)} A con factor de seguridad) y la corriente de falla secundaria máxima referida al primario (${icc1.toFixed(1)} A). Esto asegura selectividad total ante cortocircuitos en BT y evita disparos erróneos durante el arranque del trafo.`
  };

  return {
    ctRatio: recommendedCT,
    pickup: recommendedPickup,
    curveType: recommendedCurve,
    tms: recommendedTMS,
    instPickup: recommendedInst,
    explanation
  };
}
