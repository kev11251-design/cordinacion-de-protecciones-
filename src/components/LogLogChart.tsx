import React, { useState, useRef } from 'react';
import { ProtectionSystemState } from '../types';
import {
  calculateNominalCurrents,
  calculateShortCircuitCurrents,
  calculateUpstreamTripTime,
  calculateDownstreamTripTime,
  calculateTransformerDamageTime,
  convertSecToPri,
} from '../utils/calculations';

interface LogLogChartProps {
  state: ProtectionSystemState;
}

export const LogLogChart: React.FC<LogLogChartProps> = ({ state }) => {
  const [hoverCurrent, setHoverCurrent] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { transformer, upstream, downstream, refVoltage } = state;
  const { in1, in2 } = calculateNominalCurrents(transformer);
  const { icc1, icc2 } = calculateShortCircuitCurrents(transformer);

  // Define scale limits based on the reference voltage
  let I_min = 10;
  let I_max = 100000;
  let currentUnit = 'A (Secundario)';
  let baseNominal = in2;
  let baseIcc = icc2;

  if (refVoltage === 'v1') {
    I_min = 0.1;
    I_max = 5000;
    currentUnit = 'A (Primario)';
    baseNominal = in1;
    baseIcc = icc1;
  } else if (refVoltage === 'pu') {
    I_min = 0.1;
    I_max = 100;
    currentUnit = 'p.u. (Base In)';
    baseNominal = 1.0;
    baseIcc = icc2 / in2;
  }

  const t_min = 0.01; // 10ms
  const t_max = 1000; // 1000s

  // SVG parameters
  const width = 640;
  const height = 500;
  const paddingLeft = 70;
  const paddingRight = 30;
  const paddingTop = 30;
  const paddingBottom = 60;

  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  // Coordinate conversion helper functions
  const getX = (I: number) => {
    const logMin = Math.log10(I_min);
    const logMax = Math.log10(I_max);
    const pct = (Math.log10(I) - logMin) / (logMax - logMin);
    return paddingLeft + pct * plotWidth;
  };

  const getY = (t: number) => {
    const logMin = Math.log10(t_min);
    const logMax = Math.log10(t_max);
    const pct = (Math.log10(t) - logMin) / (logMax - logMin);
    return paddingTop + (1 - pct) * plotHeight;
  };

  const getInverseX = (x: number) => {
    const pct = (x - paddingLeft) / plotWidth;
    if (pct < 0 || pct > 1) return null;
    const logMin = Math.log10(I_min);
    const logMax = Math.log10(I_max);
    const logI = logMin + pct * (logMax - logMin);
    return Math.pow(10, logI);
  };

  // Generate decade numbers
  const getCurrentDecades = () => {
    const decades = [];
    let d = Math.pow(10, Math.floor(Math.log10(I_min)));
    while (d <= I_max) {
      if (d >= I_min && d <= I_max) {
        decades.push(d);
      }
      d *= 10;
    }
    return decades;
  };

  const getTimeDecades = () => {
    const decades = [];
    let d = t_min;
    while (d <= t_max) {
      decades.push(d);
      d *= 10;
    }
    return decades;
  };

  const currentDecades = getCurrentDecades();
  const timeDecades = getTimeDecades();

  // Helper to format axis labels
  const formatCurrentLabel = (val: number) => {
    if (val >= 1000) return `${val / 1000}k`;
    if (val < 1) return val.toFixed(1);
    return val.toString();
  };

  const formatTimeLabel = (val: number) => {
    if (val < 1) return val.toFixed(2);
    return val.toString();
  };

  // Generate curves path coordinates
  const generateCurvePath = (calcFn: (currentSec: number) => number | null) => {
    const points: string[] = [];
    const steps = 300;
    const logMin = Math.log10(I_min);
    const logMax = Math.log10(I_max);

    for (let i = 0; i <= steps; i++) {
      const logI = logMin + (logMax - logMin) * (i / steps);
      const I = Math.pow(10, logI);

      // Convert the plotted current to secondary Amperes for calculation
      let currentSec = I;
      if (refVoltage === 'v1') {
        currentSec = I * (transformer.v1 / transformer.v2);
      } else if (refVoltage === 'pu') {
        currentSec = I * in2;
      }

      const t = calcFn(currentSec);
      if (t !== null && t >= t_min && t <= t_max) {
        const x = getX(I);
        const y = getY(t);
        if (!isNaN(x) && !isNaN(y)) {
          points.push(`${points.length === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
        }
      }
    }
    return points.join(' ');
  };

  // 1. Upstream Relay curve path
  const upstreamPath = generateCurvePath((currSec) => 
    calculateUpstreamTripTime(currSec, upstream, transformer)
  );

  // 2. Downstream protection curve path
  const downstreamPath = generateCurvePath((currSec) => 
    calculateDownstreamTripTime(currSec, downstream)
  );

  // 3. Transformer damage curve path
  const damagePath = generateCurvePath((currSec) => 
    calculateTransformerDamageTime(currSec, transformer)
  );

  // 4. Inrush Point
  const inrushCurrent = in2 * transformer.inrushMult;
  let inrushPlottedCurrent = inrushCurrent;
  if (refVoltage === 'v1') {
    inrushPlottedCurrent = convertSecToPri(inrushCurrent, transformer);
  } else if (refVoltage === 'pu') {
    inrushPlottedCurrent = transformer.inrushMult;
  }
  const inrushX = getX(inrushPlottedCurrent);
  const inrushY = getY(transformer.inrushTime);
  const inrushInViewport = 
    inrushPlottedCurrent >= I_min && 
    inrushPlottedCurrent <= I_max && 
    transformer.inrushTime >= t_min && 
    transformer.inrushTime <= t_max;

  // Handle Mouse Events for coordinate tracking
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const currentVal = getInverseX(x);
    if (currentVal !== null) {
      setHoverCurrent(currentVal);
      setHoverPos({ x, y });
    } else {
      setHoverCurrent(null);
      setHoverPos(null);
    }
  };

  const handleMouseLeave = () => {
    setHoverCurrent(null);
    setHoverPos(null);
  };

  // Tooltip details
  let tooltipData = null;
  if (hoverCurrent !== null && hoverPos !== null) {
    let currentSec = hoverCurrent;
    if (refVoltage === 'v1') {
      currentSec = hoverCurrent * (transformer.v1 / transformer.v2);
    } else if (refVoltage === 'pu') {
      currentSec = hoverCurrent * in2;
    }

    const tUp = calculateUpstreamTripTime(currentSec, upstream, transformer);
    const tDown = calculateDownstreamTripTime(currentSec, downstream);
    const tDamage = calculateTransformerDamageTime(currentSec, transformer);

    tooltipData = {
      current: hoverCurrent,
      upstreamTime: tUp,
      downstreamTime: tDown,
      damageTime: tDamage,
    };
  }

  return (
    <div className="relative bg-[#E4E3E0] border border-[#141414] rounded-none p-4 overflow-hidden" id="tcc-chart-container">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 border-b border-[#141414] pb-3">
        <div>
          <h3 className="text-sm font-['Georgia'] italic font-bold text-[#141414] flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-[#141414] rotate-45"></span>
            Curvas de Selectividad de Tiempo-Corriente (TCC)
          </h3>
          <p className="text-[11px] font-mono uppercase tracking-wider text-[#141414]/60 mt-1">Referido a: <span className="font-bold text-[#141414]">{currentUnit}</span></p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono uppercase">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 bg-[#2563eb] inline-block"></span>
            <span className="text-[#141414]">Amontón (Relé V1)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 bg-[#059669] inline-block"></span>
            <span className="text-[#141414]">Aval (Baja Tensión)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-b border-dashed border-[#dc2626] inline-block"></span>
            <span className="text-[#141414]">Daño Trafo</span>
          </div>
        </div>
      </div>

      <div className="relative overflow-x-auto">
        <svg
          id="tcc-svg-chart"
          ref={svgRef}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="mx-auto cursor-crosshair select-none bg-white border border-[#141414]"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* DEFINITIONS FOR DECORATION */}
          <defs>
            <pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="#141414" fillOpacity="0.06" />
            </pattern>
          </defs>

          {/* Background grid */}
          <rect width={width} height={height} fill="url(#dot-grid)" />

          {/* LOGARITHMIC GRID */}
          {/* Vertical Current lines */}
          {currentDecades.map((dec, idx) => {
            const x = getX(dec);
            if (isNaN(x)) return null;

            // Draw major decade lines
            const lines = [
              <line
                key={`v-major-${dec}`}
                x1={x}
                y1={paddingTop}
                x2={x}
                y2={height - paddingBottom}
                stroke="#141414"
                strokeWidth="1"
                strokeOpacity="0.18"
              />,
              <text
                key={`v-lbl-${dec}`}
                x={x}
                y={height - paddingBottom + 16}
                fill="#141414"
                fillOpacity="0.7"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="middle"
              >
                {formatCurrentLabel(dec)}
              </text>
            ];

            // Draw minor sub-decade lines (2, 3, 4, 5, 6, 7, 8, 9)
            if (idx < currentDecades.length - 1) {
              const nextDec = currentDecades[idx + 1];
              const step = dec;
              for (let mult = 2; mult <= 9; mult++) {
                const minorVal = dec + (mult - 1) * step;
                if (minorVal < nextDec) {
                  const xMinor = getX(minorVal);
                  if (!isNaN(xMinor)) {
                    lines.push(
                      <line
                        key={`v-minor-${dec}-${mult}`}
                        x1={xMinor}
                        y1={paddingTop}
                        x2={xMinor}
                        y2={height - paddingBottom}
                        stroke="#141414"
                        strokeWidth="0.5"
                        strokeOpacity="0.06"
                      />
                    );
                  }
                }
              }
            }

            return <g key={`v-grp-${dec}`}>{lines}</g>;
          })}

          {/* Horizontal Time lines */}
          {timeDecades.map((dec, idx) => {
            const y = getY(dec);
            if (isNaN(y)) return null;

            const lines = [
              <line
                key={`h-major-${dec}`}
                x1={paddingLeft}
                y1={y}
                x2={width - paddingRight}
                y2={y}
                stroke="#141414"
                strokeWidth="1"
                strokeOpacity="0.18"
              />,
              <text
                key={`h-lbl-${dec}`}
                x={paddingLeft - 8}
                y={y + 4}
                fill="#141414"
                fillOpacity="0.7"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="end"
              >
                {formatTimeLabel(dec)}
              </text>
            ];

            // Draw minor time sub-decade ticks/lines
            if (idx < timeDecades.length - 1) {
              const step = dec;
              for (let mult = 2; mult <= 9; mult++) {
                const minorVal = dec * mult;
                const yMinor = getY(minorVal);
                if (!isNaN(yMinor)) {
                  lines.push(
                    <line
                      key={`h-minor-${dec}-${mult}`}
                      x1={paddingLeft}
                      y1={yMinor}
                      x2={width - paddingRight}
                      y2={yMinor}
                      stroke="#141414"
                      strokeWidth="0.5"
                      strokeOpacity="0.06"
                    />
                  );
                }
              }
            }

            return <g key={`h-grp-${dec}`}>{lines}</g>;
          })}

          {/* SYSTEM CURRENT MARKERS (In & Icc) */}
          {/* Nominal current marker */}
          {baseNominal >= I_min && baseNominal <= I_max && (
            <g>
              <line
                x1={getX(baseNominal)}
                y1={paddingTop}
                x2={getX(baseNominal)}
                y2={height - paddingBottom}
                stroke="#141414"
                strokeWidth="1.5"
                strokeDasharray="4,4"
                strokeOpacity="0.4"
              />
              <text
                x={getX(baseNominal) + 4}
                y={paddingTop + 15}
                fill="#141414"
                fillOpacity="0.5"
                fontSize="9"
                fontFamily="monospace"
              >
                In = {baseNominal.toFixed(0)} {refVoltage === 'pu' ? 'pu' : 'A'}
              </text>
            </g>
          )}

          {/* Short circuit current marker */}
          {baseIcc >= I_min && baseIcc <= I_max && (
            <g>
              <line
                x1={getX(baseIcc)}
                y1={paddingTop}
                x2={getX(baseIcc)}
                y2={height - paddingBottom}
                stroke="#141414"
                strokeWidth="1.5"
                strokeDasharray="2,2"
                strokeOpacity="0.7"
              />
              <text
                x={getX(baseIcc) - 4}
                y={paddingTop + 30}
                fill="#141414"
                fillOpacity="0.7"
                fontSize="9"
                fontWeight="bold"
                fontFamily="monospace"
                textAnchor="end"
              >
                Icc = {baseIcc.toFixed(0)} {refVoltage === 'pu' ? 'pu' : 'A'}
              </text>
            </g>
          )}

          {/* CURVES PATHS PLOTTING */}
          {/* Downstream Curve (Green) */}
          {downstreamPath && (
            <path
              id="tcc-downstream-curve"
              d={downstreamPath}
              fill="none"
              stroke="#059669"
              strokeWidth="2.5"
            />
          )}

          {/* Upstream Curve (Blue) */}
          {upstreamPath && (
            <path
              id="tcc-upstream-curve"
              d={upstreamPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2.5"
            />
          )}

          {/* Transformer Damage Curve (Red Dashed) */}
          {damagePath && (
            <path
              id="tcc-transformer-damage-curve"
              d={damagePath}
              fill="none"
              stroke="#dc2626"
              strokeWidth="2"
              strokeDasharray="6,4"
            />
          )}

          {/* TRANSFORMER INRUSH POINT */}
          {inrushInViewport && (
            <g id="tcc-inrush-point">
              <circle
                cx={inrushX}
                cy={inrushY}
                r="5"
                fill="#d97706"
                stroke="#141414"
                strokeWidth="1.5"
              />
              <text
                x={inrushX + 10}
                y={inrushY + 4}
                fill="#141414"
                fontSize="10"
                fontFamily="monospace"
                fontWeight="bold"
              >
                Inrush ({transformer.inrushMult}x, {transformer.inrushTime}s)
              </text>
            </g>
          )}

          {/* CHART OUTER BORDERS */}
          <rect
            x={paddingLeft}
            y={paddingTop}
            width={plotWidth}
            height={plotHeight}
            fill="none"
            stroke="#141414"
            strokeWidth="1.5"
          />

          {/* AXIS LABELS */}
          <text
            x={paddingLeft + plotWidth / 2}
            y={height - 10}
            fill="#141414"
            fontSize="11"
            fontWeight="bold"
            fontFamily="monospace"
            textAnchor="middle"
          >
            Corriente [{currentUnit}]
          </text>
          <text
            x={15}
            y={paddingTop + plotHeight / 2}
            fill="#141414"
            fontSize="11"
            fontWeight="bold"
            fontFamily="monospace"
            textAnchor="middle"
            transform={`rotate(-90, 15, ${paddingTop + plotHeight / 2})`}
          >
            Tiempo de Disparo [segundos]
          </text>

          {/* HOVER INTERACTIVE COORDINATES LAYER */}
          {hoverCurrent !== null && hoverPos !== null && tooltipData && (
            <g id="tcc-interactive-hover">
              <line
                x1={hoverPos.x}
                y1={paddingTop}
                x2={hoverPos.x}
                y2={height - paddingBottom}
                stroke="#141414"
                strokeWidth="1"
                strokeDasharray="3,3"
                strokeOpacity="0.5"
              />
              <circle cx={hoverPos.x} cy={hoverPos.y} r="3" fill="#141414" />
              
              {/* Upstream point hover */}
              {tooltipData.upstreamTime !== null && (
                <circle 
                  cx={hoverPos.x} 
                  cy={getY(tooltipData.upstreamTime)} 
                  r="4" 
                  fill="#2563eb" 
                  stroke="#141414" 
                  strokeWidth="1" 
                />
              )}

              {/* Downstream point hover */}
              {tooltipData.downstreamTime !== null && (
                <circle 
                  cx={hoverPos.x} 
                  cy={getY(tooltipData.downstreamTime)} 
                  r="4" 
                  fill="#059669" 
                  stroke="#141414" 
                  strokeWidth="1" 
                />
              )}

              {/* Damage point hover */}
              {tooltipData.damageTime !== null && (
                <circle 
                  cx={hoverPos.x} 
                  cy={getY(tooltipData.damageTime)} 
                  r="4" 
                  fill="#dc2626" 
                  stroke="#141414" 
                  strokeWidth="1" 
                />
              )}
            </g>
          )}
        </svg>
      </div>

      {/* FLOATING HOVER LEGEND */}
      {hoverCurrent !== null && tooltipData && (
        <div 
          className="mt-3 bg-[#f0efec] border border-[#141414] rounded-none p-3 text-2xs md:text-xs grid grid-cols-2 md:grid-cols-4 gap-2 text-[#141414]"
          id="tcc-hover-legend"
        >
          <div>
            <span className="text-[#141414]/60 block uppercase tracking-wider font-mono text-[9px]">Corriente:</span>
            <span className="text-[#141414] font-mono font-bold text-sm">{hoverCurrent.toFixed(1)} {refVoltage === 'pu' ? 'pu' : 'A'}</span>
          </div>
          <div>
            <span className="text-[#2563eb] block uppercase tracking-wider font-mono text-[9px]">t Aguas Arriba:</span>
            <span className="text-[#141414] font-mono font-bold text-sm">
              {tooltipData.upstreamTime !== null ? `${tooltipData.upstreamTime.toFixed(3)} s` : '∞ (No dispara)'}
            </span>
          </div>
          <div>
            <span className="text-[#059669] block uppercase tracking-wider font-mono text-[9px]">t Aguas Abajo:</span>
            <span className="text-[#141414] font-mono font-bold text-sm">
              {tooltipData.downstreamTime !== null ? `${tooltipData.downstreamTime.toFixed(3)} s` : '∞ (No dispara)'}
            </span>
          </div>
          <div>
            <span className="text-[#dc2626] block uppercase tracking-wider font-mono text-[9px]">t Daño Trafo:</span>
            <span className="text-[#141414] font-mono font-bold text-sm">
              {tooltipData.damageTime !== null ? `${tooltipData.damageTime.toFixed(1)} s` : 'Seguro'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
