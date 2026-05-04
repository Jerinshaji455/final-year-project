// src/DoctorPortalV2.jsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sun,
  Moon,
  Menu,
  X,
  Bell,
  User,
  Search,
  LogOut,
  Activity,
  Heart,
  BarChart2,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// --- ADDED: socket.io client ---
import { io } from "socket.io-client";

// helper: severity score by SpO2 (higher = worse)
const severityScore = (spo2) => {
  if (spo2 >= 95) return 0; // stable
  if (spo2 >= 90) return 1; // warning
  if (spo2 >= 85) return 2; // serious
  return 3; // critical
};

// initial 10 patients (seed)
const makeInitialPatients = () =>
  Array.from({ length: 10 }).map((_, i) => {
    const base = 95 - (i % 4);
    const now = new Date();
    // small history to show in chart
    const history = Array.from({ length: 8 }).map((__, idx) => {
      const t = new Date(now.getTime() - (7 - idx) * 1000 * 60 * 5); // 5-min step
      const spo2 = Math.max(80, Math.min(100, base + (Math.random() * 4 - 2)));
      const hr = Math.round(65 + Math.random() * 20);
      const bp = 110 + Math.round(Math.random() * 30);
      return { time: t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), spo2, hr, bp };
    });

    // --- ADDED: make patient 1 be Jerin Shaji with id PT-1000 (real device) ---
    if (i === 0) {
      return {
        id: `PT-1000`,
        name: `Jerin Shaji`,
        age: 28,
        ward: "General",
        notes: "",
        history,
        vitals: history[history.length - 1],
        avatarColor: ["bg-indigo-500", "bg-rose-500", "bg-emerald-500", "bg-sky-500"][i % 4],
      };
    }

    return {
      id: `PT-${1000 + i}`,
      name: `Patient ${i + 1}`,
      age: 28 + ((i * 7) % 25),
      ward: "General",
      notes: "",
      history,
      vitals: history[history.length - 1],
      avatarColor: ["bg-indigo-500", "bg-rose-500", "bg-emerald-500", "bg-sky-500"][i % 4],
    };
  });

// utility: persist patients meta (notes/ward) separately
const STORAGE_KEY = "dp_v2_patients_meta_v1";

