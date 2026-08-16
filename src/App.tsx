import { useEffect, useMemo, useRef, useState } from "react";
import { createEngine, Engine, SatSelection } from "./engine";
import { GROUP_DEFS, LoadedGroup, loadGroup } from "./satellites";

// ---------- Helpers ----------

function fmtUTC(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtValue(v: number, digits: number, unit: string): string {
  return isNaN(v)
    ? "—"
    : `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${unit}`;
}

function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function fmtSpeed(x: number): string {
  const a = Math.abs(x);
  if (a >= 86400) return `${(x / 86400).toFixed(1)} d/s`;
  if (a >= 3600) return `${(x / 3600).toFixed(1)} h/s`;
  if (a >= 60) return `${(x / 60).toFixed(1)} min/s`;
  return `${x.toFixed(x < 10 ? 1 : 0)}×`;
}

const PRESETS = [
  { label: "1×", exp: 0 },
  { label: "60×", exp: Math.log10(60) },
  { label: "10 min/s", exp: Math.log10(600) },
  { label: "1 h/s", exp: Math.log10(3600) },
  { label: "1 d/s", exp: Math.log10(86400) },
];

const GROUP_ORDER = new Map(GROUP_DEFS.map((group, index) => [group.key, index]));

interface GroupView {
  key: string;
  label: string;
  color: string;
  count: number;
  live: boolean;
  visible: boolean;
}

// ---------- App ----------

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const groupsRef = useRef<LoadedGroup[]>([]);
  const visibilityRef = useRef(new Map<string, boolean>());

  const [simTime, setSimTime] = useState(Date.now());
  const [fps, setFps] = useState(60);
  const [paused, setPaused] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [exp, setExp] = useState(0); // log10 of speed multiplier
  const [dateInput, setDateInput] = useState(toLocalInputValue(Date.now()));
  const [editingDate, setEditingDate] = useState(false);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [selection, setSelection] = useState<SatSelection | null>(null);
  const [loadingCount, setLoadingCount] = useState(GROUP_DEFS.length);
  const [panelOpen, setPanelOpen] = useState(() =>
    window.matchMedia("(min-width: 640px)").matches
  );
  const [playerOpen, setPlayerOpen] = useState(false); // mobile: expand time controls

  const speed = useMemo(() => (reverse ? -1 : 1) * Math.pow(10, exp), [exp, reverse]);

  // Init engine + load data
  useEffect(() => {
    if (!containerRef.current) return;
    visibilityRef.current.clear();
    const engine = createEngine(
      containerRef.current,
      (t, f) => {
        setSimTime(t);
        setFps(f);
      },
      setSelection
    );
    engineRef.current = engine;
    engine.setSpeed(1);

    let cancelled = false;
    GROUP_DEFS.forEach((def) => {
      loadGroup(def).then((g) => {
        if (cancelled) return;
        groupsRef.current = [...groupsRef.current, g].sort(
          (a, b) => (GROUP_ORDER.get(a.key) ?? 0) - (GROUP_ORDER.get(b.key) ?? 0)
        );
        engine.setGroups(groupsRef.current);
        const nextGroups = groupsRef.current.map((x) => ({
          key: x.key,
          label: x.label,
          color: x.color,
          count: x.sats.length,
          live: x.live,
          visible: visibilityRef.current.get(x.key) ?? true,
        }));
        nextGroups.forEach((group) => {
          if (!group.visible) engine.setGroupVisible(group.key, false);
        });
        setGroups(nextGroups);
        setLoadingCount((c) => c - 1);
      });
    });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
      groupsRef.current = [];
      visibilityRef.current.clear();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    if (!editingDate) setDateInput(toLocalInputValue(simTime));
  }, [simTime, editingDate]);

  const totalSats = groups.reduce((a, g) => a + g.count, 0);
  const liveGroupCount = groups.filter((g) => g.live).length;
  const simulatedGroupCount = groups.length - liveGroupCount;
  const dataMode =
    loadingCount > 0
      ? "loading"
      : liveGroupCount === groups.length
        ? "live"
        : liveGroupCount === 0
          ? "offline"
          : "mixed";

  const presetButtons = PRESETS.map((p) => (
    <button
      key={p.label}
      onClick={() => setExp(p.exp)}
      className={`rounded-md px-2 py-1 text-[10px] font-semibold transition ${
        Math.abs(exp - p.exp) < 0.01
          ? "bg-sky-500 text-white"
          : "bg-white/5 text-slate-400 hover:bg-white/15 hover:text-white"
      }`}
    >
      {p.label}
    </button>
  ));

  const applyDate = (value: string) => {
    const ms = new Date(value).getTime();
    if (!isNaN(ms)) engineRef.current?.setTime(ms);
  };

  const toggleGroup = (key: string) => {
    setGroups((gs) =>
      gs.map((g) => {
        if (g.key !== key) return g;
        const visible = !g.visible;
        visibilityRef.current.set(key, visible);
        engineRef.current?.setGroupVisible(key, visible);
        return { ...g, visible };
      })
    );
  };

  return (
    <div className="relative h-[var(--app-height)] w-screen overflow-hidden bg-[#01020a] font-sans text-slate-200 select-none">
      {/* 3D canvas */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Top panels */}
      <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-col gap-2 sm:inset-x-4 sm:top-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="pointer-events-auto w-full sm:max-w-xs">
          <div className="rounded-2xl border border-white/10 bg-black/50 px-3 py-2 shadow-2xl backdrop-blur-md sm:px-5 sm:py-4">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-white sm:text-lg">
                🌍 Earth Orbit{" "}
                <span
                  className={
                    dataMode === "live"
                      ? "text-emerald-400"
                      : dataMode === "offline"
                        ? "text-slate-400"
                        : dataMode === "mixed"
                          ? "text-amber-400"
                          : "text-sky-400"
                  }
                >
                  {dataMode === "live"
                    ? "Live"
                    : dataMode === "offline"
                      ? "Offline"
                      : dataMode === "mixed"
                        ? "Mixed"
                        : "Loading"}
                </span>
              </h1>
              <span className="ml-auto rounded-md bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300 sm:hidden">
                {totalSats.toLocaleString()}
              </span>
            </div>
            <p className="mt-0.5 hidden text-[11px] leading-snug text-slate-400 sm:block">
              Satellite tracker with SGP4 propagation for live TLEs and clearly marked simulated
              fallbacks when a source is unavailable.
            </p>
            <div className="mt-3 hidden items-center gap-3 text-xs sm:flex">
              <span className="rounded-md bg-sky-500/15 px-2 py-1 font-mono font-semibold text-sky-300">
                {totalSats.toLocaleString()} sats
              </span>
              {loadingCount > 0 ? (
                <span className="flex items-center gap-1.5 text-amber-300">
                  <span className="h-2 w-2 animate-ping rounded-full bg-amber-400" />
                  loading {loadingCount}…
                </span>
              ) : (
                <span className={dataMode === "live" ? "text-emerald-400" : "text-amber-400"}>
                  {dataMode === "live"
                    ? "● all groups use live TLEs"
                    : dataMode === "offline"
                      ? "● all groups simulated (offline)"
                      : `● mixed · ${liveGroupCount} live / ${simulatedGroupCount} simulated`}
                </span>
              )}
              <span className="ml-auto font-mono text-slate-500">{fps.toFixed(0)} fps</span>
            </div>
          </div>

          {selection && (
            <div className="mt-2 rounded-2xl border border-white/10 bg-black/50 px-3 py-2 shadow-2xl backdrop-blur-md sm:px-5 sm:py-3.5">
              <div className="flex items-center gap-2 sm:justify-between sm:gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: selection.color,
                      boxShadow: `0 0 6px ${selection.color}`,
                    }}
                  />
                  <span
                    className="truncate text-xs font-bold text-white sm:text-sm"
                    title={selection.name}
                  >
                    {selection.name}
                  </span>
                </div>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-sky-300 sm:hidden">
                  {fmtValue(selection.altitudeKm, 0, "km")} ·{" "}
                  {fmtValue(selection.velocityKmS, 2, "km/s")}
                </span>
                <button
                  onClick={() => engineRef.current?.clearSelection()}
                  title="Deselect (Esc)"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/10 bg-white/5 text-[11px] text-slate-400 transition hover:bg-white/15 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <p className="mt-0.5 hidden pl-[18px] text-[11px] text-slate-400 sm:block">
                {selection.label}
              </p>
              <div className="mt-2 hidden flex-wrap gap-x-5 gap-y-1 pl-[18px] text-xs text-slate-400 sm:flex">
                <span>
                  alt{" "}
                  <b className="font-mono font-semibold text-sky-300">
                    {fmtValue(selection.altitudeKm, 0, "km")}
                  </b>
                </span>
                <span>
                  vel{" "}
                  <b className="font-mono font-semibold text-sky-300">
                    {fmtValue(selection.velocityKmS, 2, "km/s")}
                  </b>
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Constellation legend */}
        <div className="pointer-events-auto w-full sm:w-auto">
          <div className="rounded-2xl border border-white/10 bg-black/50 shadow-2xl backdrop-blur-md">
            <button
              onClick={() => setPanelOpen((o) => !o)}
              className="flex w-full items-center justify-between gap-8 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-300 hover:text-white sm:px-4 sm:py-2.5 sm:text-xs"
            >
              Constellations
              <span className="text-slate-500">{panelOpen ? "▾" : "▸"}</span>
            </button>
            {panelOpen && (
              <div className="max-h-[calc(var(--app-height)-20rem)] overflow-y-auto px-2 pb-2 sm:max-h-[55vh]">
                {groups.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => toggleGroup(g.key)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-xs transition hover:bg-white/5 sm:py-1.5 ${
                      g.visible ? "" : "opacity-35"
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: g.color, boxShadow: `0 0 6px ${g.color}` }}
                    />
                    <span className="flex-1 text-slate-200">{g.label}</span>
                    {!g.live && (
                      <span title="simulated" className="text-[9px] text-amber-400">
                        sim
                      </span>
                    )}
                    <span className="font-mono text-slate-400">{g.count.toLocaleString()}</span>
                  </button>
                ))}
                {groups.length === 0 && (
                  <p className="px-3 pb-2 text-xs text-slate-500">Fetching orbital data…</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom control bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-2 pb-[env(safe-area-inset-bottom)] sm:bottom-4 sm:px-4 sm:pb-0">
        <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-black/60 shadow-2xl backdrop-blur-md">
          {/* Time details — always visible on desktop, toggled on mobile */}
          <div
            className={`${
              playerOpen ? "flex" : "hidden"
            } flex-col gap-2.5 border-b border-white/10 px-4 pb-3 pt-3 sm:flex sm:border-b-0 sm:px-5 sm:pb-0 sm:pt-3.5`}
          >
            <div className="flex items-center gap-2 text-xs">
              <div className="truncate font-mono font-semibold tracking-tight text-sky-300">
                {fmtUTC(simTime)}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <input
                  type="datetime-local"
                  value={dateInput}
                  onFocus={() => setEditingDate(true)}
                  onBlur={() => setEditingDate(false)}
                  onChange={(e) => {
                    setDateInput(e.target.value);
                    applyDate(e.target.value);
                  }}
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 outline-none [color-scheme:dark] focus:border-sky-500/60"
                />
                <button
                  onClick={() => engineRef.current?.setTime(Date.now())}
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-200 transition hover:bg-white/15"
                >
                  Now
                </button>
              </div>
            </div>
            {/* Speed presets — mobile only (desktop shows them inline below) */}
            <div className="flex gap-1 sm:hidden">{presetButtons}</div>
          </div>

          {/* Main row — the only row visible on a collapsed phone */}
          <div className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-5 sm:py-3">
            <button
              onClick={() => setPaused((p) => !p)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sky-500 text-sm text-white shadow-lg shadow-sky-500/30 transition hover:bg-sky-400"
              title={paused ? "Play" : "Pause"}
            >
              {paused ? "▶" : "⏸"}
            </button>
            <button
              onClick={() => setReverse((r) => !r)}
              className={`shrink-0 rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
                reverse
                  ? "border-rose-400/50 bg-rose-500/20 text-rose-300"
                  : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/15"
              }`}
              title="Reverse time"
            >
              ◀◀
            </button>

            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={exp}
              onChange={(e) => setExp(parseFloat(e.target.value))}
              className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-sky-400"
            />
            <span className="w-14 shrink-0 text-right font-mono text-xs font-semibold text-sky-300 sm:w-20">
              {paused ? "paused" : fmtSpeed(speed)}
            </span>

            <div className="hidden shrink-0 gap-1 sm:flex">{presetButtons}</div>

            <button
              onClick={() => setPlayerOpen((o) => !o)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-[10px] text-slate-400 transition hover:bg-white/15 hover:text-white sm:hidden"
              title={playerOpen ? "Hide time controls" : "Show clock, date, and presets"}
              aria-expanded={playerOpen}
            >
              {playerOpen ? "▾" : "▴"}
            </button>
          </div>
        </div>
      </div>

      {/* Hint */}
      <div className="pointer-events-none absolute bottom-20 left-1/2 z-0 hidden -translate-x-1/2 text-[10px] text-slate-600 sm:block">
        drag to rotate · scroll to zoom · click a satellite for details
      </div>
    </div>
  );
}
