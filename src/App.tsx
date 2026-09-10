import React, { useMemo, useState } from "react";
import {
  Wheat,
  Palmtree,
  Zap,
  Droplet,
  Settings2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronRight,
  Gauge,
  FlaskConical,
  ClipboardList,
  ArrowRight,
  Sprout,
} from "lucide-react";

/* ============================================================================
   MODEL CONSTANTS
   ============================================================================ */

const RICE_LHV_DRY = 16.7; // MJ/kg dry
const COCONUT_LHV_DRY = 20.58; // MJ/kg dry
const RICE_CGE = 0.6;
const COCONUT_CGE = 0.7;
const GENSET_EFFICIENCY = 0.2;
const H_VAP = 2.44; // MJ/kg water, latent heat of evaporation
const CANDIDATE_STEP = 0.05;

/* ============================================================================
   TYPES
   ============================================================================ */

interface FeedstockInput {
  massWetKg: number;
  moisturePct: number;
}

interface PlannerInputs {
  rice: FeedstockInput;
  coconut: FeedstockInput;
  loadKw: number;
  runtimeHours: number;
  reservePct: number;
}

interface CandidateResult {
  xCoconut: number;
  lhv: number;
  cge: number;
  waterPerKgDry: number;
  netLhv: number;
  moistureBlocked: boolean;
  electricMjPerKgDry: number;
  requiredDryKg: number;
  requiredRiceWetKg: number;
  requiredCoconutWetKg: number;
  requiredTotalWetKg: number;
  feasible: boolean;
}

interface FallbackResult {
  xCoconut: number;
  maxDryKg: number;
  maxElectricMj: number;
  maxRuntimeHours: number;
  riceWetUsed: number;
  coconutWetUsed: number;
  limitingFactor: "Rice husk inventory" | "Coconut shell inventory" | "Both feedstocks";
}

interface OptimizationResult {
  status: "FEASIBLE" | "INSUFFICIENT_INVENTORY";
  candidates: CandidateResult[];
  recommended: CandidateResult | null;
  fallback: FallbackResult | null;
  demandMj: number;
}

/* ============================================================================
   MODEL LOGIC (ported faithfully from the Python specification)
   ============================================================================ */

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

function evaluateCandidate(
  xCoconut: number,
  inputs: PlannerInputs,
  demandMj: number
): CandidateResult {
  const riceMoisture = inputs.rice.moisturePct / 100;
  const coconutMoisture = inputs.coconut.moisturePct / 100;

  const lhv = (1 - xCoconut) * RICE_LHV_DRY + xCoconut * COCONUT_LHV_DRY;
  const cge = (1 - xCoconut) * RICE_CGE + xCoconut * COCONUT_CGE;

  // Evaluate moisture penalty per 1 kg dry basis (D = 1.0)
  const riceDryUnit = 1 - xCoconut;
  const coconutDryUnit = xCoconut;
  const riceWetUnit = riceDryUnit / (1 - riceMoisture);
  const coconutWetUnit = coconutDryUnit / (1 - coconutMoisture);
  const waterKgUnit = riceWetUnit - riceDryUnit + (coconutWetUnit - coconutDryUnit);
  const waterPerKgDry = waterKgUnit / 1.0;

  const netLhv = lhv - waterPerKgDry * H_VAP;
  const moistureBlocked = netLhv <= 0;

  if (moistureBlocked) {
    return {
      xCoconut,
      lhv,
      cge,
      waterPerKgDry,
      netLhv,
      moistureBlocked: true,
      electricMjPerKgDry: 0,
      requiredDryKg: Infinity,
      requiredRiceWetKg: Infinity,
      requiredCoconutWetKg: Infinity,
      requiredTotalWetKg: Infinity,
      feasible: false,
    };
  }

  const electricMjPerKgDry = netLhv * cge * GENSET_EFFICIENCY;
  const requiredDryKg = demandMj / electricMjPerKgDry;

  const requiredRiceDryKg = (1 - xCoconut) * requiredDryKg;
  const requiredCoconutDryKg = xCoconut * requiredDryKg;
  const requiredRiceWetKg = requiredRiceDryKg / (1 - riceMoisture);
  const requiredCoconutWetKg = requiredCoconutDryKg / (1 - coconutMoisture);
  const requiredTotalWetKg = requiredRiceWetKg + requiredCoconutWetKg;

  const reserveFraction = inputs.reservePct / 100;
  const availableRiceUsable = inputs.rice.massWetKg * (1 - reserveFraction);
  const availableCoconutUsable = inputs.coconut.massWetKg * (1 - reserveFraction);

  const feasible =
    requiredRiceWetKg <= availableRiceUsable &&
    requiredCoconutWetKg <= availableCoconutUsable;

  return {
    xCoconut,
    lhv,
    cge,
    waterPerKgDry,
    netLhv,
    moistureBlocked: false,
    electricMjPerKgDry,
    requiredDryKg,
    requiredRiceWetKg,
    requiredCoconutWetKg,
    requiredTotalWetKg,
    feasible,
  };
}