export default function DoctorPortalV2() {
  const [patients, setPatients] = useState(() => {
    const seeded = makeInitialPatients();
    // hydrate metadata if present
    try {
      const meta = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return seeded.map((p) => ({ ...p, ...meta[p.id] }));
    } catch {
      return seeded;
    }
  });

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all"); // all, stable, warning, critical
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dark, setDark] = useState(() => {
    const s = localStorage.getItem("dp_v2_theme");
    return s ? s === "dark" : false;
  });
  const [selected, setSelected] = useState(null); // patient for modal
  const [autoPlay, setAutoPlay] = useState(true);
  const updateRef = useRef(null);

  // --- ADDED: socket reference and config ---
  const socketRef = useRef(null);
  const BRIDGE_URL = "http://localhost:4000"; // <-- change to your bridge host if remote

  // persist theme
  useEffect(() => localStorage.setItem("dp_v2_theme", dark ? "dark" : "light"), [dark]);

  // --- ADDED: connect to socket.io and REST snapshot ---
  useEffect(() => {
    // connect
    const socket = io(BRIDGE_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Connected to bridge (socket.io):", socket.id);
    });

    socket.on("vitals", (payload) => {
      // payload: { patient_id, patient_name, spo2, hr, ts, received_at }
      setPatients((prev) => {
        // update matching patient by id
        const updated = prev.map((p) => {
          if (p.id === payload.patient_id) {
            // create new vitals point
            const newPoint = {
              time: new Date(payload.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              spo2: payload.spo2 === null || payload.spo2 === -1 ? p.vitals.spo2 : payload.spo2,
              hr: payload.hr || p.vitals.hr,
              bp: p.vitals.bp || 120,
              updatedAt: payload.received_at,
            };
            const history = [...(p.history || []), newPoint].slice(-16);
            return { ...p, vitals: newPoint, history };
          }
          return p;
        });

        // if incoming patient not in list, add it
        if (!updated.some((p) => p.id === payload.patient_id)) {
          const newP = {
            id: payload.patient_id,
            name: payload.patient_name || payload.patient_id,
            age: 30,
            ward: "General",
            notes: "",
            history: [
              {
                time: new Date(payload.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
                spo2: payload.spo2,
                hr: payload.hr,
                bp: 120,
                updatedAt: payload.received_at,
              },
            ],
            vitals: {
              time: new Date(payload.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              spo2: payload.spo2,
              hr: payload.hr,
              bp: 120,
              updatedAt: payload.received_at,
            },
            avatarColor: "bg-indigo-500",
          };
          updated.unshift(newP);
        }

        // sort by severity
        updated.sort((a, b) => severityScore(b.vitals.spo2) - severityScore(a.vitals.spo2) || a.id.localeCompare(b.id));
        return updated;
      });
    });

    // optional: on mount fetch latest snapshot from bridge DB
    fetch(`${BRIDGE_URL}/api/patients`)
      .then((r) => r.json())
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        setPatients((prev) => {
          const map = new Map(prev.map(p => [p.id, p]));
          rows.forEach(r => {
            const id = r.patient_id;
            const entry = map.get(id);
            const newPoint = {
              time: new Date(r.received_at || r.ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              spo2: r.spo2,
              hr: r.hr,
              bp: entry?.vitals?.bp || 120,
              updatedAt: r.received_at || r.ts,
            };
            const history = entry ? [...(entry.history || []), newPoint].slice(-16) : [newPoint];
            const newPatient = {
              id,
              name: r.patient_name || (entry && entry.name) || id,
              age: entry?.age || 30,
              ward: entry?.ward || "General",
              notes: entry?.notes || "",
              history,
              vitals: newPoint,
              avatarColor: entry?.avatarColor || "bg-indigo-500",
            };
            map.set(id, newPatient);
          });
          return Array.from(map.values()).sort((a,b) => severityScore(b.vitals.spo2) - severityScore(a.vitals.spo2));
        });
      })
      .catch(() => { /* ignore */ });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Simulate real-time vitals generator (replace this function to use real data)
  const simulateVitalsUpdate = (prev) => {
    return prev.map((p) => {
      // --- IMPORTANT: don't overwrite the real device (PT-1000) with simulated values ---
      if (p.id === "PT-1000") return p;

      // random walk on last spo2
      const prevSpo2 = p.vitals?.spo2 ?? 97;
      const delta = Math.round((Math.random() - 0.65) * 4); // a tiny bias to drop sometimes
      let nextSpo2 = prevSpo2 + delta;
      nextSpo2 = Math.max(60, Math.min(100, nextSpo2));
      const nextHr = Math.max(45, Math.min(140, Math.round((p.vitals?.hr || 70) + (Math.random() * 6 - 3))));
      const nextBp = Math.max(80, Math.min(200, Math.round((p.vitals?.bp || 120) + (Math.random() * 6 - 3))));
      const newPoint = {
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        spo2: nextSpo2,
        hr: nextHr,
        bp: nextBp,
      };
      const history = [...(p.history || []), newPoint].slice(-16); // keep last 16 points
      return { ...p, vitals: newPoint, history };
    });
  };

  // start / stop auto updates
  useEffect(() => {
    if (!autoPlay) {
      if (updateRef.current) clearInterval(updateRef.current);
      updateRef.current = null;
      return;
    }
    // initial tick immediately
    setPatients((prev) => {
      const updated = simulateVitalsUpdate(prev);
      // sort by severity descending (critical first)
      updated.sort((a, b) => severityScore(b.vitals.spo2) - severityScore(a.vitals.spo2) || a.id.localeCompare(b.id));
      return updated;
    });
    // then periodic
    updateRef.current = setInterval(() => {
      setPatients((prev) => {
        const updated = simulateVitalsUpdate(prev);
        updated.sort((a, b) => severityScore(b.vitals.spo2) - severityScore(a.vitals.spo2) || a.id.localeCompare(b.id));
        return updated;
      });
    }, 2500); // every 2.5s
    return () => clearInterval(updateRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay]);

  // persist notes/ward meta
  useEffect(() => {
    const meta = Object.fromEntries(patients.map((p) => [p.id, { notes: p.notes, ward: p.ward }]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  }, [patients]);

  // derived filters + search
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return patients.filter((p) => {
      if (filter === "stable" && severityScore(p.vitals.spo2) !== 0) return false;
      if (filter === "warning" && severityScore(p.vitals.spo2) !== 1) return false;
      if (filter === "serious" && severityScore(p.vitals.spo2) !== 2) return false;
      if (filter === "critical" && severityScore(p.vitals.spo2) !== 3) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.ward || "").toLowerCase().includes(q) ||
        (p.notes || "").toLowerCase().includes(q)
      );
    });
  }, [patients, query, filter]);

  // update patient meta (notes / ward)
  function updateMeta(id, patch) {
    setPatients((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  // small helpers for UI
  const criticalCount = useMemo(() => patients.filter((p) => severityScore(p.vitals.spo2) >= 2).length, [patients]);

  // theme class (Tailwind requires adding 'dark' on an ancestor element)
  const rootClasses = dark ? "dark" : "";

  return (
    <div className={`${rootClasses}`}>
      <div className="min-h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors">
        <div className="max-w-7xl mx-auto p-4 lg:p-6">
          <div className="grid grid-cols-12 gap-6">
            {/* Sidebar */}
            <aside
              className={`col-span-12 md:col-span-3 lg:col-span-2 ${sidebarOpen ? "" : "hidden md:block"}`}
              aria-label="Sidebar"
            >
              <div className="bg-white/80 dark:bg-slate-800/70 backdrop-blur rounded-2xl p-4 shadow-sm sticky top-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-400 p-3 text-white">
                    <Activity size={18} />
                  </div>
                  <div>
                    <h1 className="text-lg font-semibold">ClinicFlow</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Doctor dashboard</p>
                  </div>
                </div>

                <nav className="mt-6 space-y-1" aria-label="Main navigation">
                  <button
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    onClick={() => setSidebarOpen((s) => !s)}
                    aria-expanded={sidebarOpen}
                  >
                    {sidebarOpen ? <span>Collapse Sidebar</span> : <span>Open Sidebar</span>}
                  </button>

                  <div className="mt-4 space-y-2">
                    <button
                      className="flex items-center gap-2 w-full px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700"
                      onClick={() => {
                        setFilter("all");
                        setQuery("");
                      }}
                    >
                      <BarChart2 size={16} />
                      Dashboard
                    </button>
                    <button
                      className="flex items-center gap-2 w-full px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700"
                      onClick={() => document.getElementById("patients")?.scrollIntoView({ behavior: "smooth" })}
                    >
                      <User size={16} />
                      Patients
                    </button>
                  </div>
                </nav>

                <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-700">
                  <button
                    onClick={() => {
                      localStorage.clear();
                      window.location.reload();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700"
                  >
                    <LogOut size={16} />
                    <span className="text-sm">Reset demo</span>
                  </button>
                </div>
              </div>
            </aside>

            {/* Main content */}
            <main className="col-span-12 md:col-span-9 lg:col-span-10">
              <div className="flex items-center justify-between mb-6 gap-4">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setSidebarOpen((s) => !s)}
                    className="p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 focus:ring-2 focus:ring-indigo-500"
                    aria-label="Toggle sidebar"
                  >
                    {sidebarOpen ? <Menu size={18} /> : <X size={18} />}
                  </button>

                  <div>
                    <h2 className="text-2xl font-semibold">Good evening, Dr. Raghu CV</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Real-time SpO₂ monitoring</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="pl-10 pr-4 py-2 rounded-lg bg-white dark:bg-slate-800 shadow-sm border dark:border-slate-700 focus:ring-2 focus:ring-indigo-500"
                      placeholder="Search patients, ID, ward or notes"
                      aria-label="Search patients"
                    />
                    <div className="absolute left-3 top-2.5 text-slate-400 dark:text-slate-300">
                      <Search size={16} />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAutoPlay((s) => !s)}
                      className="p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 focus:ring-2 focus:ring-indigo-500"
                      aria-pressed={!autoPlay ? "false" : "true"}
                      title={autoPlay ? "Pause live updates" : "Resume live updates"}
                    >
                      <Bell size={18} />
                    </button>

                    <button
                      onClick={() => setDark((d) => !d)}
                      className="p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 focus:ring-2 focus:ring-indigo-500"
                      aria-pressed={dark}
                    >
                      {dark ? <Sun size={18} /> : <Moon size={18} />}
                    </button>

                    <div className="flex items-center gap-2 pl-3 border-l border-slate-100 dark:border-slate-700">
                      <div className="text-sm text-slate-500 dark:text-slate-400 text-right">
                        <div className="font-medium">Dr. Arjun Patel</div>
                        <div className="text-xs">MBBS, MD</div>
                      </div>
                      <div className={`h-10 w-10 rounded-full flex items-center justify-center text-white ${patients[0].avatarColor}`}>
                        AP
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* small cards */}
              <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
                  <h3 className="text-sm text-slate-500 dark:text-slate-400">Today's Appointments</h3>
                  <p className="text-2xl font-semibold">—</p>
                </div>
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
                  <h3 className="text-sm text-slate-500 dark:text-slate-400">Active Patients</h3>
                  <p className="text-2xl font-semibold">{patients.length}</p>
                </div>
                <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm">
                  <h3 className="text-sm text-slate-500 dark:text-slate-400">Patients Needing Attention</h3>
                  <p className="text-2xl font-semibold text-rose-500">{criticalCount}</p>
                </div>
              </section>

              {/* Controls: filters */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                {["all", "stable", "warning", "serious", "critical"].map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-full text-sm ${filter === f ? "bg-indigo-600 text-white" : "bg-white dark:bg-slate-800"}`}
                  >
                    {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>

              {/* Patients list */}
              <section id="patients" className="grid grid-cols-1 gap-3">
                <AnimatePresence>
                  {filtered.map((p) => {
                    const level = severityScore(p.vitals.spo2);
                    const isCritical = level >= 2;
                    const bg =
                      level === 3
                        ? "bg-rose-50 dark:bg-rose-900/40"
                        : level === 2
                        ? "bg-amber-50 dark:bg-amber-900/35"
                        : "bg-emerald-50 dark:bg-emerald-900/30";

                    return (
                      <motion.article
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        key={p.id}
                        className={`rounded-2xl p-3 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${bg}`}
                        tabIndex={0}
                        role="button"
                        aria-pressed="false"
                      >
                        <div className="flex items-center gap-3 w-full sm:w-auto">
                          <div className={`h-12 w-12 rounded-full flex items-center justify-center text-white ${p.avatarColor} shrink-0`}>
                            {p.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                          </div>
                          <div>
                            <div className="font-semibold">{p.name} <span className="text-xs text-slate-400 dark:text-slate-300">· {p.id}</span></div>
                            <div className="text-sm text-slate-500 dark:text-slate-400">{p.ward} · Age {p.age}</div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 w-full sm:w-auto justify-between">
                          <div className="text-right">
                            <div className={`text-xl font-semibold ${level >= 3 ? "text-rose-600" : level === 2 ? "text-amber-600" : "text-emerald-600"}`}>
                              {Math.round(p.vitals.spo2)}%
                            </div>
                            <div className="text-xs text-slate-400 dark:text-slate-300">{p.vitals.time || new Date().toLocaleTimeString()}</div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setSelected(p)}
                              className="px-3 py-1 rounded-lg border bg-white/60 dark:bg-slate-800/60"
                              aria-label={`Open ${p.name}`}
                            >
                              View
                            </button>

                            <input
                              className="hidden sm:inline-block text-sm p-2 border rounded-md"
                              placeholder="Add note"
                              value={p.notes || ""}
                              onChange={(e) => updateMeta(p.id, { notes: e.target.value })}
                              aria-label={`Note for ${p.name}`}
                            />

                            <select
                              className="text-sm p-2 border rounded-md"
                              value={p.ward}
                              onChange={(e) => updateMeta(p.id, { ward: e.target.value })}
                              aria-label={`Ward for ${p.name}`}
                            >
                              <option>General</option>
                              <option>ICU</option>
                              <option>Isolation</option>
                              <option>Emergency</option>
                            </select>
                          </div>
                        </div>
                      </motion.article>
                    );
                  })}
                </AnimatePresence>
              </section>

              <footer className="mt-6 text-sm text-slate-500 dark:text-slate-400">PHI demo — secure real backends & encryption required for production.</footer>
            </main>
          </div>
        </div>

        {/* Modal: selected patient */}
        <AnimatePresence>
          {selected && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/40" onClick={() => setSelected(null)} />

              <motion.div
                layout
                initial={{ y: 30, scale: 0.98 }}
                animate={{ y: 0, scale: 1 }}
                exit={{ y: 20, scale: 0.98 }}
                className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-4xl p-6 z-10"
                role="dialog"
                aria-modal="true"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className={`h-12 w-12 rounded-full flex items-center justify-center text-white ${selected.avatarColor}`}>{selected.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}</div>
                    <div>
                      <h3 className="text-lg font-semibold">{selected.name} <span className="text-sm text-slate-400 dark:text-slate-300">· {selected.id}</span></h3>
                      <div className="text-sm text-slate-500 dark:text-slate-400">{selected.ward} • Age {selected.age}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button onClick={() => setSelected(null)} className="text-sm text-slate-500">Close</button>
                    <button onClick={() => {
                      // copy a quick note to clipboard
                      navigator.clipboard?.writeText(`${selected.name} ${selected.id} - SPO2 ${selected.vitals.spo2}%`) 
                        .then(()=>alert("Copied to clipboard"))
                        .catch(()=>{})
                    }} className="px-3 py-1 rounded-lg border">Copy</button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2 space-y-4">
                    <div className="bg-slate-50 dark:bg-slate-900/60 p-4 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-semibold">Vitals (Live)</h4>
                        <div className="text-sm text-slate-500 dark:text-slate-400">Updated: {new Date(selected.vitals.time ? selected.vitals.time : selected.vitals.updatedAt || Date.now()).toLocaleTimeString()}</div>
                      </div>

                      <div style={{ height: 260 }} className="rounded-md overflow-hidden">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={selected.history}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="time" />
                            <YAxis yAxisId="left" domain={[60, 100]} />
                            <Tooltip />
                            <Line yAxisId="left" type="monotone" dataKey="spo2" stroke="#2563eb" strokeWidth={2} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="bg-white dark:bg-slate-800 p-4 rounded-lg">
                      <h4 className="font-semibold mb-2">Actions</h4>
                      <div className="flex gap-2 flex-wrap">
                        <button className="px-3 py-2 rounded-lg border">Create Prescription</button>
                        <button className="px-3 py-2 rounded-lg border">Order Labs</button>
                        <button className="px-3 py-2 rounded-lg border">Refer</button>
                        <button className="px-3 py-2 rounded-lg bg-indigo-600 text-white">Start Televisit</button>
                      </div>
                    </div>
                  </div>

                  <aside className="space-y-4">
                    <div className="bg-white dark:bg-slate-800 p-4 rounded-lg">
                      <h4 className="font-semibold">Snapshot</h4>
                      <ul className="mt-2 text-sm space-y-2 text-slate-600 dark:text-slate-300">
                        <li>SpO₂: <span className="font-medium">{Math.round(selected.vitals.spo2)}%</span></li>
                        <li>HR: <span className="font-medium">{selected.vitals.hr} bpm</span></li>
                        <li>BP: <span className="font-medium">{selected.vitals.bp} mmHg</span></li>
                        <li>Ward: <span className="font-medium">{selected.ward}</span></li>
                      </ul>
                    </div>

                    <div className="bg-white dark:bg-slate-800 p-4 rounded-lg">
                      <h4 className="font-semibold mb-2">Notes</h4>
                      <textarea
                        className="w-full p-2 border rounded-md bg-transparent text-sm"
                        rows={4}
                        value={selected.notes || ""}
                        onChange={(e) => updateMeta(selected.id, { notes: e.target.value })}
                      />
                    </div>
                  </aside>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
