import { useEffect, useMemo, useRef, useState } from "react";
import { createEngine, Engine } from "./engine";
import { GROUP_DEFS, LoadedGroup, loadGroup } from "./satellites";

// ---------- Helpers ----------

function fmtUTC(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
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
  const [loadingCount, setLoadingCount] = useState(GROUP_DEFS.length);
  const [panelOpen, setPanelOpen] = useState(() =>
    window.matchMedia("(min-width: 640px)").matches
  );

  const speed = useMemo(() => (reverse ? -1 : 1) * Math.pow(10, exp), [exp, reverse]);

  // Init engine + load data
  useEffect(() => {
    if (!containerRef.current) return;
    visibilityRef.current.clear();
    const engine = createEngine(containerRef.current, (t, f) => {
      setSimTime(t);
      setFps(f);
    });
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
    <div className="relative h-screen w-screen overflow-hidden bg-[#01020a] font-sans text-slate-200 select-none">
      {/* 3D canvas */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Top panels */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2 sm:inset-x-4 sm:top-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="pointer-events-auto w-full sm:max-w-xs">
          <div className="rounded-2xl border border-white/10 bg-black/50 px-5 py-4 shadow-2xl backdrop-blur-md">
            <h1 className="text-lg font-bold tracking-tight text-white">
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
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
              Satellite tracker with SGP4 propagation for live TLEs and clearly marked simulated
              fallbacks when a source is unavailable.
            </p>
            <div className="mt-3 flex items-center gap-3 text-xs">
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
        </div>

        {/* Constellation legend */}
        <div className="pointer-events-auto w-full sm:w-auto">
          <div className="rounded-2xl border border-white/10 bg-black/50 shadow-2xl backdrop-blur-md">
            <button
              onClick={() => setPanelOpen((o) => !o)}
              className="flex w-full items-center justify-between gap-8 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-300 hover:text-white"
            >
              Constellations
              <span className="text-slate-500">{panelOpen ? "▾" : "▸"}</span>
            </button>
            {panelOpen && (
              <div className="max-h-[calc(100vh-30rem)] overflow-y-auto px-2 pb-2 sm:max-h-[55vh]">
                {groups.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => toggleGroup(g.key)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-white/5 ${
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
      <div className="absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
        <div className="flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-white/10 bg-black/55 px-5 py-4 shadow-2xl backdrop-blur-md">
          {/* Clock + date controls */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-mono text-sm font-semibold tracking-tight text-sky-300">
              {fmtUTC(simTime)}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="datetime-local"
                value={dateInput}
                onFocus={() => setEditingDate(true)}
                onBlur={() => setEditingDate(false)}
                onChange={(e) => {
                  setDateInput(e.target.value);
                  applyDate(e.target.value);
                }}
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 outline-none [color-scheme:dark] focus:border-sky-500/60"
              />
              <button
                onClick={() => engineRef.current?.setTime(Date.now())}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/15"
              >
                Now
              </button>
            </div>
          </div>

          {/* Playback + speed */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setPaused((p) => !p)}
              className="grid h-9 w-9 place-items-center rounded-full bg-sky-500 text-sm text-white shadow-lg shadow-sky-500/30 transition hover:bg-sky-400"
              title={paused ? "Play" : "Pause"}
            >
              {paused ? "▶" : "⏸"}
            </button>
            <button
              onClick={() => setReverse((r) => !r)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                reverse
                  ? "border-rose-400/50 bg-rose-500/20 text-rose-300"
                  : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/15"
              }`}
              title="Reverse time"
            >
              {reverse ? "◀◀ rev" : "▶▶ fwd"}
            </button>

            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={exp}
              onChange={(e) => setExp(parseFloat(e.target.value))}
              className="h-1.5 min-w-[120px] flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-sky-400"
            />
            <span className="w-20 text-right font-mono text-xs font-semibold text-sky-300">
              {paused ? "paused" : fmtSpeed(speed)}
            </span>

            <div className="flex gap-1">
              {PRESETS.map((p) => (
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
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Hint */}
      <div className="pointer-events-none absolute bottom-28 left-1/2 z-0 -translate-x-1/2 text-[10px] text-slate-600">
        drag to rotate · scroll to zoom
      </div>
    </div>
  );
}
