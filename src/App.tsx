import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { 
  ProtectionSystemState, 
  TransformerConfig, 
  UpstreamConfig, 
  DownstreamConfig, 
  SelectivityAnalysisReport 
} from './types';
import { LogLogChart } from './components/LogLogChart';
import { 
  calculateNominalCurrents, 
  calculateShortCircuitCurrents,
  performSelectivityAnalysis,
  calculateOptimalSettings
} from './utils/calculations';
import { 
  Zap, 
  Activity, 
  FileText, 
  Sliders, 
  AlertTriangle, 
  CheckCircle, 
  RefreshCw, 
  Calculator, 
  Download, 
  Info,
  Layers,
  Sparkles,
  Database,
  Plus,
  Trash2,
  Check,
  Copy
} from 'lucide-react';
import { supabase } from './lib/supabaseClient';

// Standard 1000 kVA uncoordinated preset (Preset 1 - Conflict)
const uncoordinatedPreset: ProtectionSystemState = {
  transformer: {
    sn: 1000,
    v1: 13.2,
    v2: 0.4,
    z: 6.0,
    inrushMult: 10,
    inrushTime: 0.1
  },
  upstream: {
    enabled: true,
    ctRatio: 50,
    curveType: 'iec-si',
    pickup: 30, // 30A primary pickup (too sensitive!)
    tms: 0.05,  // TMS too fast
    instPickup: 250, // Instantaneous trips too early
    instDelay: 0.05
  },
  downstream: {
    type: 'mccb',
    mccb: {
      in: 1600,
      ir: 1400, // Thermal setting too close to trafo capacity
      tr: 12,
      isd: 8000, // Short time pickup too high (competes with upstream instant)
      tsd: 0.2,
      ii: 15000
    },
    fuse: {
      in: 250,
      curveFitA: 120,
      curveFitB: 3.2
    }
  },
  refVoltage: 'v2' // referred to secondary
};

// Standard 1000 kVA coordinated preset (Preset 2 - Coordinated)
const coordinatedPreset: ProtectionSystemState = {
  transformer: {
    sn: 1000,
    v1: 13.2,
    v2: 0.4,
    z: 6.0,
    inrushMult: 10,
    inrushTime: 0.1
  },
  upstream: {
    enabled: true,
    ctRatio: 50,
    curveType: 'iec-vi', // Very Inverse curves provide better coordination with MCCB thermal lines
    pickup: 55, // Pickup set above transformer continuous load (In1 ~ 43.7A)
    tms: 0.15, // Raised time dial to clear downstream faults first
    instPickup: 450, // Moved instantaneous above secondary short-circuits referred to primary
    instDelay: 0.1
  },
  downstream: {
    type: 'mccb',
    mccb: {
      in: 1000,
      ir: 800, // Coordinated load size
      tr: 10,
      isd: 4000, // Lower short time pickup to clear faults fast
      tsd: 0.1, // Faster clearing than upstream
      ii: 10000
    },
    fuse: {
      in: 250,
      curveFitA: 120,
      curveFitB: 3.2
    }
  },
  refVoltage: 'v2'
};