function evaluateMaxSupported(
  xCoconut: number,
  inputs: PlannerInputs
): FallbackResult | null {
  const riceMoisture = inputs.rice.moisturePct / 100;
  const coconutMoisture = inputs.coconut.moisturePct / 100;
  const reserveFraction = inputs.reservePct / 100;

  const usableRiceWet = inputs.rice.massWetKg * (1 - reserveFraction);
  const usableCoconutWet = inputs.coconut.massWetKg * (1 - reserveFraction);

  let maxDFromRice = Infinity;
  let maxDFromCoconut = Infinity;

  if (xCoconut < 1) {
    maxDFromRice = (usableRiceWet * (1 - riceMoisture)) / (1 - xCoconut);
  }
  if (xCoconut > 0) {
    maxDFromCoconut = (usableCoconutWet * (1 - coconutMoisture)) / xCoconut;
  }

  const maxD = Math.min(maxDFromRice, maxDFromCoconut);
  if (!isFinite(maxD) || maxD <= 0) return null;

  const riceDry = (1 - xCoconut) * maxD;
  const coconutDry = xCoconut * maxD;
  const riceWetUsed = riceDry / (1 - riceMoisture);
  const coconutWetUsed = coconutDry / (1 - coconutMoisture);

  const lhv = (1 - xCoconut) * RICE_LHV_DRY + xCoconut * COCONUT_LHV_DRY;
  const cge = (1 - xCoconut) * RICE_CGE + xCoconut * COCONUT_CGE;
  const waterKg = riceWetUsed - riceDry + (coconutWetUsed - coconutDry);
  const waterPerKgDry = waterKg / maxD;
  const netLhv = lhv - waterPerKgDry * H_VAP;
  if (netLhv <= 0) return null;

  const maxElectricMj = netLhv * cge * GENSET_EFFICIENCY * maxD;
  const maxRuntimeHours = inputs.loadKw > 0 ? maxElectricMj / (inputs.loadKw * 3.6) : 0;

  let limitingFactor: FallbackResult["limitingFactor"] = "Both feedstocks";
  if (maxDFromRice < maxDFromCoconut) limitingFactor = "Rice husk inventory";
  else if (maxDFromCoconut < maxDFromRice) limitingFactor = "Coconut shell inventory";

  return {
    xCoconut,
    maxDryKg: maxD,
    maxElectricMj,
    maxRuntimeHours,
    riceWetUsed,
    coconutWetUsed,
    limitingFactor,
  };
}

function optimize(inputs: PlannerInputs): OptimizationResult {
  const demandMj = inputs.loadKw * inputs.runtimeHours * 3.6;

  const candidates: CandidateResult[] = [];
  const steps = Math.round(1 / CANDIDATE_STEP);
  for (let i = 0; i <= steps; i++) {
    const x = round2(i * CANDIDATE_STEP);
    candidates.push(evaluateCandidate(x, inputs, demandMj));
  }

  const feasibleCandidates = candidates.filter((c) => c.feasible);

  if (feasibleCandidates.length > 0) {
    const recommended = feasibleCandidates.reduce((best, c) =>
      c.requiredTotalWetKg < best.requiredTotalWetKg ? c : best
    );
    return {
      status: "FEASIBLE",
      candidates,
      recommended,
      fallback: null,
      demandMj,
    };
  }

  // Fallback: no feasible candidate meets the full demand.
  let best: FallbackResult | null = null;
  for (let i = 0; i <= steps; i++) {
    const x = round2(i * CANDIDATE_STEP);
    const result = evaluateMaxSupported(x, inputs);
    if (result && (!best || result.maxElectricMj > best.maxElectricMj)) {
      best = result;
    }
  }

  return {
    status: "INSUFFICIENT_INVENTORY",
    candidates,
    recommended: null,
    fallback: best,
    demandMj,
  };
}

