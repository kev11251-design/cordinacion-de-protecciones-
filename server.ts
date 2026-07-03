import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { 
  ProtectionSystemState, 
  TripTimeCalculationResult 
} from "./src/types";
import { 
  calculateUpstreamTripTime, 
  calculateDownstreamTripTime, 
  calculateTransformerDamageTime,
  performSelectivityAnalysis,
  calculateNominalCurrents,
  calculateShortCircuitCurrents,
  convertSecToPri,
  convertPriToSec
} from "./src/utils/calculations";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Enable JSON parsing
app.use(express.json());

// Initialize Gemini Client safely
let ai: GoogleGenAI | null = null;
try {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  } else {
    console.warn("GEMINI_API_KEY no configurado en variables de entorno.");
  }
} catch (error) {
  console.error("Error inicializando GoogleGenAI:", error);
}

// API Routes

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Calculate trip time for a specific current
app.post("/api/calculate-trip-time", (req, res) => {
  try {
    const { state, current } = req.body as { state: ProtectionSystemState; current: number };
    
    if (!state || current === undefined) {
      res.status(400).json({ error: "Faltan parámetros 'state' o 'current'" });
      return;
    }

    const { transformer, refVoltage } = state;
    const { in2 } = calculateNominalCurrents(transformer);

    // Convert input current to secondary Amperes for calculation
    let currentSec = current;
    if (refVoltage === 'v1') {
      currentSec = convertPriToSec(current, transformer);
    } else if (refVoltage === 'pu') {
      currentSec = current * in2;
    }

    const tUp = calculateUpstreamTripTime(currentSec, state.upstream, transformer);
    const tDown = calculateDownstreamTripTime(currentSec, state.downstream);
    const tDamage = calculateTransformerDamageTime(currentSec, transformer);

    res.json({
      current,
      currentSec,
      refVoltage,
      upstreamTime: tUp,
      downstreamTime: tDown,
      transformerDamageTime: tDamage,
      margin: (tUp !== null && tDown !== null) ? tUp - tDown : null
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Error interno calculando tiempos de disparo" });
  }
});

// Analyze selectivity and generate expert AI report
app.post("/api/analyze-selectivity", async (req, res) => {
  try {
    const { state } = req.body as { state: ProtectionSystemState };
    if (!state) {
      res.status(400).json({ error: "Falta parámetro 'state'" });
      return;
    }

    // Perform accurate mathematical sweep and analysis
    const mathAnalysis = performSelectivityAnalysis(state);

    // If Gemini is not configured, return analysis with placeholder warning
    if (!ai) {
      res.json({
        ...mathAnalysis,
        aiEvaluation: `### [ADVERTENCIA: GEMINI_API_KEY no configurado]
Por favor, configure su clave API de Gemini en la pestaña de Ajustes (Secrets) de AI Studio.

A continuación se muestra el diagnóstico matemático automático:
- **Selectividad:** ${mathAnalysis.isSelective ? 'TOTAL' : 'PARCIAL/INEXISTENTE'} (${mathAnalysis.selectivityType.toUpperCase()})
- **Soporta Inrush del Trafo:** ${mathAnalysis.inrushCoordinationStatus === 'ok' ? 'SÍ (Correcto)' : 'RIESGO DE DISPARO INTEMPESTIVO'}
- **Protección Térmica del Trafo:** ${mathAnalysis.transformerProtectionStatus === 'ok' ? 'SÍ (Correcto)' : 'RIESGO DE DAÑO AL TRANSFORMADOR (La protección aguas arriba no cubre la curva de daño)'}
- **Puntos críticos:** ${mathAnalysis.criticalPoints.length === 0 ? 'Ninguno' : mathAnalysis.criticalPoints.map(p => `\n  - ${p.description}`).join('')}`
      });
      return;
    }

    // Generate prompt with exact mathematical results to ensure NO hallucination of coordinates or values
    const prompt = `Analiza la selectividad y coordinación de protecciones de un sistema de potencia con los siguientes datos calculados matemáticamente.

DATOS DEL SISTEMA Y TRANSFORMADOR:
- Transformador: ${state.transformer.sn} kVA, relación de tensiones ${state.transformer.v1} kV / ${state.transformer.v2} kV, Zcc = ${state.transformer.z}%
- Corriente nominal primaria (In1): ${mathAnalysis.nominalPriCurrent.toFixed(1)} A
- Corriente nominal secundaria (In2): ${mathAnalysis.nominalSecCurrent.toFixed(1)} A
- Corriente de cortocircuito primaria (Icc1): ${mathAnalysis.iccPriCurrent.toFixed(0)} A
- Corriente de cortocircuito secundaria (Icc2): ${mathAnalysis.iccSecCurrent.toFixed(0)} A

CONFIGURACIÓN DE PROTECCIONES:
1. Aguas arriba (Lado Primario, CT Ratio: ${state.upstream.ctRatio}A):
   - Relé Digital, Curva tipo: ${state.upstream.curveType}
   - Ajuste de arranque térmico (Pickup): ${state.upstream.pickup} A primarios
   - Dial de tiempo (TMS): ${state.upstream.tms}
   - Pickup Instantáneo: ${state.upstream.instPickup} A primarios, Delay: ${state.upstream.instDelay}s
2. Aguas abajo (Lado Secundario):
   - Tipo de protección: ${state.downstream.type.toUpperCase()}
   ${state.downstream.type === 'mccb' ? `
   - MCCB: In = ${state.downstream.mccb.in} A, ajuste térmico Ir = ${state.downstream.mccb.ir} A, tiempo tr = ${state.downstream.mccb.tr}s a 6xIr
   - Ajuste de corto tiempo Isd = ${state.downstream.mccb.isd} A, tiempo tsd = ${state.downstream.mccb.tsd}s
   - Instantáneo Ii = ${state.downstream.mccb.ii} A
   ` : `
   - Fusible gG: In = ${state.downstream.fuse.in} A, (Curva de fusión ajustada: A=${state.downstream.fuse.curveFitA}, B=${state.downstream.fuse.curveFitB})
   `}

RESULTADO DEL ANÁLISIS MATEMÁTICO DE SELECTIVIDAD:
- ¿Es totalmente selectivo?: ${mathAnalysis.isSelective ? 'SÍ' : 'NO'}
- Tipo de selectividad clasificada: ${mathAnalysis.selectivityType.toUpperCase()}
- Coordinación con el Inrush del transformador (Inrush: ${state.transformer.inrushMult}xIn para ${state.transformer.inrushTime}s): ${mathAnalysis.inrushCoordinationStatus === 'ok' ? 'CORRECTO (No se dispara intempestivamente)' : 'RIESGO (El relé de aguas arriba se dispararía durante la inserción del trafo)'}
- Protección del transformador contra daño térmico/mecánico (ANSI C57.109): ${mathAnalysis.transformerProtectionStatus === 'ok' ? 'CORRECTO (La curva de la protección aguas arriba está por debajo de la curva de daño)' : 'RIESGO (La protección aguas arriba no despeja fallas antes de que el transformador sufra daño térmico/mecánico)'}

PUNTOS CRÍTICOS / CONFLICTOS DETECTADOS EN EL BARRIDO DE CORRIENTE:
${mathAnalysis.criticalPoints.length === 0 ? 'Ningún cruce o superposición detectado en el rango de corrientes.' : mathAnalysis.criticalPoints.map((p, idx) => `${idx + 1}. [${p.type.toUpperCase()}] ${p.description}`).join('\n')}

MÁRGENES DE TIEMPO CALCULADOS:
- Margen de coordinación en corriente de cortocircuito máxima Icc: ${mathAnalysis.marginAtIcc !== null ? `${mathAnalysis.marginAtIcc.toFixed(3)}s` : 'Sin superposición o no hay disparo concurrente'}
- Margen de coordinación a 5 veces In de aguas abajo: ${mathAnalysis.marginAt5In !== null ? `${mathAnalysis.marginAt5In.toFixed(3)}s` : 'N/A'}

INSTRUCCIÓN DE FORMATO:
Como Ingeniero Electricista experto en Sistemas de Potencia, escribe un informe técnico formal pero didáctico y claro en español.
Sigue estrictamente esta estructura con estos encabezados EXACTOS en Markdown:

1. **Estado Actual:**
   (Un resumen descriptivo y bien formateado de los parámetros técnicos, corrientes In e Icc, y el estado general del sistema).

2. **Diagnóstico de Selectividad:**
   (Un análisis detallado explicando de manera fundamentada si existe selectividad total, parcial o inexistente basándote en los márgenes de tiempo y puntos críticos calculados. Analiza también si el transformador está correctamente protegido por el relé de aguas arriba y si el arranque resiste la corriente de inserción/inrush sin disparos en falso. Sé riguroso y cita los valores de corriente y tiempos exactos calculados).

3. **Recomendación de Ajuste:**
   (Proporciona sugerencias de ingeniería muy específicas y accionables para corregir los problemas encontrados o mejorar la robustez de la coordinación. Sugiere cambios concretos en los diales de tiempo TMS, corrientes de pickup Ir o Is, tiempos tsd, o calibres de fusible, justificando el impacto técnico de cada cambio).`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        temperature: 0.2, // Low temperature for high precision and technical accuracy
      }
    });

    res.json({
      ...mathAnalysis,
      aiEvaluation: response.text
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message || "Error interno en el análisis de selectividad" });
  }
});

// Vite middleware for development / static server for production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  }
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