export default function App() {
  const [state, setState] = useState<ProtectionSystemState>(uncoordinatedPreset);
  const [report, setReport] = useState<SelectivityAnalysisReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  
  // Single point calculator states
  const [calcCurrent, setCalcCurrent] = useState<string>('2000');
  const [calcResult, setCalcResult] = useState<any>(null);
  const [calcLoading, setCalcLoading] = useState<boolean>(false);

  // Active form sections
  const [activeTab, setActiveTab] = useState<'trafo' | 'upstream' | 'downstream' | 'saved'>('trafo');

  // Supabase state variables
  const [savedConfigs, setSavedConfigs] = useState<any[]>([]);
  const [configName, setConfigName] = useState<string>('');
  const [configDesc, setConfigDesc] = useState<string>('');
  const [dbStatus, setDbStatus] = useState<'loading' | 'ok' | 'no_table' | 'error'>('loading');
  const [dbErrorMessage, setDbErrorMessage] = useState<string>('');
  const [dbActionLoading, setDbActionLoading] = useState<boolean>(false);
  const [copiedSql, setCopiedSql] = useState<boolean>(false);

  const sqlSetupCode = `CREATE TABLE public.coordinaciones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    name text NOT NULL,
    description text,
    state jsonb NOT NULL
);

ALTER TABLE public.coordinaciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Permitir lectura publica" ON public.coordinaciones FOR SELECT USING (true);
CREATE POLICY "Permitir insercion publica" ON public.coordinaciones FOR INSERT WITH CHECK (true);
CREATE POLICY "Permitir modificacion publica" ON public.coordinaciones FOR UPDATE USING (true);
CREATE POLICY "Permitir eliminacion publica" ON public.coordinaciones FOR DELETE USING (true);`;

  const copySqlToClipboard = () => {
    navigator.clipboard.writeText(sqlSetupCode);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  const loadSavedConfigs = async () => {
    setDbStatus('loading');
    try {
      const { data, error } = await supabase
        .from('coordinaciones')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error("Error loading configs:", error);
        if (error.code === 'PGRST205' || error.message?.includes('does not exist')) {
          setDbStatus('no_table');
        } else {
          setDbStatus('error');
          setDbErrorMessage(error.message);
        }
      } else {
        setSavedConfigs(data || []);
        setDbStatus('ok');
      }
    } catch (err: any) {
      console.error("Exception loading configs:", err);
      setDbStatus('error');
      setDbErrorMessage(err.message || 'Error de conexión');
    }
  };

  const saveCurrentConfig = async () => {
    if (!configName.trim()) {
      alert("Por favor ingrese un nombre para la configuración.");
      return;
    }
    setDbActionLoading(true);
    try {
      const { error } = await supabase
        .from('coordinaciones')
        .insert([
          {
            name: configName,
            description: configDesc,
            state: state
          }
        ]);

      if (error) {
        alert("Error al guardar: " + error.message);
      } else {
        setConfigName('');
        setConfigDesc('');
        alert("¡Configuración guardada exitosamente en Supabase!");
        await loadSavedConfigs();
      }
    } catch (err: any) {
      alert("Error al guardar: " + err.message);
    } finally {
      setDbActionLoading(false);
    }
  };

  const deleteConfig = async (id: string) => {
    if (!confirm("¿Está seguro de que desea eliminar esta configuración?")) {
      return;
    }
    setDbActionLoading(true);
    try {
      const { error } = await supabase
        .from('coordinaciones')
        .delete()
        .eq('id', id);

      if (error) {
        alert("Error al eliminar: " + error.message);
      } else {
        await loadSavedConfigs();
      }
    } catch (err: any) {
      alert("Error al eliminar: " + err.message);
    } finally {
      setDbActionLoading(false);
    }
  };

  const loadConfigIntoState = (savedState: any) => {
    try {
      if (savedState && savedState.transformer && savedState.upstream && savedState.downstream) {
        setState(savedState);
        alert("¡Configuración cargada exitosamente!");
      } else {
        alert("Error: El formato de los datos guardados no es válido.");
      }
    } catch (e) {
      alert("Error cargando configuración.");
    }
  };

  // Load configs on mount and when activeTab is 'saved'
  useEffect(() => {
    loadSavedConfigs();
  }, []);

  useEffect(() => {
    if (activeTab === 'saved') {
      loadSavedConfigs();
    }
  }, [activeTab]);

  // Recalculate local stats as state changes
  const { in1, in2 } = calculateNominalCurrents(state.transformer);
  const { icc1, icc2 } = calculateShortCircuitCurrents(state.transformer);

  // Update report mathematically without AI description first
  useEffect(() => {
    const mathReport = performSelectivityAnalysis(state);
    setReport(prev => prev ? { ...mathReport, aiEvaluation: prev.aiEvaluation } : mathReport as any);
  }, [state]);

  // Handle preset selection
  const loadPreset = (preset: ProtectionSystemState) => {
    setState(preset);
    setCalcResult(null);
  };

  // Submit full system to backend for AI Expert analysis and report
  const generateAiReport = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analyze-selectivity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state })
      });
      const data = await res.json();
      if (res.ok) {
        setReport(data);
      } else {
        alert("Error generando el informe: " + data.error);
      }
    } catch (err: any) {
      alert("Error de conexión: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Single point trip time query
  const runSinglePointCalculation = async () => {
    setCalcLoading(true);
    try {
      const currentNum = parseFloat(calcCurrent);
      if (isNaN(currentNum) || currentNum <= 0) {
        alert("Por favor ingrese un valor de corriente válido.");
        setCalcLoading(false);
        return;
      }
      const res = await fetch('/api/calculate-trip-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, current: currentNum })
      });
      const data = await res.json();
      if (res.ok) {
        setCalcResult(data);
      } else {
        alert("Error en el cálculo: " + data.error);
      }
    } catch (err: any) {
      alert("Error de conexión: " + err.message);
    } finally {
      setCalcLoading(false);
    }
  };

  // Form field handlers
  const handleTrafoChange = (field: keyof TransformerConfig, value: number) => {
    setState(prev => ({
      ...prev,
      transformer: {
        ...prev.transformer,
        [field]: value
      }
    }));
  };

  const handleUpstreamChange = (field: keyof UpstreamConfig, value: any) => {
    setState(prev => ({
      ...prev,
      upstream: {
        ...prev.upstream,
        [field]: value
      }
    }));
  };

  const handleDownstreamMccbChange = (field: keyof typeof state.downstream.mccb, value: number) => {
    setState(prev => ({
      ...prev,
      downstream: {
        ...prev.downstream,
        mccb: {
          ...prev.downstream.mccb,
          [field]: value
        }
      }
    }));
  };

  const handleDownstreamFuseChange = (field: keyof typeof state.downstream.fuse, value: number) => {
    setState(prev => ({
      ...prev,
      downstream: {
        ...prev.downstream,
        fuse: {
          ...prev.downstream.fuse,
          [field]: value
        }
      }
    }));
  };

  const applyOptimalSettings = () => {
    const optimal = calculateOptimalSettings(state);
    setState(prev => ({
      ...prev,
      upstream: {
        ...prev.upstream,
        ctRatio: optimal.ctRatio,
        pickup: optimal.pickup,
        curveType: optimal.curveType,
        tms: optimal.tms,
        instPickup: optimal.instPickup
      }
    }));
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414]/15 selection:text-[#141414]">
      
      {/* HEADER SECTION */}
      <header className="border-b border-[#141414] bg-[#E4E3E0] sticky top-0 z-50 px-4 py-4 md:px-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white rounded-none border border-[#141414] shadow-[1.5px_1.5px_0px_0px_#141414]">
            <Zap className="w-5 h-5 text-[#141414]" />
          </div>
          <div>
            <h1 className="text-base md:text-lg font-['Georgia'] italic font-bold tracking-tight text-[#141414] flex items-center gap-2">
              Selectividad y Coordinación de Protecciones
              <span className="text-3xs bg-[#141414] text-[#E4E3E0] px-1.5 py-0.5 rounded-none font-mono uppercase tracking-widest">IEC / IEEE</span>
            </h1>
            <p className="text-[10px] md:text-xs text-[#141414]/60 font-mono uppercase tracking-wider">Análisis Experto de Selectividad Térmica-Magnética de Sistemas de Potencia</p>
          </div>
        </div>

        {/* PRESET TRIGGER BUTTONS */}
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-[#141414]/60 font-mono uppercase tracking-widest mr-1">Casos de Estudio:</span>
          <button
            id="preset-conflict-btn"
            onClick={() => loadPreset(uncoordinatedPreset)}
            className={`px-3 py-1.5 rounded-none text-xs font-mono font-bold uppercase tracking-wider transition-all duration-200 border flex items-center gap-1.5 ${
              state.upstream.pickup === 30 
                ? 'bg-[#141414] text-[#E4E3E0] border-[#141414] shadow-[2px_2px_0px_0px_rgba(20,20,20,0.2)]' 
                : 'bg-white text-[#141414] border-[#141414] hover:bg-[#dcdbd7]'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-[#e11d48]" />
            Caso 1: Con Conflicto
          </button>
          <button
            id="preset-coordinated-btn"
            onClick={() => loadPreset(coordinatedPreset)}
            className={`px-3 py-1.5 rounded-none text-xs font-mono font-bold uppercase tracking-wider transition-all duration-200 border flex items-center gap-1.5 ${
              state.upstream.pickup === 55 
                ? 'bg-[#141414] text-[#E4E3E0] border-[#141414] shadow-[2px_2px_0px_0px_rgba(20,20,20,0.2)]' 
                : 'bg-white text-[#141414] border-[#141414] hover:bg-[#dcdbd7]'
            }`}
          >
            <CheckCircle className="w-3.5 h-3.5 text-[#059669]" />
            Caso 2: Coordinado
          </button>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">
        
        {/* LEFT COLUMN: PARAMETERS CONFIGURATION (5 COLS) */}
        <section className="lg:col-span-5 bg-[#f0efec] border border-[#141414] rounded-none p-5 md:p-6 flex flex-col gap-6 shadow-[4px_4px_0px_0px_#141414]" id="parameters-panel">
          <div>
            <h2 className="text-sm font-['Georgia'] italic font-bold text-[#141414] flex items-center gap-2 mb-1">
              <Sliders className="w-4.5 h-4.5 text-[#141414]" />
              Parámetros de Entrada
            </h2>
            <p className="text-2xs font-mono uppercase tracking-wider text-[#141414]/60">Modifique los diales y calibres para sintonizar el sistema eléctrico.</p>
          </div>

          {/* INNER TABS FOR FORM */}
          <div className="flex border-b border-[#141414] flex-wrap">
            <button
              id="tab-trafo-btn"
              onClick={() => setActiveTab('trafo')}
              className={`flex-1 min-w-[80px] py-2 text-3xs sm:text-2xs font-mono uppercase tracking-wider font-bold border-b-2 transition-colors ${
                activeTab === 'trafo' 
                  ? 'border-[#141414] text-[#141414]' 
                  : 'border-transparent text-[#141414]/50 hover:text-[#141414]'
              }`}
            >
              1. Trafo
            </button>
            <button
              id="tab-upstream-btn"
              onClick={() => setActiveTab('upstream')}
              className={`flex-1 min-w-[80px] py-2 text-3xs sm:text-2xs font-mono uppercase tracking-wider font-bold border-b-2 transition-colors ${
                activeTab === 'upstream' 
                  ? 'border-[#141414] text-[#141414]' 
                  : 'border-transparent text-[#141414]/50 hover:text-[#141414]'
              }`}
            >
              2. Amontón
            </button>
            <button
              id="tab-downstream-btn"
              onClick={() => setActiveTab('downstream')}
              className={`flex-1 min-w-[80px] py-2 text-3xs sm:text-2xs font-mono uppercase tracking-wider font-bold border-b-2 transition-colors ${
                activeTab === 'downstream' 
                  ? 'border-[#141414] text-[#141414]' 
                  : 'border-transparent text-[#141414]/50 hover:text-[#141414]'
              }`}
            >
              3. Aval
            </button>
            <button
              id="tab-saved-btn"
              onClick={() => setActiveTab('saved')}
              className={`flex-1 min-w-[80px] py-2 text-3xs sm:text-2xs font-mono uppercase tracking-wider font-bold border-b-2 transition-colors ${
                activeTab === 'saved' 
                  ? 'border-[#141414] text-[#141414]' 
                  : 'border-transparent text-[#141414]/50 hover:text-[#141414]'
              }`}
            >
              4. Guardados
            </button>
          </div>

          {/* TAB 1: TRANSFORMER */}
          {activeTab === 'trafo' && (
            <div className="space-y-4 animate-fade-in" id="form-transformer">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Potencia Sn (kVA)</label>
                  <input
                    type="number"
                    value={state.transformer.sn}
                    onChange={(e) => handleTrafoChange('sn', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Zcc (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={state.transformer.z}
                    onChange={(e) => handleTrafoChange('z', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Voltaje V1 (Primary kV)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={state.transformer.v1}
                    onChange={(e) => handleTrafoChange('v1', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Voltaje V2 (Secondary kV)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={state.transformer.v2}
                    onChange={(e) => handleTrafoChange('v2', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-[#141414] pt-3">
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Inrush Múltiplo</label>
                  <input
                    type="number"
                    value={state.transformer.inrushMult}
                    onChange={(e) => handleTrafoChange('inrushMult', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Inrush Tiempo (s)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={state.transformer.inrushTime}
                    onChange={(e) => handleTrafoChange('inrushTime', parseFloat(e.target.value) || 0)}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
              </div>

              {/* INSTANT CALCULATED VALUES IN SIDEBAR */}
              <div className="mt-4 bg-[#dcdbd7] border border-[#141414] rounded-none p-3.5 space-y-2">
                <span className="text-[9px] uppercase tracking-widest font-bold text-[#141414] font-mono block mb-1">Cálculos en Tiempo Real (Trafo):</span>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div>
                    <span className="text-[#141414]/60 block text-[10px]">In Primaria (In1):</span>
                    <span className="text-[#141414] font-bold block">{in1.toFixed(1)} A</span>
                  </div>
                  <div>
                    <span className="text-[#141414]/60 block text-[10px]">In Secundaria (In2):</span>
                    <span className="text-[#141414] font-bold block">{in2.toFixed(1)} A</span>
                  </div>
                  <div className="border-t border-[#141414] pt-2 col-span-2 grid grid-cols-2">
                    <div>
                      <span className="text-[#141414]/60 block text-[10px]">Icc Primaria (Icc1):</span>
                      <span className="text-red-700 font-bold block">{icc1.toFixed(0)} A</span>
                    </div>
                    <div>
                      <span className="text-[#141414]/60 block text-[10px]">Icc Secundaria (Icc2):</span>
                      <span className="text-red-700 font-bold block">{icc2.toFixed(0)} A</span>
                    </div>
                  </div>
                  <div className="border-t border-[#141414] pt-2 col-span-2 text-[9px] text-[#141414]/75 font-mono">
                    Fórmula Trifásica: In = Sn / (√3 × V)
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: UPSTREAM PROTECTION (RELAY) */}
          {activeTab === 'upstream' && (
            <div className="space-y-4 animate-fade-in" id="form-upstream">
              <div className="flex items-center justify-between border-b border-[#141414] pb-2">
                <span className="text-xs text-[#141414] font-mono font-bold uppercase tracking-wider">Relé de Sobrecorriente Lado V1</span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.upstream.enabled}
                    onChange={(e) => handleUpstreamChange('enabled', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-[#dcdbd7] border border-[#141414] peer-focus:outline-none rounded-none peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:border-[#141414] after:rounded-none after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-[#141414]"></div>
                </label>
              </div>

              <div>
                <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Relación de TC (CT Primary A)</label>
                <input
                  type="number"
                  value={state.upstream.ctRatio}
                  onChange={(e) => handleUpstreamChange('ctRatio', parseFloat(e.target.value) || 1)}
                  disabled={!state.upstream.enabled}
                  className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono disabled:opacity-40 focus:bg-[#fbfbfa] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Tipo de Curva (IEC / IEEE)</label>
                <select
                  value={state.upstream.curveType}
                  onChange={(e) => handleUpstreamChange('curveType', e.target.value)}
                  disabled={!state.upstream.enabled}
                  className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono disabled:opacity-40 focus:bg-[#fbfbfa] focus:outline-none"
                >
                  <option value="iec-si">IEC Standard Inverse (SI)</option>
                  <option value="iec-vi">IEC Very Inverse (VI)</option>
                  <option value="iec-ei">IEC Extremely Inverse (EI)</option>
                  <option value="iec-lti">IEC Long-time Inverse (LTI)</option>
                  <option value="ieee-mi">IEEE Moderately Inverse</option>
                  <option value="ieee-vi">IEEE Very Inverse</option>
                  <option value="ieee-ei">IEEE Extremely Inverse</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Pickup Térmico Is (A Pri)</label>
                  <input
                    type="number"
                    value={state.upstream.pickup}
                    onChange={(e) => handleUpstreamChange('pickup', parseFloat(e.target.value) || 0)}
                    disabled={!state.upstream.enabled}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono disabled:opacity-40 focus:bg-[#fbfbfa] focus:outline-none"
                  />
                  <span className="text-[9px] text-[#141414]/60 font-mono mt-1 block">In1 es {in1.toFixed(1)} A</span>
                </div>
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Dial TMS / TD ({state.upstream.tms.toFixed(2)})</label>
                  <input
                    type="range"
                    min="0.05"
                    max="1.1"
                    step="0.01"
                    value={state.upstream.tms}
                    onChange={(e) => handleUpstreamChange('tms', parseFloat(e.target.value))}
                    disabled={!state.upstream.enabled}
                    className="w-full accent-[#141414] disabled:opacity-40 h-8"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-[#141414] pt-3">
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Inst Pickup I&gt;&gt; (A Pri)</label>
                  <input
                    type="number"
                    value={state.upstream.instPickup}
                    onChange={(e) => handleUpstreamChange('instPickup', parseFloat(e.target.value) || 0)}
                    disabled={!state.upstream.enabled}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono disabled:opacity-40 focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Inst Delay t&gt;&gt; (s)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={state.upstream.instDelay}
                    onChange={(e) => handleUpstreamChange('instDelay', parseFloat(e.target.value) || 0)}
                    disabled={!state.upstream.enabled}
                    className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono disabled:opacity-40 focus:bg-[#fbfbfa] focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: DOWNSTREAM PROTECTION (AVAL) */}
          {activeTab === 'downstream' && (
            <div className="space-y-4 animate-fade-in" id="form-downstream">
              <div>
                <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1.5 font-mono">Tipo de Dispositivo Aval</label>
                <div className="flex bg-white p-1 rounded-none border border-[#141414]">
                  <button
                    id="downstream-mccb-btn"
                    onClick={() => setState(prev => ({ ...prev, downstream: { ...prev.downstream, type: 'mccb' } }))}
                    className={`flex-1 py-1.5 rounded-none text-2xs uppercase tracking-wider font-mono font-bold transition-all ${
                      state.downstream.type === 'mccb' ? 'bg-[#141414] text-[#E4E3E0]' : 'text-[#141414]/60 hover:text-[#141414]'
                    }`}
                  >
                    Interruptor (MCCB)
                  </button>
                  <button
                    id="downstream-fuse-btn"
                    onClick={() => setState(prev => ({ ...prev, downstream: { ...prev.downstream, type: 'fuse' } }))}
                    className={`flex-1 py-1.5 rounded-none text-2xs uppercase tracking-wider font-mono font-bold transition-all ${
                      state.downstream.type === 'fuse' ? 'bg-[#141414] text-[#E4E3E0]' : 'text-[#141414]/60 hover:text-[#141414]'
                    }`}
                  >
                    Fusible gG
                  </button>
                </div>
              </div>

              {state.downstream.type === 'mccb' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">In - Calibre Sensor (A)</label>
                      <input
                        type="number"
                        value={state.downstream.mccb.in}
                        onChange={(e) => handleDownstreamMccbChange('in', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Ir - Térmico (A)</label>
                      <input
                        type="number"
                        value={state.downstream.mccb.ir}
                        onChange={(e) => handleDownstreamMccbChange('ir', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">tr - Retardo Térmico (s)</label>
                      <input
                        type="number"
                        value={state.downstream.mccb.tr}
                        onChange={(e) => handleDownstreamMccbChange('tr', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Isd - Corto Tiempo (A)</label>
                      <input
                        type="number"
                        value={state.downstream.mccb.isd}
                        onChange={(e) => handleDownstreamMccbChange('isd', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t border-[#141414] pt-3">
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">tsd - Retardo Corto (s)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={state.downstream.mccb.tsd}
                        onChange={(e) => handleDownstreamMccbChange('tsd', parseFloat(e.target.value) || 0)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Ii - Instantáneo (A)</label>
                      <input
                        type="number"
                        value={state.downstream.mccb.ii}
                        onChange={(e) => handleDownstreamMccbChange('ii', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Calibre Fusible In (A)</label>
                    <input
                      type="number"
                      value={state.downstream.fuse.in}
                      onChange={(e) => handleDownstreamFuseChange('in', parseFloat(e.target.value) || 1)}
                      className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t border-[#141414] pt-3">
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Coeficiente A (Fusión)</label>
                      <input
                        type="number"
                        value={state.downstream.fuse.curveFitA}
                        onChange={(e) => handleDownstreamFuseChange('curveFitA', parseFloat(e.target.value) || 1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-1 font-mono">Exponente B</label>
                      <input
                        type="number"
                        step="0.1"
                        value={state.downstream.fuse.curveFitB}
                        onChange={(e) => handleDownstreamFuseChange('curveFitB', parseFloat(e.target.value) || 0.1)}
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                  </div>
                  <span className="text-[9px] text-[#141414]/60 block font-mono">Ecuación de fusión ajustada: t = A / (I/In)^B</span>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: SAVED CONFIGURATIONS (SUPABASE) */}
          {activeTab === 'saved' && (
            <div className="space-y-4 animate-fade-in" id="form-saved">
              <div className="border-b border-[#141414] pb-2">
                <span className="text-xs text-[#141414] font-mono font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <Database className="w-4 h-4" />
                  Base de Datos Supabase
                </span>
              </div>

              {dbStatus === 'no_table' ? (
                <div className="bg-red-50 border border-red-500/30 p-4 space-y-3 rounded-none">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
                    <div>
                      <h4 className="text-xs font-bold text-red-800 font-mono uppercase tracking-wide">
                        Tabla 'coordinaciones' no encontrada
                      </h4>
                      <p className="text-[11px] text-red-700/80 font-mono uppercase mt-1">
                        No se pudo encontrar la tabla de base de datos en su proyecto de Supabase.
                      </p>
                    </div>
                  </div>

                  <div className="text-xs text-[#141414]/90 space-y-2 border-t border-red-500/10 pt-3">
                    <p className="font-sans leading-relaxed text-[11px]">
                      Para habilitar el guardado, vaya a su panel de control de Supabase (SQL Editor), cree una nueva consulta, pegue el siguiente código SQL y ejecútelo:
                    </p>

                    <div className="relative">
                      <pre className="bg-[#141414] text-[#E4E3E0] p-3 text-[10px] overflow-x-auto font-mono max-h-[180px] leading-tight rounded-none">
                        {sqlSetupCode}
                      </pre>
                      <button
                        onClick={copySqlToClipboard}
                        className="absolute right-2 top-2 bg-white/10 hover:bg-white/20 text-[#E4E3E0] p-1.5 transition-all active:scale-95 flex items-center gap-1 text-[10px] font-mono"
                      >
                        {copiedSql ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedSql ? 'Copiado' : 'Copiar'}
                      </button>
                    </div>
                    
                    <button
                      onClick={loadSavedConfigs}
                      className="w-full bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 text-2xs font-mono font-bold uppercase tracking-widest px-4 py-2 mt-2 border border-[#141414] flex items-center justify-center gap-1.5 transition-all"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Re-verificar Conexión
                    </button>
                  </div>
                </div>
              ) : dbStatus === 'error' ? (
                <div className="bg-red-50 border border-red-500/30 p-4 rounded-none space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <span className="text-xs font-bold text-red-800 font-mono uppercase">Error de Conexión</span>
                  </div>
                  <p className="text-xs text-red-700 font-mono">{dbErrorMessage}</p>
                  <button
                    onClick={loadSavedConfigs}
                    className="w-full bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 text-2xs font-mono font-bold uppercase tracking-widest px-4 py-2 border border-[#141414] flex items-center justify-center gap-1.5 transition-all"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reintentar Conexión
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* SAVE FORM */}
                  <div className="bg-white border border-[#141414] p-4 rounded-none space-y-3">
                    <span className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block font-mono">Guardar Estado Actual:</span>
                    <div>
                      <label className="text-[9px] font-bold text-[#141414]/70 uppercase tracking-wider block mb-1 font-mono">Nombre de la Configuración</label>
                      <input
                        type="text"
                        value={configName}
                        onChange={(e) => setConfigName(e.target.value)}
                        placeholder="Ej: Subestación A - Coordinada"
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-[#141414]/70 uppercase tracking-wider block mb-1 font-mono">Descripción (Opcional)</label>
                      <input
                        type="text"
                        value={configDesc}
                        onChange={(e) => setConfigDesc(e.target.value)}
                        placeholder="Ej: Con transformador Dyn11 y fusible gG de 250A"
                        className="w-full bg-white text-[#141414] border border-[#141414] rounded-none px-3 py-2 text-sm font-mono focus:bg-[#fbfbfa] focus:outline-none"
                      />
                    </div>
                    <button
                      onClick={saveCurrentConfig}
                      disabled={dbActionLoading || !configName.trim()}
                      className="w-full bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 disabled:opacity-40 text-2xs font-mono font-bold uppercase tracking-widest px-4 py-2.5 border border-[#141414] flex items-center justify-center gap-1.5 transition-all shadow-[2px_2px_0px_0px_#141414] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none"
                    >
                      {dbActionLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Guardar en Supabase
                    </button>
                  </div>

                  {/* LIST OF SAVED CONFIGS */}
                  <div className="space-y-2">
                    <span className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block font-mono">Configuraciones Guardadas:</span>
                    
                    {dbStatus === 'loading' ? (
                      <div className="flex items-center justify-center py-6 gap-2 text-xs font-mono text-[#141414]/60">
                        <RefreshCw className="w-4 h-4 animate-spin text-[#141414]" />
                        Cargando desde Supabase...
                      </div>
                    ) : savedConfigs.length === 0 ? (
                      <div className="bg-[#dcdbd7]/50 border border-dashed border-[#141414]/30 p-6 text-center text-xs font-mono text-[#141414]/60">
                        No hay configuraciones guardadas en la base de datos.
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
                        {savedConfigs.map((cfg) => (
                          <div key={cfg.id} className="bg-white border border-[#141414] p-3 rounded-none flex items-start justify-between gap-3 shadow-[1.5px_1.5px_0px_0px_#141414]">
                            <div className="space-y-1 min-w-0 flex-1">
                              <h5 className="font-mono font-bold text-xs text-[#141414] truncate">{cfg.name}</h5>
                              {cfg.description && (
                                <p className="text-[10px] font-mono text-[#141414]/60 line-clamp-2">{cfg.description}</p>
                              )}
                              <span className="text-[9px] font-mono text-[#141414]/40 block">
                                {new Date(cfg.created_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                              <button
                                onClick={() => loadConfigIntoState(cfg.state)}
                                className="bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 text-3xs font-mono font-bold uppercase tracking-wider px-2 py-1 border border-[#141414] transition-all"
                              >
                                Cargar
                              </button>
                              <button
                                onClick={() => deleteConfig(cfg.id)}
                                disabled={dbActionLoading}
                                className="bg-red-50 text-red-700 hover:bg-red-100 p-1 border border-red-700/25 transition-all disabled:opacity-40 animate-none rounded-none"
                                title="Eliminar"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        
          {/* REFERENCE VOLTAGE FOR TCC PLOT */}
          <div className="border-t border-[#141414] pt-4" id="reference-voltage-selector">
            <label className="text-[10px] font-extrabold text-[#141414] uppercase tracking-widest block mb-2 font-mono">Referencia de Corriente del Gráfico (TCC):</label>
            <div className="grid grid-cols-3 gap-1 bg-white p-1 rounded-none border border-[#141414]">
              <button
                id="ref-sec-btn"
                onClick={() => setState(prev => ({ ...prev, refVoltage: 'v2' }))}
                className={`py-1 rounded-none text-2xs uppercase tracking-wider font-mono font-bold transition-all ${
                  state.refVoltage === 'v2' ? 'bg-[#141414] text-[#E4E3E0]' : 'text-[#141414]/60 hover:text-[#141414]'
                }`}
              >
                Secundario (V2)
              </button>
              <button
                id="ref-pri-btn"
                onClick={() => setState(prev => ({ ...prev, refVoltage: 'v1' }))}
                className={`py-1 rounded-none text-2xs uppercase tracking-wider font-mono font-bold transition-all ${
                  state.refVoltage === 'v1' ? 'bg-[#141414] text-[#E4E3E0]' : 'text-[#141414]/60 hover:text-[#141414]'
                }`}
              >
                Primario (V1)
              </button>
              <button
                id="ref-pu-btn"
                onClick={() => setState(prev => ({ ...prev, refVoltage: 'pu' }))}
                className={`py-1 rounded-none text-2xs uppercase tracking-wider font-mono font-bold transition-all ${
                  state.refVoltage === 'pu' ? 'bg-[#141414] text-[#E4E3E0]' : 'text-[#141414]/60 hover:text-[#141414]'
                }`}
              >
                Por Unidad (pu)
              </button>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: GRAPHICS, QUICK CALCULATOR, AND AI REPORT (7 COLS) */}
        <section className="lg:col-span-7 flex flex-col gap-6" id="output-panel">
          
          {/* TCC CHART CONTAINER */}
          <LogLogChart state={state} />

          {/* QUICK COORDINATES CALCULATOR (RULE 1 SATISFACTION) */}
          <div className="bg-white border border-[#141414] rounded-none p-4 md:p-5 shadow-[4px_4px_0px_0px_#141414]" id="quick-calculator">
            <h3 className="text-xs uppercase tracking-widest font-bold text-[#141414] font-mono flex items-center gap-1.5 mb-2">
              <Calculator className="w-4 h-4 text-[#141414]" />
              Calculadora Precisa de Tiempos de Disparo (Regla 1)
            </h3>
            <p className="text-[11px] font-mono uppercase text-[#141414]/60 mb-3">Calcula matemáticamente el tiempo exacto de despeje ingresando la corriente.</p>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[150px]">
                <div className="relative">
                  <input
                    type="number"
                    value={calcCurrent}
                    onChange={(e) => setCalcCurrent(e.target.value)}
                    className="w-full bg-[#fbfbfa] text-[#141414] border border-[#141414] rounded-none pl-3 pr-32 py-2 text-sm font-mono focus:outline-none"
                    placeholder="Ej. 2000"
                  />
                  <span className="absolute right-3 top-2.5 text-2xs font-bold text-[#141414]/50 font-mono uppercase tracking-wider">
                    {state.refVoltage === 'v2' ? 'A (Sec)' : state.refVoltage === 'v1' ? 'A (Pri)' : 'p.u.'}
                  </span>
                </div>
              </div>
              <button
                id="run-calculation-btn"
                onClick={runSinglePointCalculation}
                disabled={calcLoading}
                className="bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 disabled:opacity-50 text-2xs font-mono font-bold uppercase tracking-widest px-4 py-2 rounded-none border border-[#141414] shadow-[2px_2px_0px_0px_#141414] active:translate-y-[1px] active:translate-x-[1px] active:shadow-none transition-all flex items-center gap-1.5"
              >
                {calcLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Calculator className="w-3.5 h-3.5" />}
                Calcular Tiempo
              </button>
            </div>

            {/* CALCULATOR RESULT PANELS */}
            {calcResult && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2.5 bg-[#f0efec] border border-[#141414] p-3 rounded-none animate-fade-in text-xs font-mono">
                <div className="p-2 bg-white border border-[#141414]">
                  <span className="text-[#141414]/60 block text-[9px] font-bold uppercase tracking-wider">t Aguas Arriba:</span>
                  <span className="text-[#141414] font-bold text-sm">
                    {calcResult.upstreamTime !== null ? `${calcResult.upstreamTime.toFixed(4)} s` : '∞ (No Dispara)'}
                  </span>
                </div>
                <div className="p-2 bg-white border border-[#141414]">
                  <span className="text-[#141414]/60 block text-[9px] font-bold uppercase tracking-wider">t Aguas Abajo:</span>
                  <span className="text-[#141414] font-bold text-sm">
                    {calcResult.downstreamTime !== null ? `${calcResult.downstreamTime.toFixed(4)} s` : '∞ (No Dispara)'}
                  </span>
                </div>
                <div className="p-2 bg-white border border-[#141414]">
                  <span className="text-[#141414]/60 block text-[9px] font-bold uppercase tracking-wider">Margen Selectividad:</span>
                  <span className={`font-bold text-sm ${calcResult.margin !== null && calcResult.margin >= 0.25 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {calcResult.margin !== null ? `${calcResult.margin.toFixed(4)} s` : 'N/A'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* AI REPORT & MATH AUDIT */}
          <div className="bg-[#f0efec] border border-[#141414] rounded-none p-5 md:p-6 flex flex-col gap-4 shadow-[4px_4px_0px_0px_#141414]" id="ai-report-panel">
            
            {/* AUDIT SUMMARY STATUS BADGES */}
            {report && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="flex items-center gap-2.5 bg-white border border-[#141414] p-3 rounded-none shadow-[2px_2px_0px_0px_#141414]">
                  {report.selectivityType === 'total' ? (
                    <CheckCircle className="w-5 h-5 text-emerald-700" />
                  ) : report.selectivityType === 'parcial' ? (
                    <AlertTriangle className="w-5 h-5 text-amber-600" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                  )}
                  <div>
                    <span className="text-[9px] text-[#141414]/60 block uppercase font-bold tracking-wider font-mono">Coordinación:</span>
                    <span className={`text-xs font-bold uppercase tracking-wide font-mono ${
                      report.selectivityType === 'total' ? 'text-emerald-700' : report.selectivityType === 'parcial' ? 'text-amber-600' : 'text-red-600'
                    }`}>
                      Selectividad {report.selectivityType}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 bg-white border border-[#141414] p-3 rounded-none shadow-[2px_2px_0px_0px_#141414]">
                  {report.inrushCoordinationStatus === 'ok' ? (
                    <CheckCircle className="w-5 h-5 text-emerald-700" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                  )}
                  <div>
                    <span className="text-[9px] text-[#141414]/60 block uppercase font-bold tracking-wider font-mono">Corriente Inrush:</span>
                    <span className={`text-xs font-bold uppercase tracking-wide font-mono ${
                      report.inrushCoordinationStatus === 'ok' ? 'text-emerald-700' : 'text-red-700'
                    }`}>
                      {report.inrushCoordinationStatus === 'ok' ? 'Seguro (Soporta)' : 'Riesgo de Disparo'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 bg-white border border-[#141414] p-3 rounded-none shadow-[2px_2px_0px_0px_#141414]">
                  {report.transformerProtectionStatus === 'ok' ? (
                    <CheckCircle className="w-5 h-5 text-emerald-700" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                  )}
                  <div>
                    <span className="text-[9px] text-[#141414]/60 block uppercase font-bold tracking-wider font-mono">Daño Transformador:</span>
                    <span className={`text-xs font-bold uppercase tracking-wide font-mono ${
                      report.transformerProtectionStatus === 'ok' ? 'text-emerald-700' : 'text-red-700'
                    }`}>
                      {report.transformerProtectionStatus === 'ok' ? 'Protegido (OK)' : 'Riesgo de Daño'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* DYNAMIC REAL-TIME EXPLANATION SECTION (USER REQUEST) */}
            {report && (
              <div className="bg-white border border-[#141414] p-4 md:p-5 rounded-none shadow-[2px_2px_0px_0px_#141414] text-xs font-mono space-y-3.5 animate-fade-in" id="realtime-explanation-box">
                <div className="border-b border-[#141414] pb-2">
                  <h4 className="font-['Georgia'] italic font-bold text-sm text-[#141414] flex items-center gap-1.5">
                    <Info className="w-4 h-4 text-[#141414]" />
                    Análisis del Estado de Coordinación y Selectividad
                  </h4>
                  <p className="text-[10px] text-[#141414]/60 uppercase tracking-wider mt-0.5">Explicación en tiempo real según las curvas y ajustes actuales</p>
                </div>

                <div className="space-y-3 text-[#141414]/90">
                  {/* SELECTIVITY EXPLANATION */}
                  <div>
                    <span className="font-bold uppercase text-[10px] block text-[#141414] mb-1">
                      1. Selectividad entre Protecciones (Amontón vs. Aval):
                    </span>
                    {report.selectivityType === 'total' ? (
                      <p className="leading-relaxed">
                        <strong className="text-emerald-700">✓ SELECTIVIDAD TOTAL LOGRADA:</strong> Las curvas de disparo están completamente despejadas en todo el rango de corriente evaluado (desde la corriente de sobrecarga hasta la corriente de falla máxima de {report.iccSecCurrent.toFixed(0)} A). Frente a cualquier cortocircuito o sobrecarga en el lado de baja tensión, el dispositivo de aval actuará de forma rápida y aislada, evitando que el relé amontón (aguas arriba) actúe de forma prematura. Esto garantiza la máxima continuidad de servicio para el resto de la instalación.
                      </p>
                    ) : report.selectivityType === 'parcial' ? (
                      <p className="leading-relaxed">
                        <strong className="text-amber-600">⚠ SELECTIVIDAD PARCIAL (Conflicto en Cortocircuito):</strong> Las protecciones están coordinadas de manera adecuada en la zona de sobrecarga, pero presentan un <span className="underline font-bold text-red-700">conflicto de selectividad en la zona de cortocircuito (zona magnética / tiempo corto)</span>. Ante fallas elevadas en el lado de baja tensión, la curva de amontón se solapa o corta a la de aval. Esto significa que un cortocircuito severo aguas abajo provocará el disparo simultáneo del interruptor general de amontón, causando un apagón general innecesario de toda la planta.
                      </p>
                    ) : (
                      <p className="leading-relaxed">
                        <strong className="text-red-600">✗ SIN SELECTIVIDAD (Cruce Térmico Generalizado):</strong> Existe un solapamiento severo en la <span className="underline font-bold text-red-700">zona térmica de sobrecarga</span>. La curva de amontón (Relé V1) es más rápida que la de aval ante corrientes bajas de sobrecarga. Este es un error de diseño de protecciones crítico, ya que una sobrecarga menor o el encendido de cargas normales aguas abajo provocará la desconexión total del transformador principal de manera intempestiva.
                      </p>
                    )}
                  </div>

                  {/* INRUSH EXPLANATION */}
                  <div className="border-t border-[#141414]/10 pt-2">
                    <span className="font-bold uppercase text-[10px] block text-[#141414] mb-1">
                      2. Coordinación de la Corriente de Inrush (Energización):
                    </span>
                    {report.inrushCoordinationStatus === 'ok' ? (
                      <p className="leading-relaxed">
                        <strong className="text-emerald-700">✓ ENERGIZACIÓN SEGURA:</strong> La curva de disparo del relé de amontón se ubica correctamente por encima y a la derecha del punto de corriente inrush transitoria del transformador ({state.transformer.inrushMult}x In, {state.transformer.inrushTime}s). Esto garantiza que el transformador se pueda energizar de forma segura sin provocar disparos falsos causados por la corriente de magnetización inicial de los devanados.
                      </p>
                    ) : (
                      <p className="leading-relaxed">
                        <strong className="text-red-600">✗ ALTO RIESGO DE DISPARO POR INRUSH:</strong> La curva del relé de amontón interseca o pasa por debajo del punto de inrush del transformador ({state.transformer.inrushMult}x In). Cuando intente energizar el transformador, la corriente de magnetización transitoria disparará instantáneamente la protección principal. <span className="font-bold">Para solucionarlo:</span> Aumente el Pickup térmico (Is), mueva el dial de tiempo (TMS/TD), o desplace el pickup instantáneo (I&gt;&gt;) hacia arriba.
                      </p>
                    )}
                  </div>

                  {/* TRANSFORMER PROTECTION EXPLANATION */}
                  <div className="border-t border-[#141414]/10 pt-2">
                    <span className="font-bold uppercase text-[10px] block text-[#141414] mb-1">
                      3. Protección contra Daño Térmico del Transformador:
                    </span>
                    {report.transformerProtectionStatus === 'ok' ? (
                      <p className="leading-relaxed">
                        <strong className="text-emerald-700">✓ TRANSFORMADOR PROTEGIDO:</strong> La curva de actuación del relé de amontón queda completamente por debajo y a la izquierda de la curva de daño del transformador estipulada por la norma IEEE C57.109. En caso de una falla interna o externa severa y sostenida, el relé despejará la corriente de falla antes de que los conductores y aislamientos del transformador sufran degradación térmica irreversible.
                      </p>
                    ) : (
                      <p className="leading-relaxed">
                        <strong className="text-red-600">✗ RIESGO DE DAÑO SEVERO EN TRANSFORMADOR:</strong> El relé de amontón demora demasiado tiempo en actuar y su curva supera la curva de daño térmico IEEE C57.109. Esto expone al transformador a fallas térmicas y mecánicas destructivas antes de que la protección actúe. <span className="font-bold">Para solucionarlo:</span> Disminuya el dial de tiempo (TMS/TD) del relé de amontón o reduzca el Pickup térmico (Is) para acelerar el despeje de fallas elevadas.
                      </p>
                    )}
                  </div>

                  {/* RECOMENDACIONES TÉCNICAS */}
                  <div className="border-t border-[#141414] pt-2.5 mt-1 bg-[#dcdbd7]/40 p-3">
                    <span className="font-bold uppercase text-[10px] block text-[#141414] mb-1">
                      Recomendaciones de Ajuste Sugeridas:
                    </span>
                    <ul className="list-disc list-inside space-y-1 text-[#141414]/80 text-[11px]">
                      {report.selectivityType !== 'total' && (
                        <li>
                          Aumente el dial de tiempo <span className="font-bold">TMS / TD</span> del relé de amontón para elevar su curva, o reduzca el tiempo de cortocircuito <span className="font-bold">tsd</span> del interruptor de aval.
                        </li>
                      )}
                      {state.upstream.curveType.startsWith('iec-si') && report.selectivityType !== 'total' && (
                        <li>
                          Cambie el tipo de curva del relé de amontón a <span className="font-bold">IEC Extremely Inverse (EI)</span>. Su mayor pendiente se adapta óptimamente a la respuesta de los interruptores automáticos termomagnéticos e interruptores de caja moldeada (MCCB), facilitando el logro de selectividad total.
                        </li>
                      )}
                      {report.inrushCoordinationStatus === 'risk' && (
                        <li>
                          Suba el Pickup térmico <span className="font-bold">Is</span> o configure el Pickup instantáneo <span className="font-bold">I&gt;&gt;</span> a un valor superior a la corriente inrush reflejada en el primario.
                        </li>
                      )}
                      {report.transformerProtectionStatus === 'risk' && (
                        <li>
                          Reduzca el dial de tiempo <span className="font-bold">TMS</span> para forzar un disparo más rápido frente a corrientes de cortocircuito, manteniéndose por debajo de la curva de daño.
                        </li>
                      )}
                      {report.selectivityType === 'total' && report.inrushCoordinationStatus === 'ok' && report.transformerProtectionStatus === 'ok' && (
                        <li className="text-emerald-700 font-bold list-none">
                          ✓ El sistema eléctrico se encuentra óptimamente coordinado y protegido bajo las normas IEC/IEEE vigentes. No se requieren ajustes adicionales.
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* INTERACTIVE RELAY AUTO-TUNER SECTION (USER REQUEST) */}
            {report && (() => {
              const optimal = calculateOptimalSettings(state);
              // Check if any parameters differ from current settings
              const isCtDifferent = state.upstream.ctRatio !== optimal.ctRatio;
              const isPickupDifferent = state.upstream.pickup !== optimal.pickup;
              const isCurveDifferent = state.upstream.curveType !== optimal.curveType;
              const isTmsDifferent = Math.abs(state.upstream.tms - optimal.tms) > 0.015;
              const isInstDifferent = state.upstream.instPickup !== optimal.instPickup;

              const hasAnyDifference = isCtDifferent || isPickupDifferent || isCurveDifferent || isTmsDifferent || isInstDifferent;

              const curveNamesMap: Record<string, string> = {
                'iec-si': 'IEC Estándar Inversa (SI)',
                'iec-vi': 'IEC Muy Inversa (VI)',
                'iec-ei': 'IEC Extremadamente Inversa (EI)',
                'iec-lti': 'IEC Tiempo Largo Inverso (LTI)',
                'ieee-mi': 'IEEE Moderadamente Inversa (MI)',
                'ieee-vi': 'IEEE Muy Inversa (VI)',
                'ieee-ei': 'IEEE Extremadamente Inversa (EI)'
              };

              return (
                <div className="bg-white border border-[#141414] p-4 md:p-5 rounded-none shadow-[2px_2px_0px_0px_#141414] text-xs font-mono space-y-4 animate-fade-in" id="relay-tuning-proposal-box">
                  <div className="border-b border-[#141414] pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <h4 className="font-['Georgia'] italic font-bold text-sm text-[#141414] flex items-center gap-1.5">
                        <Sliders className="w-4 h-4 text-[#141414]" />
                        Sintonizador de Relé Amontón (Ajustes Propuestos)
                      </h4>
                      <p className="text-[10px] text-[#141414]/60 uppercase tracking-wider mt-0.5">Optimización matemática en tiempo real para eliminar cruces de curvas</p>
                    </div>
                    {hasAnyDifference && (
                      <button
                        onClick={applyOptimalSettings}
                        className="bg-amber-500 hover:bg-amber-600 text-[#141414] text-3xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-none border border-[#141414] shadow-[1.5px_1.5px_0px_0px_#141414] active:translate-y-[1px] active:translate-x-[1px] active:shadow-none transition-all flex items-center gap-1"
                        id="auto-tune-apply-btn"
                      >
                        <Sparkles className="w-3 h-3 text-[#141414]" fill="currentColor" />
                        Corregir Curvas (Auto-Sintonizar)
                      </button>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-3xs uppercase tracking-wider border-collapse">
                      <thead>
                        <tr className="border-b border-[#141414] bg-[#dcdbd7]/50 font-bold">
                          <th className="p-2 border-r border-[#141414]/10">Parámetro</th>
                          <th className="p-2 border-r border-[#141414]/10">Ajuste Actual</th>
                          <th className="p-2 border-r border-[#141414]/10 text-amber-900 bg-amber-500/10">Propuesta de Sintonía</th>
                          <th className="p-2">Estado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#141414]/10 font-sans text-xs">
                        {/* CT Ratio */}
                        <tr>
                          <td className="p-2 font-mono text-3xs uppercase tracking-wider border-r border-[#141414]/10 font-bold">Relación de TC</td>
                          <td className="p-2 border-r border-[#141414]/10">{state.upstream.ctRatio}:5 A</td>
                          <td className="p-2 border-r border-[#141414]/10 font-bold text-amber-700 bg-amber-500/5">{optimal.ctRatio}:5 A</td>
                          <td className="p-2 font-mono text-3xs">
                            {isCtDifferent ? (
                              <span className="text-amber-600 font-bold">⚡ Diferente</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">✓ Óptimo</span>
                            )}
                          </td>
                        </tr>
                        {/* Pickup */}
                        <tr>
                          <td className="p-2 font-mono text-3xs uppercase tracking-wider border-r border-[#141414]/10 font-bold">Pickup Térmico (Is)</td>
                          <td className="p-2 border-r border-[#141414]/10">{state.upstream.pickup} A</td>
                          <td className="p-2 border-r border-[#141414]/10 font-bold text-amber-700 bg-amber-500/5">{optimal.pickup} A</td>
                          <td className="p-2 font-mono text-3xs">
                            {isPickupDifferent ? (
                              <span className="text-amber-600 font-bold">⚡ Desviado</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">✓ Coordinado</span>
                            )}
                          </td>
                        </tr>
                        {/* Curve Type */}
                        <tr>
                          <td className="p-2 font-mono text-3xs uppercase tracking-wider border-r border-[#141414]/10 font-bold">Tipo de Curva</td>
                          <td className="p-2 border-r border-[#141414]/10">{curveNamesMap[state.upstream.curveType] || state.upstream.curveType}</td>
                          <td className="p-2 border-r border-[#141414]/10 font-bold text-amber-700 bg-amber-500/5">{curveNamesMap[optimal.curveType] || optimal.curveType}</td>
                          <td className="p-2 font-mono text-3xs">
                            {isCurveDifferent ? (
                              <span className="text-amber-600 font-bold">⚡ Inadecuada</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">✓ Ideal (EI)</span>
                            )}
                          </td>
                        </tr>
                        {/* TMS / TD */}
                        <tr>
                          <td className="p-2 font-mono text-3xs uppercase tracking-wider border-r border-[#141414]/10 font-bold">Dial de Tiempo (TMS)</td>
                          <td className="p-2 border-r border-[#141414]/10">{state.upstream.tms.toFixed(2)}</td>
                          <td className="p-2 border-r border-[#141414]/10 font-bold text-amber-700 bg-amber-500/5">{optimal.tms.toFixed(2)}</td>
                          <td className="p-2 font-mono text-3xs">
                            {isTmsDifferent ? (
                              <span className="text-amber-600 font-bold">⚡ Cruce de Curva</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">✓ Margen Seguro</span>
                            )}
                          </td>
                        </tr>
                        {/* Instantaneous Pickup */}
                        <tr>
                          <td className="p-2 font-mono text-3xs uppercase tracking-wider border-r border-[#141414]/10 font-bold">Pickup Inst (I&gt;&gt;)</td>
                          <td className="p-2 border-r border-[#141414]/10">{state.upstream.instPickup} A</td>
                          <td className="p-2 border-r border-[#141414]/10 font-bold text-amber-700 bg-amber-500/5">{optimal.instPickup} A</td>
                          <td className="p-2 font-mono text-3xs">
                            {isInstDifferent ? (
                              <span className="text-amber-600 font-bold">⚡ Conflicto Inrush/Icc</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">✓ Selectivo</span>
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* DETAILS AND EXPLANATION CARDS */}
                  <div className="space-y-2 font-sans text-xs text-[#141414]/90 bg-[#f0efec]/50 p-3.5 border border-[#141414]/10">
                    <span className="font-mono font-bold uppercase text-[10px] block text-[#141414] mb-1.5">
                      Fundamentos Técnicos de la Propuesta:
                    </span>
                    <ul className="space-y-2 list-none">
                      {isCtDifferent && (
                        <li className="flex gap-1.5">
                          <span className="text-amber-600 font-bold font-mono">⚡ [TC]:</span>
                          <p className="leading-relaxed">{optimal.explanation.ctRatio}</p>
                        </li>
                      )}
                      {isPickupDifferent && (
                        <li className="flex gap-1.5">
                          <span className="text-amber-600 font-bold font-mono">⚡ [Is]:</span>
                          <p className="leading-relaxed">{optimal.explanation.pickup}</p>
                        </li>
                      )}
                      {isCurveDifferent && (
                        <li className="flex gap-1.5">
                          <span className="text-amber-600 font-bold font-mono">⚡ [Curva]:</span>
                          <p className="leading-relaxed">{optimal.explanation.curveType}</p>
                        </li>
                      )}
                      {isTmsDifferent && (
                        <li className="flex gap-1.5">
                          <span className="text-amber-600 font-bold font-mono">⚡ [TMS]:</span>
                          <p className="leading-relaxed">{optimal.explanation.tms}</p>
                        </li>
                      )}
                      {isInstDifferent && (
                        <li className="flex gap-1.5">
                          <span className="text-amber-600 font-bold font-mono">⚡ [I&gt;&gt;]:</span>
                          <p className="leading-relaxed">{optimal.explanation.instPickup}</p>
                        </li>
                      )}
                      {!hasAnyDifference && (
                        <li className="text-emerald-700 font-bold flex items-center gap-1.5 font-mono">
                          <CheckCircle className="w-4 h-4" />
                          ¡Felicidades! Todos los parámetros de su relé están perfectamente sintonizados con el algoritmo matemático de selectividad óptima. Las curvas están coordinadas con margen de seguridad.
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              );
            })()}

            {/* ACTION FOR GENERATING THE EXPERT IA REPORT */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-t border-[#141414] pt-4 gap-3">
              <div>
                <h3 className="text-xs uppercase tracking-widest font-bold text-[#141414] font-mono flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-600" fill="currentColor" />
                  Auditoría Experta con IA de Selectividad
                </h3>
                <p className="text-[11px] font-mono uppercase text-[#141414]/60">Genera un dictamen formal con recomendaciones según IEC/IEEE.</p>
              </div>
              <button
                id="generate-ai-report-btn"
                onClick={generateAiReport}
                disabled={loading}
                className="bg-[#141414] text-[#E4E3E0] hover:bg-[#141414]/90 disabled:opacity-50 text-2xs font-mono font-bold uppercase tracking-widest px-4 py-2.5 rounded-none border border-[#141414] shadow-[3px_3px_0px_0px_#141414] active:translate-y-[1px] active:translate-x-[1px] active:shadow-none transition-all flex items-center gap-1.5"
              >
                {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                {report?.aiEvaluation ? 'Regenerar Informe con IA' : 'Generar Informe con IA'}
              </button>
            </div>

            {/* AI EVALUATION OUTPUT AREA */}
            {loading ? (
              <div className="bg-white border border-[#141414] rounded-none p-8 flex flex-col items-center justify-center gap-3 text-[#141414]">
                <RefreshCw className="w-8 h-8 text-[#141414] animate-spin" />
                <div className="text-center">
                  <p className="text-xs font-mono font-bold tracking-widest uppercase text-[#141414] mb-1">Corriendo Simulación Térmica y Magnética...</p>
                  <p className="text-[11px] font-mono uppercase text-[#141414]/60">Gemini está analizando los puntos críticos y la curva de daño del transformador.</p>
                </div>
              </div>
            ) : report?.aiEvaluation ? (
              <div className="bg-white border border-[#141414] rounded-none p-5 text-[#141414] max-h-[500px] overflow-y-auto shadow-inner" id="ai-evaluation-output">
                <div className="prose max-w-none text-xs md:text-sm font-sans text-[#141414]">
                  <ReactMarkdown>{report.aiEvaluation}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="bg-white border border-[#141414] border-dashed rounded-none p-8 flex flex-col items-center justify-center text-center gap-2">
                <Info className="w-7 h-7 text-[#141414]/40" />
                <div>
                  <h4 className="text-xs font-mono uppercase font-bold text-[#141414]">¿Listo para auditar el sistema?</h4>
                  <p className="text-[11px] font-mono uppercase text-[#141414]/60 max-w-md mx-auto mt-1">Configure los parámetros a la izquierda, observe la interacción en el gráfico log-log y haga clic en Generar Informe para recibir un análisis experto automatizado.</p>
                </div>
              </div>
            )}
          </div>
        </section>

      </main>

      {/* FOOTER */}
      <footer className="border-t border-[#141414] bg-[#141414] py-6 text-center text-3xs text-[#E4E3E0]/75 font-mono uppercase tracking-widest">
        Análisis de selectividad térmica y magnética según IEC 60255 y IEEE C57.109 • Diseñado con rigurosidad de ingeniería • {new Date().getFullYear()}
      </footer>
    </div>
  );
}