/* ============================================================================
   FORMATTING HELPERS
   ============================================================================ */

const fmt = (n: number, decimals = 2) => {
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const pct = (n: number, decimals = 0) => `${fmt(n * 100, decimals)}%`;

/* ============================================================================
   UI PRIMITIVES
   ============================================================================ */

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-[#DCD3B8] bg-[#FBF8EF] shadow-[0_1px_2px_rgba(43,42,31,0.06)] ${className}`}
    >
      {children}
    </div>
  );
}

function SectionLabel({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-[#5C6B47] mb-3">
      <span className="shrink-0">{icon}</span>
      <h3 className="text-sm font-semibold tracking-wide text-[#3A3826]">{children}</h3>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  min = 0,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#6B6A54]">{label}</span>
      <div className="mt-1 flex items-center rounded-lg border border-[#D6CCA8] bg-white focus-within:border-[#5C6B47] focus-within:ring-1 focus-within:ring-[#5C6B47] overflow-hidden">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full px-3 py-2 text-[15px] font-mono text-[#2B2A1F] outline-none bg-transparent"
        />
        {suffix && (
          <span className="px-3 text-xs text-[#8A886E] border-l border-[#EAE3C8] py-2">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

/* ============================================================================
   MAIN APPLICATION
   ============================================================================ */

const DEFAULT_INPUTS: PlannerInputs = {
  rice: { massWetKg: 25, moisturePct: 12 },
  coconut: { massWetKg: 8, moisturePct: 10 },
  loadKw: 0.2,
  runtimeHours: 8,
  reservePct: 10,
};

type StepId = 1 | 2 | 3 | 4;

const STEPS: { id: StepId; label: string }[] = [
  { id: 1, label: "Setup" },
  { id: 2, label: "Energy plan" },
  { id: 3, label: "Analysis" },
  { id: 4, label: "Assumptions" },
];

export default function App() {
  const [draft, setDraft] = useState<PlannerInputs>(DEFAULT_INPUTS);
  const [submitted, setSubmitted] = useState<PlannerInputs | null>(null);
  const [step, setStep] = useState<StepId>(1);

  const result = useMemo(() => (submitted ? optimize(submitted) : null), [submitted]);

  const canAdvance = submitted !== null;

  function generatePlan() {
    setSubmitted(draft);
    setStep(2);
  }

  function goTo(id: StepId) {
    if (id !== 1 && !canAdvance) return;
    setStep(id);
  }

  return (
    <div className="min-h-screen w-full bg-[#F2EEDD] text-[#2B2A1F]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap');
        .font-display { font-family: 'Fraunces', ui-serif, Georgia, serif; }
      `}</style>

      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-8 sm:py-12">
        {/* Header */}
        <header className="mb-10">
          <div className="flex items-start justify-between gap-4">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-[#5C6B47]/30 bg-[#5C6B47]/10 px-3 py-1 text-[11px] font-medium text-[#4A5738]">
              <FlaskConical size={12} />
              Prototype decision-support model
            </div>
            <a
              href="https://github.com/acai-bowl/Adaptive-Biomass-Energy-Planner"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#3A3826]/20 px-3 py-1.5 text-xs font-medium text-[#5B5946] transition-colors hover:border-[#3A3826]/40 hover:bg-[#EDE7CC] hover:text-[#3A3826]"
            >
              View on GitHub
            </a>
          </div>
          <h1 className="font-display mt-4 text-[34px] sm:text-[44px] leading-[1.05] font-semibold text-[#2B2A1F]">
            Adaptive Biomass Energy Planner
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[#5B5946]">
            Turn locally available agricultural residues into an adaptable energy plan.
          </p>
        </header>

        {/* Stepper */}
        <nav className="mb-8 flex items-center gap-1 overflow-x-auto">
          {STEPS.map((s, idx) => {
            const active = step === s.id;
            const reachable = s.id === 1 || canAdvance;
            return (
              <React.Fragment key={s.id}>
                <button
                  onClick={() => goTo(s.id)}
                  disabled={!reachable}
                  className={`flex items-center gap-2 rounded-full px-3.5 py-2 text-sm transition-colors whitespace-nowrap
                    ${active ? "bg-[#3A3826] text-[#F2EEDD]" : reachable ? "text-[#4A4838] hover:bg-[#E7E0C4]" : "text-[#B7B39A] cursor-not-allowed"}
                  `}
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-mono ${
                      active
                        ? "bg-[#F2EEDD] text-[#3A3826]"
                        : "bg-[#DED5B2] text-[#5B5946]"
                    }`}
                  >
                    {s.id}
                  </span>
                  {s.label}
                </button>
                {idx < STEPS.length - 1 && (
                  <ChevronRight size={14} className="text-[#C6BE9C] shrink-0" />
                )}
              </React.Fragment>
            );
          })}
        </nav>

        {/* Step content */}
        {step === 1 && <SetupStep draft={draft} setDraft={setDraft} onGenerate={generatePlan} />}
        {step === 2 && result && submitted && (
          <ResultsStep result={result} inputs={submitted} onSeeAnalysis={() => setStep(3)} />
        )}
        {step === 3 && result && submitted && (
          <AnalysisStep result={result} inputs={submitted} />
        )}
        {step === 4 && <AssumptionsStep reservePct={submitted?.reservePct ?? draft.reservePct} />}
      </div>
    </div>
  );
}

/* ============================================================================
   STEP 1 — SETUP
   ============================================================================ */

function SetupStep({
  draft,
  setDraft,
  onGenerate,
}: {
  draft: PlannerInputs;
  setDraft: React.Dispatch<React.SetStateAction<PlannerInputs>>;
  onGenerate: () => void;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Card className="p-5">
        <SectionLabel icon={<Wheat size={16} />}>Rice husk inventory</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Mass available"
            suffix="kg wet"
            value={draft.rice.massWetKg}
            step={0.5}
            onChange={(v) => setDraft((d) => ({ ...d, rice: { ...d.rice, massWetKg: v } }))}
          />
          <NumberField
            label="Moisture content"
            suffix="%"
            value={draft.rice.moisturePct}
            max={95}
            step={0.5}
            onChange={(v) => setDraft((d) => ({ ...d, rice: { ...d.rice, moisturePct: v } }))}
          />
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel icon={<Palmtree size={16} />}>Coconut shell inventory</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Mass available"
            suffix="kg wet"
            value={draft.coconut.massWetKg}
            step={0.5}
            onChange={(v) => setDraft((d) => ({ ...d, coconut: { ...d.coconut, massWetKg: v } }))}
          />
          <NumberField
            label="Moisture content"
            suffix="%"
            value={draft.coconut.moisturePct}
            max={95}
            step={0.5}
            onChange={(v) =>
              setDraft((d) => ({ ...d, coconut: { ...d.coconut, moisturePct: v } }))
            }
          />
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel icon={<Zap size={16} />}>Energy demand</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Load"
            suffix="kW"
            value={draft.loadKw}
            step={0.05}
            onChange={(v) => setDraft((d) => ({ ...d, loadKw: v }))}
          />
          <NumberField
            label="Target operating time"
            suffix="hours"
            value={draft.runtimeHours}
            step={0.5}
            onChange={(v) => setDraft((d) => ({ ...d, runtimeHours: v }))}
          />
        </div>
      </Card>

      <Card className="p-5">
        <SectionLabel icon={<Settings2 size={16} />}>System parameters</SectionLabel>
        <label className="block">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#6B6A54]">Reserve margin</span>
            <span className="font-mono text-sm text-[#3A3826]">{draft.reservePct}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={draft.reservePct}
            onChange={(e) => setDraft((d) => ({ ...d, reservePct: parseFloat(e.target.value) }))}
            className="mt-3 w-full accent-[#5C6B47]"
          />
          <p className="mt-2 text-xs leading-relaxed text-[#8A886E]">
            Feedstock held back from every plan as an operating buffer, so the
            community never draws inventory down to zero.
          </p>
        </label>
      </Card>

      <div className="sm:col-span-2 flex justify-end">
        <button
          onClick={onGenerate}
          className="inline-flex items-center gap-2 rounded-lg bg-[#3A3826] px-5 py-2.5 text-sm font-medium text-[#F2EEDD] transition-colors hover:bg-[#2B2A1F]"
        >
          Generate energy plan
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   STEP 2 — RESULTS (HERO VIEW)
   ============================================================================ */

function BlendBar({ xCoconut }: { xCoconut: number }) {
  const coconutPct = xCoconut * 100;
  const ricePct = 100 - coconutPct;
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-md border border-[#DCD3B8]">
        <div
          className="flex items-center justify-center bg-[#C9A227] text-[11px] font-mono text-[#3A3826] transition-all"
          style={{ width: `${ricePct}%` }}
        >
          {ricePct >= 12 ? `${fmt(ricePct, 0)}%` : ""}
        </div>
        <div
          className="flex items-center justify-center bg-[#B4652A] text-[11px] font-mono text-[#FBF8EF] transition-all"
          style={{ width: `${coconutPct}%` }}
        >
          {coconutPct >= 12 ? `${fmt(coconutPct, 0)}%` : ""}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-[#6B6A54]">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#C9A227]" /> Rice husk
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-[#B4652A]" /> Coconut shell
        </span>
      </div>
    </div>
  );
}

function MetricTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg border border-[#DCD3B8] bg-white px-4 py-3">
      <div className="text-[11px] text-[#8A886E]">{label}</div>
      <div className="mt-1 font-mono text-lg text-[#2B2A1F]">
        {value}
        {unit && <span className="ml-1 text-xs text-[#8A886E]">{unit}</span>}
      </div>
    </div>
  );
}

function ResultsStep({
  result,
  inputs,
  onSeeAnalysis,
}: {
  result: OptimizationResult;
  inputs: PlannerInputs;
  onSeeAnalysis: () => void;
}) {
  const feasible = result.status === "FEASIBLE";

  return (
    <div className="space-y-5">
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {feasible ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#5C6B47]/15 px-3 py-1 text-xs font-semibold text-[#3F5A2E]">
              <CheckCircle2 size={14} /> FEASIBLE
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#C77D2B]/15 px-3 py-1 text-xs font-semibold text-[#95591A]">
              <AlertTriangle size={14} /> INSUFFICIENT INVENTORY
            </span>
          )}
          <span className="text-xs text-[#8A886E]">
            Target: {fmt(inputs.loadKw, 2)} kW for {fmt(inputs.runtimeHours, 1)} h
          </span>
        </div>

        {feasible && result.recommended && (
          <>
            <h2 className="font-display mt-5 text-2xl sm:text-3xl font-medium text-[#2B2A1F]">
              {fmt(result.recommended.xCoconut * 100, 0)}% coconut shell / {fmt(
                (1 - result.recommended.xCoconut) * 100,
                0
              )}% rice husk
            </h2>
            <p className="mt-1 text-sm text-[#6B6A54]">
              This blend meets the full target load using the least total wet feedstock.
            </p>

            <div className="mt-6">
              <BlendBar xCoconut={result.recommended.xCoconut} />
            </div>

            <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetricTile
                label="Required biomass"
                value={fmt(result.recommended.requiredTotalWetKg, 1)}
                unit="kg wet"
              />
              <MetricTile
                label="Estimated electricity"
                value={fmt(inputs.loadKw * inputs.runtimeHours, 2)}
                unit="kWh"
              />
              <MetricTile label="Estimated runtime" value={fmt(inputs.runtimeHours, 1)} unit="hrs" />
              <MetricTile
                label="Remaining rice husk"
                value={fmt(inputs.rice.massWetKg - result.recommended.requiredRiceWetKg, 1)}
                unit="kg wet"
              />
            </div>

            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetricTile
                label="Rice husk used"
                value={fmt(result.recommended.requiredRiceWetKg, 1)}
                unit="kg wet"
              />
              <MetricTile
                label="Coconut shell used"
                value={fmt(result.recommended.requiredCoconutWetKg, 1)}
                unit="kg wet"
              />
              <MetricTile
                label="Remaining coconut shell"
                value={fmt(inputs.coconut.massWetKg - result.recommended.requiredCoconutWetKg, 1)}
                unit="kg wet"
              />
              <MetricTile
                label="Reserve margin held"
                value={fmt(inputs.reservePct, 0)}
                unit="%"
              />
            </div>
          </>
        )}

        {!feasible && (
          <>
            <h2 className="font-display mt-5 text-2xl sm:text-3xl font-medium text-[#2B2A1F]">
              Full target is not reachable from current inventory
            </h2>
            <p className="mt-1 text-sm text-[#6B6A54]">
              No blend can cover {fmt(inputs.loadKw, 2)} kW for {fmt(inputs.runtimeHours, 1)}{" "}
              hours within the {fmt(inputs.reservePct, 0)}% reserve. Here is the best the
              current stock can support instead.
            </p>

            {result.fallback ? (
              <>
                <div className="mt-6">
                  <BlendBar xCoconut={result.fallback.xCoconut} />
                </div>

                <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <MetricTile
                    label="Max supported runtime"
                    value={fmt(result.fallback.maxRuntimeHours, 2)}
                    unit="hrs"
                  />
                  <MetricTile
                    label="Max supported energy"
                    value={fmt(result.fallback.maxElectricMj / 3.6, 2)}
                    unit="kWh"
                  />
                  <MetricTile
                    label="Rice husk used"
                    value={fmt(result.fallback.riceWetUsed, 1)}
                    unit="kg wet"
                  />
                  <MetricTile
                    label="Coconut shell used"
                    value={fmt(result.fallback.coconutWetUsed, 1)}
                    unit="kg wet"
                  />
                </div>

                <div className="mt-6 rounded-lg border border-[#EAD2A8] bg-[#FCF2DD] p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-[#8A5A17]">
                    <Info size={15} /> Suggested adjustments
                  </div>
                  <ul className="mt-2 space-y-1.5 text-sm text-[#6B5734]">
                    <li>
                      • Lower the target runtime to about{" "}
                      <span className="font-mono">{fmt(result.fallback.maxRuntimeHours, 1)} h</span>{" "}
                      to stay inside current inventory.
                    </li>
                    <li>
                      • {result.fallback.limitingFactor} is the binding constraint — sourcing
                      more of it raises the achievable runtime fastest.
                    </li>
                    <li>
                      • Reducing the reserve margin below {fmt(inputs.reservePct, 0)}% would free
                      up more usable stock, at the cost of a thinner operating buffer.
                    </li>
                  </ul>
                </div>
              </>
            ) : (
              <p className="mt-6 text-sm text-[#95591A]">
                No blend at any ratio produces usable net energy — moisture content is too
                high relative to available dry mass. Reduce moisture or add drier feedstock
                before re-running the plan.
              </p>
            )}
          </>
        )}

        <div className="mt-7 flex justify-end">
          <button
            onClick={onSeeAnalysis}
            className="inline-flex items-center gap-2 rounded-lg border border-[#3A3826]/20 px-4 py-2 text-sm font-medium text-[#3A3826] transition-colors hover:bg-[#EDE7CC]"
          >
            Why this blend?
            <ArrowRight size={15} />
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================================
   STEP 3 — ANALYSIS
   ============================================================================ */

function PillarCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[#3A3826]">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#5C6B47]/15 text-[#4A5738]">
          {icon}
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-[#6B6A54]">{children}</p>
    </Card>
  );
}

function AnalysisStep({ result, inputs }: { result: OptimizationResult; inputs: PlannerInputs }) {
  const targetX = result.recommended?.xCoconut ?? result.fallback?.xCoconut ?? null;

  // Standard step checkpoints
  let displayFractions = [0, 0.25, 0.5, 0.75, 1.0];

  // Dynamically inject the target blend if it falls between standard steps
  if (targetX !== null && !displayFractions.some(x => Math.abs(x - targetX) < 1e-4)) {
    displayFractions.push(targetX);
    displayFractions.sort((a, b) => a - b);
  }

  const rows = displayFractions.map((x) => {
    return result.candidates.reduce((closest, c) =>
      Math.abs(c.xCoconut - x) < Math.abs(closest.xCoconut - x) ? c : closest
    );
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <PillarCard icon={<Zap size={16} />} title="Energy density">
          Blend LHV rises from {fmt(RICE_LHV_DRY, 2)} MJ/kg (rice husk) to{" "}
          {fmt(COCONUT_LHV_DRY, 2)} MJ/kg (coconut shell). Higher coconut share reaches the
          target load with less dry mass, but only if enough coconut shell is on hand.
        </PillarCard>
        <PillarCard icon={<Sprout size={16} />} title="Inventory match">
          Every candidate is checked against usable stock — total supply minus the{" "}
          {fmt(inputs.reservePct, 0)}% reserve — so the plan never proposes drawing either
          feedstock below its operating buffer.
        </PillarCard>
        <PillarCard icon={<Droplet size={16} />} title="Moisture impact">
          Wet mass beyond the dry basis has to be evaporated before it burns, at{" "}
          {fmt(H_VAP, 2)} MJ per kg of water. That penalty is subtracted from LHV before any
          yield is credited to the blend.
        </PillarCard>
      </div>

      <Card className="p-5 sm:p-6">
        <SectionLabel icon={<ClipboardList size={16} />}>Candidate blends evaluated</SectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#8A886E]">
                <th className="pb-2 font-medium">Blend</th>
                <th className="pb-2 font-medium">Net LHV</th>
                <th className="pb-2 font-medium">Wet biomass required</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const isRecommended = targetX !== null && Math.abs(c.xCoconut - targetX) < 1e-6;
                return (
                  <tr
                    key={c.xCoconut}
                    className={`border-t border-[#EAE3C8] ${
                      isRecommended ? "bg-[#5C6B47]/10" : ""
                    }`}
                  >
                    <td className="py-2.5 font-mono">
                      {fmt(c.xCoconut * 100, 0)}% coconut / {fmt((1 - c.xCoconut) * 100, 0)}%
                      rice
                      {isRecommended && (
                        <span className="ml-2 rounded-full bg-[#5C6B47] px-2 py-0.5 text-[10px] font-sans text-white">
                          recommended
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 font-mono text-[#6B6A54]">
                      {c.moistureBlocked ? "≤ 0" : `${fmt(c.netLhv, 2)} MJ/kg`}
                    </td>
                    <td className="py-2.5 font-mono text-[#6B6A54]">
                      {isFinite(c.requiredTotalWetKg) ? `${fmt(c.requiredTotalWetKg, 1)} kg` : "—"}
                    </td>
                    <td className="py-2.5">
                      {c.moistureBlocked ? (
                        <span className="text-[#95591A]">Blocked by moisture</span>
                      ) : c.feasible ? (
                        <span className="inline-flex items-center gap-1 text-[#3F5A2E]">
                          <CheckCircle2 size={13} /> Feasible
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[#95591A]">
                          <AlertTriangle size={13} /> Exceeds inventory
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================================
   STEP 4 — MODEL ASSUMPTIONS
   ============================================================================ */

function AssumptionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[#EAE3C8] py-2.5 text-sm">
      <span className="text-[#6B6A54]">{label}</span>
      <span className="font-mono text-[#2B2A1F]">{value}</span>
    </div>
  );
}

function AssumptionsStep({ reservePct }: { reservePct: number }) {
  return (
    <div className="space-y-5">
      <Card className="p-5 sm:p-6">
        <SectionLabel icon={<Gauge size={16} />}>Active model assumptions</SectionLabel>
        <div>
          <AssumptionRow label="Rice husk dry LHV" value={`${fmt(RICE_LHV_DRY, 2)} MJ/kg`} />
          <AssumptionRow
            label="Coconut shell dry LHV"
            value={`${fmt(COCONUT_LHV_DRY, 2)} MJ/kg`}
          />
          <AssumptionRow label="Rice husk CGE proxy" value={fmt(RICE_CGE, 2)} />
          <AssumptionRow label="Coconut shell CGE proxy" value={fmt(COCONUT_CGE, 2)} />
          <AssumptionRow label="Genset efficiency" value={pct(GENSET_EFFICIENCY, 0)} />
          <AssumptionRow
            label="Latent heat of evaporation"
            value={`${fmt(H_VAP, 2)} MJ/kg water`}
          />
          <AssumptionRow label="Reserve fraction (current)" value={pct(reservePct / 100, 0)} />
          <AssumptionRow label="Moisture penalty applied" value="Yes" />
          <AssumptionRow label="Candidate blend resolution" value="5% steps, 0–100%" />
        </div>
      </Card>

      <Card className="border-[#EAD2A8] bg-[#FCF2DD] p-5 sm:p-6">
        <div className="flex items-start gap-2.5">
          <Info size={16} className="mt-0.5 shrink-0 text-[#8A5A17]" />
          <p className="text-[13px] leading-relaxed text-[#6B5734]">
            Prototype estimate based on literature baseline parameters. Experimental
            validation required before physical deployment.
          </p>
        </div>
      </Card>
    </div>
  );
}