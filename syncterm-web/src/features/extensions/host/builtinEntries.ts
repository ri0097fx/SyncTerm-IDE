const entries: Record<string, string> = {
  "builtin:devtools.json-lab": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const seeds = [
    '{"name":"sync","enabled":true,"items":[3,1,2]}',
    '{"api":"v1","ok":true,"user":{"id":12,"name":"ishibashi"}}',
    '{"tasks":[{"id":1,"done":false},{"id":2,"done":true}],"meta":{"total":2}}'
  ];
  let sample = String(api.storage.get("sample") || seeds[0]);
  let slot = Number(api.storage.get("slot") || 1);
  let history = api.storage.get("history");
  if (!Array.isArray(history)) history = [];
  function persist() {
    api.storage.set("sample", sample);
    api.storage.set("slot", slot);
    api.storage.set("history", history.slice(-8));
  }
  function compact(v) {
    return String(v || "").replace(/\\s+/g, " ").slice(0, 96);
  }
  function render(note) {
    let parsed = null;
    let err = "";
    try { parsed = JSON.parse(sample); } catch (e) { err = String((e && e.message) || e || "parse error"); }
    const byteSize = sample.length;
    api.updatePanelState(panelId, {
      markdown: "## JSON Lab Pro",
      stats: {
        slot: slot,
        bytes: byteSize,
        valid: err ? "no" : "yes",
        history: history.length
      },
      items: [
        note || "Format / Minify / Validate / Slot management",
        err ? ("Validation: " + err) : "Validation: OK",
        "Current JSON:",
        sample,
        "History:",
      ].concat(history.length ? history.slice(-5).map(function(v, i){ return String(i + 1) + ". " + compact(v); }) : ["(empty)"]),
      actions: [
        { label: "Load Slot 1", command: manifest.id + ".load", args: [1] },
        { label: "Load Slot 2", command: manifest.id + ".load", args: [2] },
        { label: "Load Slot 3", command: manifest.id + ".load", args: [3] },
        { label: "Format JSON", command: manifest.id + ".format" },
        { label: "Minify JSON", command: manifest.id + ".minify" },
        { label: "Sort Keys", command: manifest.id + ".sort" },
        { label: "Validate", command: manifest.id + ".validate" },
        { label: "Use API Payload", command: manifest.id + ".setSeed", args: [2] },
        { label: "Use Tasks Payload", command: manifest.id + ".setSeed", args: [3] }
      ]
    });
    persist();
  }
  api.registerPanel({ id: panelId, title: "JSON Lab" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open JSON Lab" }, function() {
    render("Current sample:");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".format", title: "Format JSON Sample" }, function() {
    try {
      history.push(sample);
      sample = JSON.stringify(JSON.parse(sample), null, 2);
    } catch (e) {}
    render("Formatted.");
    return { openPanelId: panelId, message: "JSON formatted." };
  });
  api.registerCommand({ command: manifest.id + ".minify", title: "Minify JSON Sample" }, function() {
    try {
      history.push(sample);
      sample = JSON.stringify(JSON.parse(sample));
    } catch (e) {}
    render("Minified.");
    return { openPanelId: panelId, message: "JSON minified." };
  });
  api.registerCommand({ command: manifest.id + ".sort", title: "Sort JSON keys" }, function() {
    try {
      history.push(sample);
      function deepSort(v) {
        if (Array.isArray(v)) return v.map(deepSort);
        if (v && typeof v === "object") {
          const out = {};
          Object.keys(v).sort().forEach(function(k){ out[k] = deepSort(v[k]); });
          return out;
        }
        return v;
      }
      sample = JSON.stringify(deepSort(JSON.parse(sample)), null, 2);
      render("Sorted keys.");
    } catch (e) {
      render("Sort failed.");
    }
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".validate", title: "Validate JSON sample" }, function() {
    render("Validated.");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setSeed", title: "Load sample payload" }, function(idx) {
    const n = Math.max(1, Math.min(3, Number(idx) || 1));
    slot = n;
    sample = seeds[n - 1];
    render("Loaded payload slot " + n + ".");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".load", title: "Load payload slot" }, function(idx) {
    const n = Math.max(1, Math.min(3, Number(idx) || 1));
    slot = n;
    sample = seeds[n - 1];
    render("Loaded slot " + n + ".");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setText", title: "Set JSON input text" }, function(text) {
    sample = String(text || "");
    render("Input updated.");
    return { openPanelId: panelId };
  });
  render("Ready.");
}
`,
  "builtin:devtools.regex-lab": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const dataset = [
    "alpha_123","beta-test","gamma42","delta","ERR_502_TIMEOUT","ticket-391","deploy@2026-04-16",
    "user:ishibashi","branch/feature-toggle","staging_ok"
  ];
  let pattern = "^[a-z]+";
  let flags = "i";
  let targetText = dataset.join("\\n");
  function run() {
    let out = [];
    let groupLine = "";
    try {
      const re = new RegExp(pattern, flags);
      const rows = targetText.split("\\n").filter(function(v){ return v.trim() !== ""; });
      out = rows.filter(function(x){ return re.test(x); });
      const first = rows.find(function(x){ return re.test(x); });
      if (first) {
        const m = first.match(re);
        if (m) groupLine = "First match groups: " + JSON.stringify(m);
      }
    } catch (e) {
      out = ["Regex Error: " + e.message];
    }
    api.updatePanelState(panelId, {
      markdown: "## Regex Lab Pro",
      stats: { pattern: pattern, flags: flags, lines: targetText.split("\\n").length, matches: out.length },
      items: [
        "Pattern: /" + pattern + "/" + flags,
        "Target text:",
        targetText
      ].concat(groupLine ? [groupLine] : []).concat(["Matches:"]).concat(out.length ? out : ["(no matches)"]),
      actions: [
        { label: "Use Pattern ^[a-z]+", command: manifest.id + ".set1" },
        { label: "Use Pattern \\\\d+", command: manifest.id + ".set2" },
        { label: "Use Pattern ERR_[0-9]+", command: manifest.id + ".set3" },
        { label: "Toggle i-flag", command: manifest.id + ".flag", args: ["i"] },
        { label: "Toggle g-flag", command: manifest.id + ".flag", args: ["g"] },
        { label: "Use Dataset", command: manifest.id + ".dataset" },
        { label: "Use Logs", command: manifest.id + ".logs" },
        { label: "Run", command: manifest.id + ".run" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Regex Lab" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Regex Lab" }, function() { run(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".set1", title: "Regex preset letters" }, function() { pattern = "^[a-z]+"; run(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".set2", title: "Regex preset digits" }, function() { pattern = "\\\\d+"; run(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".set3", title: "Regex preset ERR code" }, function() { pattern = "ERR_[0-9]+"; run(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".flag", title: "Toggle regex flag" }, function(f) {
    const fl = String(f || "").toLowerCase();
    if (!fl) { run(); return { openPanelId: panelId }; }
    if (flags.indexOf(fl) >= 0) flags = flags.replace(new RegExp(fl, "g"), "");
    else flags += fl;
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".dataset", title: "Use default dataset" }, function() {
    targetText = dataset.join("\\n");
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".logs", title: "Use log style sample text" }, function() {
    targetText = "2026-04-16 INFO deploy ok\\n2026-04-16 WARN retry=2\\n2026-04-16 ERROR code=502\\nERR_502_TIMEOUT";
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setPattern", title: "Set regex pattern" }, function(p) {
    pattern = String(p || "");
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setFlags", title: "Set regex flags" }, function(f) {
    flags = String(f || "").replace(/[^gimsuyd]/g, "");
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setTarget", title: "Set regex target text" }, function(t) {
    targetText = String(t || "");
    run();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".run", title: "Run regex test" }, function() { run(); return { openPanelId: panelId }; });
  run();
}
`,
  "builtin:devtools.diff-notes": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let notes = api.storage.get("notes");
  if (!Array.isArray(notes)) notes = [];
  let query = String(api.storage.get("query") || "");
  function save(){ api.storage.set("notes", notes); api.storage.set("query", query); }
  function render() {
    const q = query.trim().toLowerCase();
    const rows = q ? notes.filter(function(n){ return String(n.text || "").toLowerCase().indexOf(q) >= 0; }) : notes;
    api.updatePanelState(panelId, {
      markdown: "## Diff Notes Pro",
      stats: {
        total: notes.length,
        open: notes.filter(function(n){ return !n.done; }).length,
        high: notes.filter(function(n){ return n.priority === "high"; }).length
      },
      items: rows.length
        ? rows.map(function(n, idx){ return (n.done ? "[x] " : "[ ] ") + "(" + n.priority + ") " + n.text + " #" + (idx + 1); })
        : ["No notes yet."],
      actions: [
        { label: "Add high: API changed", command: manifest.id + ".add", args: ["API changed", "high"] },
        { label: "Add medium: UI touched", command: manifest.id + ".add", args: ["UI touched", "medium"] },
        { label: "Toggle #1", command: manifest.id + ".toggle", args: [0] },
        { label: "Toggle #2", command: manifest.id + ".toggle", args: [1] },
        { label: "Search: API", command: manifest.id + ".search", args: ["api"] },
        { label: "Search: reset", command: manifest.id + ".search", args: [""] },
        { label: "Clear", command: manifest.id + ".clear" }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "Diff Notes" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Diff Notes" }, function() { render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add diff note" }, function(text, priority) {
    notes.push({ text: String(text || "note"), priority: String(priority || "low"), done: false, at: api.now() });
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".toggle", title: "Toggle note done" }, function(idx) {
    const i = Number(idx) || 0;
    if (notes[i]) notes[i].done = !notes[i].done;
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".search", title: "Search diff notes" }, function(q) { query = String(q || ""); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear diff notes" }, function() { notes = []; render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove note by index" }, function(idx) {
    const i = Number(idx) || 0;
    if (i >= 0 && i < notes.length) notes.splice(i, 1);
    render();
    return { openPanelId: panelId };
  });
  render();
}
`,
  "builtin:devtools.api-status": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let checks = api.storage.get("checks");
  if (!Array.isArray(checks)) {
    checks = [
      { name: "/health", ok: true, fail: 0, latency: 42, checkedAt: "-" },
      { name: "/api/extensions/catalog", ok: true, fail: 0, latency: 55, checkedAt: "-" },
      { name: "/watchers", ok: true, fail: 0, latency: 33, checkedAt: "-" }
    ];
  }
  function save(){ api.storage.set("checks", checks); }
  function refresh() {
    const now = new Date(api.now()).toLocaleTimeString();
    checks = checks.map(function(c){
      const ok = api.random(0, 1) > 0.15;
      const latency = Math.round(api.random(25, 220));
      return {
        name: c.name,
        ok: ok,
        fail: ok ? c.fail : c.fail + 1,
        latency: latency,
        checkedAt: now
      };
    });
    api.updatePanelState(panelId, {
      markdown: "## API Status Monitor Pro",
      stats: {
        up: checks.filter(function(c){ return !!c.ok; }).length + "/" + checks.length,
        checkedAt: now,
        source: "sandbox mock"
      },
      items: checks.map(function(c){ return (c.ok ? "OK " : "NG ") + c.name + " latency=" + c.latency + "ms fail=" + c.fail + " at " + c.checkedAt; }),
      actions: [
        { label: "Refresh", command: manifest.id + ".refresh" },
        { label: "Add endpoint /debug/rt", command: manifest.id + ".add", args: ["/debug/rt"] },
        { label: "Reset counters", command: manifest.id + ".reset" }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "API Status" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open API Status Monitor" }, function() { refresh(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".refresh", title: "Refresh API status snapshot" }, function() { refresh(); return { openPanelId: panelId, message: "Status refreshed." }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add endpoint to monitor" }, function(name) {
    const endpoint = String(name || "").trim();
    if (endpoint) checks.push({ name: endpoint, ok: true, fail: 0, latency: 0, checkedAt: "-" });
    refresh();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".reset", title: "Reset API monitor counters" }, function() {
    checks = checks.map(function(c){ return { name: c.name, ok: true, fail: 0, latency: c.latency, checkedAt: c.checkedAt }; });
    refresh();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove monitored endpoint" }, function(name) {
    const endpoint = String(name || "").trim();
    if (endpoint) checks = checks.filter(function(c){ return c.name !== endpoint; });
    refresh();
    return { openPanelId: panelId };
  });
  refresh();
}
`,
  "builtin:productivity.pomodoro": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let session = Number(api.storage.get("session") || 25);
  let count = Number(api.storage.get("count") || 0);
  let running = false;
  let remainingSec = Number(api.storage.get("remainingSec") || session * 60);
  let mode = String(api.storage.get("mode") || "focus");
  let timer = null;
  function save() {
    api.storage.set("session", session);
    api.storage.set("count", count);
    api.storage.set("running", running ? "1" : "0");
    api.storage.set("remainingSec", remainingSec);
    api.storage.set("mode", mode);
  }
  function ensureTimer() {
    if (timer != null) return;
    timer = setInterval(function(){
      if (!running) return;
      remainingSec = Math.max(0, remainingSec - 1);
      if (remainingSec <= 0) {
        running = false;
        if (mode === "focus") count += 1;
      }
      render("Tick");
    }, 1000);
  }
  function mmss(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function render() {
    api.updatePanelState(panelId, {
      markdown: "## Pomodoro Pro",
      stats: { mode: mode, minutes: session, completed: count, state: running ? "running" : "paused", remaining: mmss(remainingSec) },
      items: [
        "Timer: " + mmss(remainingSec),
        "Flow: focus 25/50 or break 5/15",
        "Completed sessions: " + count
      ],
      actions: [
        { label: running ? "Pause" : "Start", command: manifest.id + ".toggle" },
        { label: "Reset", command: manifest.id + ".reset" },
        { label: "Focus 25m", command: manifest.id + ".set", args: [25, "focus"] },
        { label: "Deep 50m", command: manifest.id + ".set", args: [50, "focus"] },
        { label: "Break 5m", command: manifest.id + ".set", args: [5, "break"] },
        { label: "Break 15m", command: manifest.id + ".set", args: [15, "break"] }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "Pomodoro" });
  ensureTimer();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Pomodoro" }, function() { render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".set", title: "Set pomodoro minutes" }, function(m, nextMode) {
    session = Math.max(1, Number(m) || 25);
    mode = String(nextMode || mode);
    remainingSec = session * 60;
    running = false;
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".toggle", title: "Toggle pomodoro run/pause" }, function() { running = !running; render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".reset", title: "Reset pomodoro timer" }, function() { running = false; remainingSec = session * 60; render(); return { openPanelId: panelId }; });
  render();
}
`,
  "builtin:productivity.kanban-lite": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let todo = api.storage.get("todo");
  let doing = api.storage.get("doing");
  let done = api.storage.get("done");
  if (!Array.isArray(todo)) todo = [{ id: "t1", title: "Write tests" }, { id: "t2", title: "Review PR" }];
  if (!Array.isArray(doing)) doing = [];
  if (!Array.isArray(done)) done = [];
  function save() { api.storage.set("todo", todo); api.storage.set("doing", doing); api.storage.set("done", done); }
  function titles(arr){ return arr.map(function(c){ return c.title; }); }
  function render() {
    const total = todo.length + doing.length + done.length;
    const doneRate = total ? Math.round((done.length / total) * 100) : 0;
    api.updatePanelState(panelId, {
      markdown: "## Kanban Pro",
      stats: { todo: todo.length, doing: doing.length, done: done.length, doneRate: doneRate + "%" },
      items: [
        "TODO: " + (titles(todo).join(", ") || "-"),
        "DOING: " + (titles(doing).join(", ") || "-"),
        "DONE: " + (titles(done).join(", ") || "-")
      ],
      actions: [
        { label: "Add: New Task", command: manifest.id + ".add", args: ["New Task"] },
        { label: "Start next", command: manifest.id + ".start" },
        { label: "Finish current", command: manifest.id + ".finish" },
        { label: "Back to TODO", command: manifest.id + ".back" },
        { label: "Clear Done", command: manifest.id + ".clearDone" }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "Kanban Lite" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Kanban Lite" }, function() { render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add kanban task" }, function(title) { todo.push({ id: "t" + api.now(), title: String(title || "Task") }); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".start", title: "Move TODO to DOING" }, function() { if (todo.length) doing.push(todo.shift()); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".finish", title: "Move DOING to DONE" }, function() { if (doing.length) done.push(doing.shift()); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".back", title: "Move DOING back to TODO" }, function() { if (doing.length) todo.push(doing.shift()); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".clearDone", title: "Clear done cards" }, function() { done = []; render(); return { openPanelId: panelId }; });
  render();
}
`,
  "builtin:productivity.scratchpad": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let docs = api.storage.get("docs");
  if (!Array.isArray(docs)) docs = [{ title: "default", tags: ["memo"], lines: ["idea: extension runtime"] }];
  let active = Number(api.storage.get("active") || 0);
  function current(){ if (!docs[active]) active = 0; return docs[active]; }
  function save() { api.storage.set("docs", docs); api.storage.set("active", active); }
  function render() {
    const cur = current();
    api.updatePanelState(panelId, {
      markdown: "## Scratchpad Pro",
      stats: { doc: cur.title, docs: docs.length, lines: cur.lines.length, tags: cur.tags.join(",") || "-" },
      items: cur.lines.length ? cur.lines : ["(empty)"],
      actions: [
        { label: "Append Timestamp", command: manifest.id + ".add" },
        { label: "Append TODO", command: manifest.id + ".append", args: ["TODO: "] },
        { label: "New Doc", command: manifest.id + ".newDoc", args: ["notes-" + new Date(api.now()).toLocaleDateString()] },
        { label: "Next Doc", command: manifest.id + ".nextDoc" },
        { label: "Tag:work", command: manifest.id + ".tag", args: ["work"] },
        { label: "Tag:idea", command: manifest.id + ".tag", args: ["idea"] },
        { label: "Add timestamp note", command: manifest.id + ".add" },
        { label: "Clear", command: manifest.id + ".clear" }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "Scratchpad" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Scratchpad" }, function() { render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add scratch note" }, function() { current().lines.push("note@" + new Date(api.now()).toLocaleTimeString()); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".append", title: "Append scratch line" }, function(text) { current().lines.push(String(text || "")); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".newDoc", title: "Create new scratch document" }, function(title) {
    docs.push({ title: String(title || ("doc-" + docs.length)), tags: [], lines: [] });
    active = docs.length - 1;
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".nextDoc", title: "Switch to next scratch document" }, function() {
    active = (active + 1) % docs.length;
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".tag", title: "Attach tag to scratch document" }, function(tag) {
    const t = String(tag || "").trim();
    if (t && current().tags.indexOf(t) < 0) current().tags.push(t);
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".setDocLines", title: "Replace current doc lines" }, function(text) {
    const lines = String(text || "").split("\\n");
    current().lines = lines;
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear scratchpad" }, function() { current().lines = []; render(); return { openPanelId: panelId }; });
  render();
}
`,
  "builtin:productivity.habit-tracker": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let score = Number(api.storage.get("score") || 0);
  let streak = Number(api.storage.get("streak") || 0);
  let best = Number(api.storage.get("best") || 0);
  let log = api.storage.get("log");
  if (!Array.isArray(log)) log = [];
  let lastDay = String(api.storage.get("lastDay") || "");
  function save(){
    api.storage.set("score", score);
    api.storage.set("streak", streak);
    api.storage.set("best", best);
    api.storage.set("log", log.slice(-14));
    api.storage.set("lastDay", lastDay);
  }
  function render() {
    const today = new Date(api.now()).toISOString().slice(0, 10);
    const doneToday = lastDay === today;
    api.updatePanelState(panelId, {
      markdown: "## Habit Tracker Pro",
      stats: { points: score, streak: streak, best: best, doneToday: doneToday ? "yes" : "no" },
      items: ["Recent:",].concat(log.length ? log.slice(-7).reverse() : ["(empty)"]),
      actions: [
        { label: "Done today +1", command: manifest.id + ".inc" },
        { label: "Weekly +7", command: manifest.id + ".inc", args: [7] },
        { label: "Reset", command: manifest.id + ".reset" }
      ]
    });
    save();
  }
  api.registerPanel({ id: panelId, title: "Habit Tracker" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Habit Tracker" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".inc", title: "Increase habit score" }, function(step){
    const now = new Date(api.now());
    const today = now.toISOString().slice(0, 10);
    const prev = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    score += Math.max(1, Number(step) || 1);
    if (lastDay === today) {
      // keep streak
    } else if (lastDay === prev) {
      streak += 1;
    } else {
      streak = 1;
    }
    if (streak > best) best = streak;
    lastDay = today;
    log.push(today + " +done");
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".reset", title: "Reset habit score" }, function(){ score = 0; streak = 0; log = []; lastDay = ""; render(); return { openPanelId: panelId }; });
  render();
}
`,
  "builtin:game.puzzle-2048-lite": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const size = 4;
  let board = new Array(size * size).fill(0);
  let prevBoard = board.slice();
  let score = Number(api.storage.get("score") || 0);
  let prevScore = score;
  let best = Number(api.storage.get("best") || 0);
  let moves = Number(api.storage.get("moves") || 0);
  let prevMoves = moves;
  let won = String(api.storage.get("won") || "0") === "1";
  let continued = String(api.storage.get("continued") || "0") === "1";

  function idx(x, y) { return y * size + x; }
  function get(x, y) { return board[idx(x, y)]; }
  function set(x, y, v) { board[idx(x, y)] = v; }
  function save() {
    api.storage.set("board", board.slice());
    api.storage.set("prevBoard", prevBoard.slice());
    api.storage.set("score", score);
    api.storage.set("prevScore", prevScore);
    api.storage.set("best", best);
    api.storage.set("moves", moves);
    api.storage.set("prevMoves", prevMoves);
    api.storage.set("won", won ? "1" : "0");
    api.storage.set("continued", continued ? "1" : "0");
  }
  function load() {
    const stored = api.storage.get("board");
    if (Array.isArray(stored) && stored.length === size * size) {
      board = stored.map(function(v){ return Number(v) || 0; });
    }
    const p = api.storage.get("prevBoard");
    if (Array.isArray(p) && p.length === size * size) prevBoard = p.map(function(v){ return Number(v) || 0; });
  }
  function randomInt(max) { return Math.floor(api.random(0, max)); }
  function emptyCells() {
    const out = [];
    for (let i = 0; i < board.length; i += 1) if (board[i] === 0) out.push(i);
    return out;
  }
  function spawn() {
    const empties = emptyCells();
    if (!empties.length) return false;
    const i = empties[randomInt(empties.length)];
    board[i] = api.random(0, 1) < 0.9 ? 2 : 4;
    return true;
  }
  function compress(line) {
    const arr = line.filter(function(v){ return v !== 0; });
    while (arr.length < size) arr.push(0);
    return arr;
  }
  function merge(line) {
    const arr = compress(line);
    let gained = 0;
    for (let i = 0; i < size - 1; i += 1) {
      if (arr[i] !== 0 && arr[i] === arr[i + 1]) {
        arr[i] = arr[i] * 2;
        arr[i + 1] = 0;
        gained += arr[i];
      }
    }
    return { line: compress(arr), gained: gained };
  }
  function move(dir) {
    let changed = false;
    let gainedTotal = 0;
    const beforeBoard = board.slice();
    const beforeScore = score;
    const beforeMoves = moves;
    for (let n = 0; n < size; n += 1) {
      let line = [];
      for (let i = 0; i < size; i += 1) {
        if (dir === "left") line.push(get(i, n));
        else if (dir === "right") line.push(get(size - 1 - i, n));
        else if (dir === "up") line.push(get(n, i));
        else line.push(get(n, size - 1 - i));
      }
      const merged = merge(line);
      gainedTotal += merged.gained;
      for (let i = 0; i < size; i += 1) {
        const v = merged.line[i];
        let x, y;
        if (dir === "left") { x = i; y = n; }
        else if (dir === "right") { x = size - 1 - i; y = n; }
        else if (dir === "up") { x = n; y = i; }
        else { x = n; y = size - 1 - i; }
        if (get(x, y) !== v) changed = true;
        set(x, y, v);
      }
    }
    if (changed) {
      prevBoard = beforeBoard;
      prevScore = beforeScore;
      prevMoves = beforeMoves;
      score += gainedTotal;
      moves += 1;
      if (score > best) best = score;
      spawn();
      if (!won && board.some(function(v){ return v >= 2048; })) {
        won = true;
        continued = false;
      }
      save();
    }
    return changed;
  }
  function canUndo() {
    if (!prevBoard || prevBoard.length !== size * size) return false;
    for (let k = 0; k < board.length; k += 1) if (board[k] !== prevBoard[k]) return true;
    return false;
  }
  function undo() {
    if (!canUndo()) return "Nothing to undo.";
    board = prevBoard.slice();
    score = prevScore;
    moves = prevMoves;
    return "Undid last move.";
  }
  function hasMoves() {
    if (emptyCells().length) return true;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const v = get(x, y);
        if (x + 1 < size && get(x + 1, y) === v) return true;
        if (y + 1 < size && get(x, y + 1) === v) return true;
      }
    }
    return false;
  }
  function encodeGridUi() {
    const rows = [];
    for (let y = 0; y < size; y += 1) {
      const row = [];
      for (let x = 0; x < size; x += 1) row.push(String(get(x, y)));
      rows.push(row.join("|"));
    }
    return rows.join("/");
  }
  function render(message) {
    api.updatePanelState(panelId, {
      markdown: "## 2048 Lite",
      stats: {
        score: score,
        best: best,
        moves: moves,
        status: won && !continued ? "won" : (hasMoves() ? "playing" : "game over"),
        won: won ? "yes" : "no",
        _grid2048: encodeGridUi()
      },
      items: [message || "Slide with direction buttons."],
      actions: [
        { label: "◀ Left", command: manifest.id + ".left" },
        { label: "▲ Up", command: manifest.id + ".up" },
        { label: "▼ Down", command: manifest.id + ".down" },
        { label: "▶ Right", command: manifest.id + ".right" },
        { label: "Undo", command: manifest.id + ".undo" },
        { label: "Continue", command: manifest.id + ".continue" },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  function newGame() {
    board = new Array(size * size).fill(0);
    score = 0;
    moves = 0;
    prevBoard = board.slice();
    prevScore = score;
    prevMoves = moves;
    won = false;
    continued = false;
    spawn();
    spawn();
    save();
  }
  load();
  if (!board.some(function(v){ return v > 0; })) newGame();
  api.registerPanel({ id: panelId, title: "2048 Lite" });
  render("Ready. Use arrow keys or panel buttons.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open 2048 Lite" }, function() { render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".left", title: "Move 2048 left" }, function() { const ok = move("left"); render(ok ? "Moved left." : "No change."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".right", title: "Move 2048 right" }, function() { const ok = move("right"); render(ok ? "Moved right." : "No change."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".up", title: "Move 2048 up" }, function() { const ok = move("up"); render(ok ? "Moved up." : "No change."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".down", title: "Move 2048 down" }, function() { const ok = move("down"); render(ok ? "Moved down." : "No change."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".undo", title: "Undo 2048 move" }, function() { const m = undo(); save(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".continue", title: "Continue after 2048" }, function() {
    if (!won) { render("No win yet."); return { openPanelId: panelId }; }
    continued = true;
    save();
    render("Continue mode enabled.");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".new", title: "New 2048 game" }, function() { newGame(); render("New game started."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.arcade-snake-lite": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const W = 12;
  const H = 12;
  let snake = [{x: 5, y: 6}, {x: 4, y: 6}, {x: 3, y: 6}];
  let dir = "R";
  let food = {x: 8, y: 6};
  let score = Number(api.storage.get("score") || 0);
  let best = Number(api.storage.get("best") || 0);
  let alive = true;
  let level = Number(api.storage.get("level") || 1);
  let lastAuto = api.now();
  let timer = null;

  function eq(a, b){ return a.x === b.x && a.y === b.y; }
  function randomCell() {
    for (let guard = 0; guard < 500; guard += 1) {
      const x = Math.floor(api.random(0, W));
      const y = Math.floor(api.random(0, H));
      const blocked = snake.some(function(s){ return s.x === x && s.y === y; });
      if (!blocked) return {x:x, y:y};
    }
    return {x: 0, y: 0};
  }
  function nextHead() {
    const head = snake[0];
    if (dir === "U") return {x: head.x, y: head.y - 1};
    if (dir === "D") return {x: head.x, y: head.y + 1};
    if (dir === "L") return {x: head.x - 1, y: head.y};
    return {x: head.x + 1, y: head.y};
  }
  function save() {
    api.storage.set("score", score);
    api.storage.set("best", best);
    api.storage.set("level", level);
  }
  function setDir(next) {
    const opposite = (dir === "U" && next === "D") || (dir === "D" && next === "U") || (dir === "L" && next === "R") || (dir === "R" && next === "L");
    if (!opposite) dir = next;
  }
  function step() {
    if (!alive) return "Game over.";
    const head = nextHead();
    if (head.x < 0 || head.y < 0 || head.x >= W || head.y >= H) {
      alive = false;
      return "Hit wall.";
    }
    const tail = snake[snake.length - 1];
    const willGrow = eq(head, food);
    if (snake.some(function(s, idx){
      if (!willGrow && idx === snake.length - 1) return false;
      return s.x === head.x && s.y === head.y;
    })) {
      alive = false;
      return "Hit yourself.";
    }
    snake.unshift(head);
    if (eq(head, food)) {
      score += 10;
      level = Math.min(15, 1 + Math.floor(score / 50));
      if (score > best) best = score;
      food = randomCell();
      save();
      return "Ate food!";
    }
    snake.pop();
    return "Moved.";
  }
  function encodeSnakeGrid() {
    const rows = [];
    for (let y = 0; y < H; y += 1) {
      let row = "";
      for (let x = 0; x < W; x += 1) {
        if (food.x === x && food.y === y) row += "1";
        else {
          const si = snake.findIndex(function(s){ return s.x === x && s.y === y; });
          if (si === 0) row += "2";
          else if (si > 0) row += "3";
          else row += "0";
        }
      }
      rows.push(row);
    }
    return rows.join("/");
  }
  function encodeNextHead() {
    if (!alive) return "-1,-1";
    const nh = nextHead();
    return nh.x + "," + nh.y;
  }
  function speedMs() { return Math.max(80, 380 - level * 18); }
  function autoStep() {
    if (!alive) return;
    const now = api.now();
    if (now - lastAuto < speedMs()) return;
    lastAuto = now;
    render(step());
  }
  function ensureTimer() {
    if (timer != null) return;
    timer = setInterval(autoStep, 60);
  }
  function render(msg) {
    api.updatePanelState(panelId, {
      markdown: "## Snake Lite",
      stats: {
        score: score,
        best: best,
        length: snake.length,
        level: level,
        speedMs: speedMs(),
        state: alive ? "alive" : "game over",
        _snake: encodeSnakeGrid(),
        _dir: dir,
        _nextHead: encodeNextHead()
      },
      items: [msg || "Auto-running snake. Use arrows to steer, Space for manual step."],
      actions: [
        { label: "▲", command: manifest.id + ".dir", args: ["U"] },
        { label: "◀", command: manifest.id + ".dir", args: ["L"] },
        { label: "▼", command: manifest.id + ".dir", args: ["D"] },
        { label: "▶", command: manifest.id + ".dir", args: ["R"] },
        { label: "Step", command: manifest.id + ".step" },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  function newGame() {
    snake = [{x: 5, y: 6}, {x: 4, y: 6}, {x: 3, y: 6}];
    dir = "R";
    food = randomCell();
    score = 0;
    level = 1;
    alive = true;
    lastAuto = api.now();
    save();
  }
  ensureTimer();
  render("Ready. Use arrow keys to steer.");
  api.registerPanel({ id: panelId, title: "Snake Lite" });
  api.registerCommand({ command: manifest.id + ".open", title: "Open Snake Lite" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".dir", title: "Set Snake direction" }, function(next){ setDir(String(next || "R")); render("Direction set."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".step", title: "Step Snake" }, function(){ const msg = step(); render(msg); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New Snake game" }, function(){ newGame(); render("New game started."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.board-othello-mini": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const N = 8;
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  let board = [];
  let turn = "B";
  let msg = "Black to move.";
  let mode = String(api.storage.get("mode") || "ai"); // ai | hotseat
  let aiLevel = String(api.storage.get("aiLevel") || "normal"); // easy | normal | hard
  let humanSide = String(api.storage.get("humanSide") || "B");
  if (humanSide !== "B" && humanSide !== "W") humanSide = "B";
  function HUMAN(){ return humanSide; }
  function AI(){ return humanSide === "B" ? "W" : "B"; }
  function finishMessage() {
    const sc = score();
    if (sc.black === sc.white) return "Game finished. Draw " + sc.black + "-" + sc.white + ".";
    return "Game finished. " + (sc.black > sc.white ? "Black" : "White") + " wins (" + sc.black + ":" + sc.white + ").";
  }
  function init() {
    board = [];
    for (let y = 0; y < N; y += 1) {
      const row = [];
      for (let x = 0; x < N; x += 1) row.push(".");
      board.push(row);
    }
    board[3][3] = "W"; board[3][4] = "B";
    board[4][3] = "B"; board[4][4] = "W";
    turn = "B";
    msg = "Black to move.";
  }
  function inRange(x, y){ return x >= 0 && y >= 0 && x < N && y < N; }
  function opponent(p){ return p === "B" ? "W" : "B"; }
  function cloneBoard(src) { return src.map(function(r){ return r.slice(); }); }
  function flipsForOn(srcBoard, x, y, p) {
    if (!inRange(x, y) || srcBoard[y][x] !== ".") return [];
    const opp = opponent(p);
    const total = [];
    for (let d = 0; d < dirs.length; d += 1) {
      const dx = dirs[d][0], dy = dirs[d][1];
      let cx = x + dx, cy = y + dy;
      const line = [];
      while (inRange(cx, cy) && srcBoard[cy][cx] === opp) {
        line.push([cx, cy]);
        cx += dx; cy += dy;
      }
      if (line.length && inRange(cx, cy) && srcBoard[cy][cx] === p) {
        for (let i = 0; i < line.length; i += 1) total.push(line[i]);
      }
    }
    return total;
  }
  function flipsFor(x, y, p) { return flipsForOn(board, x, y, p); }
  function validMovesOn(srcBoard, p) {
    const out = [];
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const flips = flipsForOn(srcBoard, x, y, p);
        if (flips.length) out.push({x:x, y:y, flips:flips});
      }
    }
    return out;
  }
  function validMoves(p) { return validMovesOn(board, p); }
  function applyMoveOn(srcBoard, x, y, p) {
    const flips = flipsForOn(srcBoard, x, y, p);
    if (!flips.length) return false;
    srcBoard[y][x] = p;
    for (let i = 0; i < flips.length; i += 1) {
      const fp = flips[i];
      srcBoard[fp[1]][fp[0]] = p;
    }
    return true;
  }
  function score() {
    let b = 0, w = 0;
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      if (board[y][x] === "B") b += 1;
      else if (board[y][x] === "W") w += 1;
    }
    return { black: b, white: w };
  }
  function cellName(x, y) { return String.fromCharCode(97 + x) + String(y + 1); }
  function encodeOthelloBoard() {
    let s = "";
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) s += board[y][x];
    return s;
  }
  function encodeLegalMoves(moves) {
    return moves.map(function(m){ return m.x + "," + m.y; }).join(";");
  }
  function positionalValue(x, y) {
    if ((x === 0 || x === N - 1) && (y === 0 || y === N - 1)) return 40;
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) return 7;
    if ((x === 1 || x === N - 2) && (y === 1 || y === N - 2)) return -9;
    return 1;
  }
  function evaluateBoard(srcBoard) {
    let s = 0;
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (srcBoard[y][x] === AI()) s += positionalValue(x, y);
        else if (srcBoard[y][x] === HUMAN()) s -= positionalValue(x, y);
      }
    }
    const aiMob = validMovesOn(srcBoard, AI()).length;
    const huMob = validMovesOn(srcBoard, HUMAN()).length;
    s += (aiMob - huMob) * 2;
    return s;
  }
  function chooseAiMove(moves) {
    if (!moves.length) return null;
    if (aiLevel === "easy") {
      return moves[Math.floor(api.random(0, moves.length))] || moves[0];
    }
    if (aiLevel === "normal") {
      let best = moves[0];
      let bestScore = -99999;
      for (let i = 0; i < moves.length; i += 1) {
        const mv = moves[i];
        const corner = ((mv.x === 0 || mv.x === N - 1) && (mv.y === 0 || mv.y === N - 1)) ? 60 : 0;
        const edge = (mv.x === 0 || mv.y === 0 || mv.x === N - 1 || mv.y === N - 1) ? 6 : 0;
        const s = mv.flips.length * 3 + corner + edge;
        if (s > bestScore) { best = mv; bestScore = s; }
      }
      return best;
    }
    // hard: shallow minimax
    function minimax(srcBoard, player, depth, alpha, beta) {
      const movesHere = validMovesOn(srcBoard, player);
      if (depth <= 0 || !movesHere.length) {
        const oppMoves = validMovesOn(srcBoard, opponent(player));
        if (!movesHere.length && !oppMoves.length) return evaluateBoard(srcBoard);
        if (!movesHere.length) return minimax(srcBoard, opponent(player), depth - 1, alpha, beta);
        return evaluateBoard(srcBoard);
      }
      if (player === AI()) {
        let v = -999999;
        for (let i = 0; i < movesHere.length; i += 1) {
          const mv = movesHere[i];
          const nb = cloneBoard(srcBoard);
          applyMoveOn(nb, mv.x, mv.y, player);
          const sc = minimax(nb, opponent(player), depth - 1, alpha, beta);
          if (sc > v) v = sc;
          if (v > alpha) alpha = v;
          if (beta <= alpha) break;
        }
        return v;
      }
      let v = 999999;
      for (let i = 0; i < movesHere.length; i += 1) {
        const mv = movesHere[i];
        const nb = cloneBoard(srcBoard);
        applyMoveOn(nb, mv.x, mv.y, player);
        const sc = minimax(nb, opponent(player), depth - 1, alpha, beta);
        if (sc < v) v = sc;
        if (v < beta) beta = v;
        if (beta <= alpha) break;
      }
      return v;
    }
    let best = moves[0];
    let bestScore = -999999;
    for (let i = 0; i < moves.length; i += 1) {
      const mv = moves[i];
      const nb = cloneBoard(board);
      applyMoveOn(nb, mv.x, mv.y, AI());
      const sc = minimax(nb, HUMAN(), 3, -999999, 999999);
      if (sc > bestScore) { best = mv; bestScore = sc; }
    }
    return best;
  }
  function advanceTurnWithPasses() {
    let hop = 0;
    while (hop < 3) {
      const moves = validMoves(turn);
      if (moves.length) return false;
      const opp = opponent(turn);
      const oppMoves = validMoves(opp);
      if (!oppMoves.length) {
        msg = finishMessage();
        return true;
      }
      turn = opp;
      msg = "No legal move. " + (turn === "B" ? "Black" : "White") + " to move.";
      hop += 1;
    }
    return false;
  }
  function maybeAiPlay() {
    if (mode !== "ai") return;
    let guard = 0;
    while (turn === AI() && guard < 4) {
      if (advanceTurnWithPasses()) return;
      if (turn !== AI()) return;
      const moves = validMoves(AI());
      if (!moves.length) return;
      const pick = chooseAiMove(moves);
      if (!pick) return;
      applyMoveOn(board, pick.x, pick.y, AI());
      turn = HUMAN();
      msg = "AI played " + cellName(pick.x, pick.y) + ".";
      if (advanceTurnWithPasses()) return;
      guard += 1;
    }
  }
  function nextAiLevel(cur) {
    if (cur === "easy") return "normal";
    if (cur === "normal") return "hard";
    return "easy";
  }
  function saveSettings() {
    api.storage.set("mode", mode);
    api.storage.set("aiLevel", aiLevel);
    api.storage.set("humanSide", humanSide);
  }
  function render() {
    const sc = score();
    const moves = validMoves(turn);
    const canHumanMove = mode === "hotseat" || turn === HUMAN();
    const actions = [
      { label: mode === "ai" ? "Mode: vsAI" : "Mode: 2P", command: manifest.id + ".mode" },
      { label: mode === "ai" ? ("You: " + (HUMAN() === "B" ? "Black" : "White")) : "Swap Color", command: manifest.id + ".side" },
      { label: "AI: " + aiLevel, command: manifest.id + ".aiLevel" },
      { label: "Pass", command: manifest.id + ".pass" },
      { label: "New Game", command: manifest.id + ".new" }
    ];
    for (let i = 0; i < Math.min(8, moves.length); i += 1) {
      const mv = moves[i];
      if (canHumanMove) actions.push({ label: "Move " + cellName(mv.x, mv.y), command: manifest.id + ".move", args: [mv.x, mv.y] });
    }
    api.updatePanelState(panelId, {
      markdown: "## Othello Mini",
      stats: {
        turn: turn,
        black: sc.black,
        white: sc.white,
        mode: mode,
        you: mode === "ai" ? (HUMAN() === "B" ? "black" : "white") : "both",
        aiLevel: aiLevel,
        legalMoves: moves.length,
        _othello: encodeOthelloBoard(),
        _legal: encodeLegalMoves(moves),
        _canHumanMove: canHumanMove ? "1" : "0"
      },
      items: [msg],
      actions: actions
    });
  }
  function applyMove(x, y) {
    if (mode === "ai" && turn !== HUMAN()) {
      msg = "Wait for AI turn.";
      return;
    }
    const flips = flipsFor(x, y, turn);
    if (!flips.length) {
      msg = "Invalid move.";
      return;
    }
    board[y][x] = turn;
    for (let i = 0; i < flips.length; i += 1) {
      const p = flips[i];
      board[p[1]][p[0]] = turn;
    }
    turn = opponent(turn);
    msg = "Move " + cellName(x, y) + " played.";
    if (!advanceTurnWithPasses()) maybeAiPlay();
  }
  init();
  saveSettings();
  api.registerPanel({ id: panelId, title: "Othello Mini" });
  maybeAiPlay();
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Othello Mini" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".move", title: "Play Othello move" }, function(x, y){ applyMove(Number(x), Number(y)); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".pass", title: "Pass turn in Othello" }, function(){
    if (mode === "ai" && turn !== HUMAN()) { msg = "Wait for AI turn."; render(); return { openPanelId: panelId }; }
    if (validMoves(turn).length) { msg = "Pass is allowed only when no legal moves."; render(); return { openPanelId: panelId }; }
    turn = opponent(turn);
    msg = "Turn passed.";
    if (!advanceTurnWithPasses()) maybeAiPlay();
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".side", title: "Swap Othello human side" }, function(){
    humanSide = humanSide === "B" ? "W" : "B";
    saveSettings();
    init();
    msg = "You are now " + (humanSide === "B" ? "Black." : "White.");
    if (mode === "ai" && turn === AI()) maybeAiPlay();
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".mode", title: "Toggle Othello mode (vsAI/2P)" }, function(){
    mode = mode === "ai" ? "hotseat" : "ai";
    saveSettings();
    msg = mode === "ai" ? "Mode changed: vs AI." : "Mode changed: 2 players.";
    if (mode === "ai" && turn === AI()) maybeAiPlay();
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".aiLevel", title: "Cycle Othello AI level" }, function(){
    aiLevel = nextAiLevel(aiLevel);
    saveSettings();
    msg = "AI level: " + aiLevel;
    if (mode === "ai" && turn === AI()) maybeAiPlay();
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".new", title: "New Othello game" }, function(){ init(); if (mode === "ai" && turn === AI()) maybeAiPlay(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:game.word-wordsprint": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const words = [
    "runtime","sandbox","widget","extension","compile","terminal","session","feature",
    "promise","closure","network","latency","storage","context","virtual","cluster",
    "monitor","process","parser","adapter","browser","command","payload","refactor"
  ];
  let score = Number(api.storage.get("score") || 0);
  let best = Number(api.storage.get("best") || 0);
  let lives = Number(api.storage.get("lives") || 3);
  let streak = Number(api.storage.get("streak") || 0);
  let answer = "runtime";
  let scrambled = "runtime";
  let options = [];
  let roundMs = Number(api.storage.get("roundMs") || 18000);
  let roundEndAt = api.now() + roundMs;
  let timer = null;
  function randomPick(arr){ return arr[Math.floor(api.random(0, arr.length))]; }
  function shuffle(str){
    const a = str.split("");
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(api.random(0, i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.join("");
  }
  function buildRound() {
    answer = randomPick(words);
    scrambled = shuffle(answer);
    if (scrambled === answer) scrambled = shuffle(answer);
    options = [answer];
    while (options.length < 3) {
      const cand = randomPick(words);
      if (!options.includes(cand)) options.push(cand);
    }
    options = options.sort(function(){ return api.random(0, 1) < 0.5 ? -1 : 1; });
    roundEndAt = api.now() + roundMs;
  }
  function save() {
    api.storage.set("score", score);
    api.storage.set("best", best);
    api.storage.set("lives", lives);
    api.storage.set("streak", streak);
    api.storage.set("roundMs", roundMs);
  }
  function timeLeftMs() { return Math.max(0, roundEndAt - api.now()); }
  function autoTick() {
    if (lives <= 0) return;
    if (timeLeftMs() > 0) return;
    lives -= 1;
    streak = 0;
    score = Math.max(0, score - 2);
    buildRound();
    save();
    render(lives <= 0 ? "Out of lives. New game?" : "Time up!");
  }
  function ensureTimer() {
    if (timer != null) return;
    timer = setInterval(autoTick, 120);
  }
  function render(note) {
    const actions = options.map(function(opt, idx){
      return { label: "Pick " + (idx + 1) + ": " + opt, command: manifest.id + ".pick", args: [opt] };
    });
    actions.push({ label: "Skip (-2)", command: manifest.id + ".skip" });
    actions.push({ label: "New Game", command: manifest.id + ".new" });
    api.updatePanelState(panelId, {
      markdown: "## Word Sprint",
      stats: {
        score: score,
        best: best,
        lives: lives,
        streak: streak,
        timeLeft: Math.ceil(timeLeftMs() / 1000) + "s",
        roundSec: Math.round(roundMs / 1000),
        _scramble: scrambled,
        _choices: options.join("|")
      },
      items: [note || "Unscramble the word."],
      actions: actions
    });
  }
  function applyPick(word) {
    if (lives <= 0) return "Game over. Start new game.";
    if (word === answer) {
      streak += 1;
      score += 5 + streak;
      if (score > best) best = score;
      buildRound();
      save();
      return "Correct!";
    }
    streak = 0;
    lives -= 1;
    score = Math.max(0, score - 3);
    if (lives <= 0) return "Out of lives. New game?";
    save();
    return "Wrong answer.";
  }
  function newGame() {
    score = 0;
    lives = 3;
    streak = 0;
    roundEndAt = api.now() + roundMs;
    buildRound();
    save();
  }
  buildRound();
  api.registerPanel({ id: panelId, title: "Word Sprint" });
  ensureTimer();
  render("Ready. Press 1/2/3 to answer.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Word Sprint" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".pick", title: "Pick Word Sprint answer" }, function(word){ const m = applyPick(String(word || "")); render(m); return { openPanelId: panelId, message: m }; });
  api.registerCommand({ command: manifest.id + ".skip", title: "Skip Word Sprint round" }, function(){ score = Math.max(0, score - 2); streak = 0; buildRound(); save(); render("Skipped."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".time", title: "Set Word Sprint round seconds" }, function(sec){
    roundMs = Math.max(8, Math.min(45, Number(sec) || 18)) * 1000;
    buildRound();
    save();
    render("Round time: " + Math.round(roundMs / 1000) + "s");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".new", title: "New Word Sprint game" }, function(){ newGame(); render("New game started."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.puzzle-tetris": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const W = 10;
  const H = 20;
  const pieceDefs = [
    { id: 1, name: "I", shape: [[1,1,1,1]] },
    { id: 2, name: "O", shape: [[1,1],[1,1]] },
    { id: 3, name: "T", shape: [[0,1,0],[1,1,1]] },
    { id: 4, name: "L", shape: [[0,0,1],[1,1,1]] },
    { id: 5, name: "J", shape: [[1,0,0],[1,1,1]] },
    { id: 6, name: "S", shape: [[0,1,1],[1,1,0]] },
    { id: 7, name: "Z", shape: [[1,1,0],[0,1,1]] }
  ];
  let board = [];
  let current = null;
  let bag = [];
  let queue = [];
  let holdPieceId = 0;
  let holdUsed = false;
  let x = 3;
  let y = 0;
  let score = Number(api.storage.get("score") || 0);
  let lines = Number(api.storage.get("lines") || 0);
  let best = Number(api.storage.get("best") || 0);
  let combo = 0;
  let b2b = false;
  let gameOver = false;
  let paused = false;
  let lastAutoMs = api.now();
  let timer = null;

  function dropIntervalMs() {
    const lv = Math.floor(lines / 10);
    return Math.max(120, 700 - lv * 60);
  }

  function newBoard() {
    board = [];
    for (let r = 0; r < H; r += 1) {
      const row = [];
      for (let c = 0; c < W; c += 1) row.push(0);
      board.push(row);
    }
  }
  function cloneShape(shape) {
    return shape.map(function(row){ return row.slice(); });
  }
  function getPieceDefById(id) {
    for (let i = 0; i < pieceDefs.length; i += 1) {
      if (pieceDefs[i].id === id) return pieceDefs[i];
    }
    return pieceDefs[0];
  }
  function clonePieceById(id) {
    const base = getPieceDefById(id);
    return { id: base.id, name: base.name, shape: cloneShape(base.shape) };
  }
  function clonePiece(piece) {
    return { id: piece.id, name: piece.name, shape: cloneShape(piece.shape) };
  }
  function refillBag() {
    bag = pieceDefs.map(function(p){ return p.id; });
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(api.random(0, i + 1));
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
  }
  function ensureQueue() {
    while (queue.length < 4) {
      if (!bag.length) refillBag();
      queue.push(bag.shift());
    }
  }
  function nextPiece() {
    ensureQueue();
    const id = queue.shift();
    ensureQueue();
    return clonePieceById(id);
  }
  function canPlace(px, py, shape) {
    for (let r = 0; r < shape.length; r += 1) {
      for (let c = 0; c < shape[r].length; c += 1) {
        if (!shape[r][c]) continue;
        const xx = px + c, yy = py + r;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) return false;
        if (board[yy][xx]) return false;
      }
    }
    return true;
  }
  function rotate(shape) {
    const h = shape.length, w = shape[0].length;
    const out = [];
    for (let c = 0; c < w; c += 1) {
      const row = [];
      for (let r = h - 1; r >= 0; r -= 1) row.push(shape[r][c]);
      out.push(row);
    }
    return out;
  }
  function lockPiece() {
    for (let r = 0; r < current.shape.length; r += 1) for (let c = 0; c < current.shape[r].length; c += 1) {
      if (!current.shape[r][c]) continue;
      board[y + r][x + c] = current.id;
    }
  }
  function clearLines() {
    let cleared = 0;
    for (let r = H - 1; r >= 0; r -= 1) {
      if (board[r].every(function(v){ return v > 0; })) {
        board.splice(r, 1);
        board.unshift(new Array(W).fill(0));
        cleared += 1;
        r += 1;
      }
    }
    if (cleared) {
      lines += cleared;
      const lv = Math.floor(lines / 10) + 1;
      const base = cleared === 1 ? 100 : (cleared === 2 ? 300 : (cleared === 3 ? 500 : 800));
      const wasB2b = b2b;
      b2b = cleared >= 4;
      combo += 1;
      score += base * lv + Math.max(0, combo - 1) * 40 + (wasB2b && b2b ? 120 : 0);
      if (score > best) best = score;
    } else {
      combo = 0;
      b2b = false;
    }
  }
  function spawn() {
    current = nextPiece();
    x = Math.floor((W - current.shape[0].length) / 2);
    y = 0;
    holdUsed = false;
    if (!canPlace(x, y, current.shape)) gameOver = true;
  }
  function save() {
    api.storage.set("score", score);
    api.storage.set("lines", lines);
    api.storage.set("best", best);
  }
  function tick() {
    if (gameOver) return "Game over.";
    if (paused) return "Paused.";
    if (canPlace(x, y + 1, current.shape)) {
      y += 1;
      return "Down one step.";
    }
    lockPiece();
    clearLines();
    spawn();
    save();
    return gameOver ? "Game over." : "Piece fixed.";
  }
  function move(dx) {
    if (gameOver) return "Game over.";
    if (canPlace(x + dx, y, current.shape)) { x += dx; return "Moved."; }
    return "Blocked.";
  }
  function drop() {
    if (gameOver) return "Game over.";
    while (canPlace(x, y + 1, current.shape)) y += 1;
    return tick();
  }
  function rotateNow() {
    if (gameOver) return "Game over.";
    const next = rotate(current.shape);
    if (canPlace(x, y, next)) { current.shape = next; return "Rotated."; }
    const kicks = [1, -1, 2, -2];
    for (let ki = 0; ki < kicks.length; ki += 1) {
      const kx = x + kicks[ki];
      if (canPlace(kx, y, next)) {
        x = kx;
        current.shape = next;
        return "Rotated (wall kick).";
      }
    }
    return "Cannot rotate.";
  }
  function holdNow() {
    if (gameOver) return "Game over.";
    if (holdUsed) return "Hold already used for this piece.";
    const curId = current.id;
    if (holdPieceId === 0) {
      holdPieceId = curId;
      current = nextPiece();
    } else {
      const swapId = holdPieceId;
      holdPieceId = curId;
      current = clonePieceById(swapId);
    }
    x = Math.floor((W - current.shape[0].length) / 2);
    y = 0;
    holdUsed = true;
    if (!canPlace(x, y, current.shape)) gameOver = true;
    return gameOver ? "Game over." : "Held.";
  }
  function emptyMatrix() {
    const m = [];
    for (let r = 0; r < H; r += 1) {
      const row = [];
      for (let c = 0; c < W; c += 1) row.push(0);
      m.push(row);
    }
    return m;
  }
  function encodeBoard(matrix) {
    return matrix.map(function(row){ return row.join(""); }).join("/");
  }
  function encodeLockedOnly() {
    return encodeBoard(board.map(function(row){ return row.slice(); }));
  }
  function encodeActivePieceOnly() {
    const z = emptyMatrix();
    if (!current || gameOver) return encodeBoard(z);
    for (let r = 0; r < current.shape.length; r += 1) {
      for (let c = 0; c < current.shape[r].length; c += 1) {
        if (!current.shape[r][c]) continue;
        const yy = y + r, xx = x + c;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W) z[yy][xx] = current.id;
      }
    }
    return encodeBoard(z);
  }
  function encodeGhostOnly() {
    const z = emptyMatrix();
    if (!current || gameOver || paused) return encodeBoard(z);
    let gy = y;
    while (canPlace(x, gy + 1, current.shape)) gy += 1;
    if (gy === y) return encodeBoard(z);
    for (let r = 0; r < current.shape.length; r += 1) {
      for (let c = 0; c < current.shape[r].length; c += 1) {
        if (!current.shape[r][c]) continue;
        const yy = gy + r, xx = x + c;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W && board[yy][xx] === 0) z[yy][xx] = current.id;
      }
    }
    return encodeBoard(z);
  }

  function autoStep() {
    if (gameOver || paused) return;
    const now = api.now();
    if (now - lastAutoMs < dropIntervalMs()) return;
    lastAutoMs = now;
    const m = tick();
    render(m);
  }

  function ensureTimer() {
    if (timer != null) return;
    timer = setInterval(autoStep, 80);
  }

  function render(message) {
    const nextNames = queue.slice(0, 4).map(function(id){ return getPieceDefById(id).name; }).join(" ");
    api.updatePanelState(panelId, {
      markdown: "## Tetris",
      stats: {
        score: score,
        lines: lines,
        best: best,
        level: Math.floor(lines / 10) + 1,
        state: gameOver ? "game over" : (paused ? "paused" : "playing"),
        speedMs: dropIntervalMs(),
        next: nextNames,
        hold: holdPieceId ? getPieceDefById(holdPieceId).name : "-",
        _locked: encodeLockedOnly(),
        _ghost: encodeGhostOnly(),
        _piece: encodeActivePieceOnly(),
        _nextIds: queue.slice(0, 4).join(","),
        _holdId: String(holdPieceId || 0),
        _holdUsed: holdUsed ? "1" : "0"
      },
      items: [
        message || "Classic falling blocks.",
        "Keys: ← → move / ↑ rotate / ↓ soft drop / Space hard drop / C hold / P pause / N new"
      ],
      actions: [
        { label: "◀", command: manifest.id + ".left" },
        { label: "▶", command: manifest.id + ".right" },
        { label: "⟳", command: manifest.id + ".rotate" },
        { label: "Hold", command: manifest.id + ".hold" },
        { label: "Pause/Resume", command: manifest.id + ".pause" },
        { label: "Tick", command: manifest.id + ".tick" },
        { label: "Drop", command: manifest.id + ".drop" },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  function newGame() {
    newBoard();
    bag = [];
    queue = [];
    holdPieceId = 0;
    holdUsed = false;
    score = 0;
    lines = 0;
    combo = 0;
    b2b = false;
    gameOver = false;
    paused = false;
    ensureQueue();
    spawn();
    lastAutoMs = api.now();
    save();
  }
  newGame();
  api.registerPanel({ id: panelId, title: "Tetris" });
  ensureTimer();
  render("Ready. Arrow keys + Space. Auto-fall enabled (7-bag).");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Tetris" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".left", title: "Move Tetris piece left" }, function(){ const m = move(-1); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".right", title: "Move Tetris piece right" }, function(){ const m = move(1); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".rotate", title: "Rotate Tetris piece" }, function(){ const m = rotateNow(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".hold", title: "Hold Tetris piece" }, function(){ const m = holdNow(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".tick", title: "Advance Tetris one tick" }, function(){ const m = tick(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".drop", title: "Hard drop Tetris piece" }, function(){ const m = drop(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".pause", title: "Pause or resume Tetris" }, function(){ paused = !paused; render(paused ? "Paused." : "Resumed."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New Tetris game" }, function(){ newGame(); render("New game started."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.puzzle-minesweeper": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const LEVELS = {
    beginner: { w: 9, h: 9, mines: 10 },
    intermediate: { w: 16, h: 16, mines: 40 },
    expert: { w: 30, h: 16, mines: 99 }
  };
  let level = String(api.storage.get("level") || "beginner");
  if (!LEVELS[level]) level = "beginner";
  let W = LEVELS[level].w;
  let H = LEVELS[level].h;
  let MINES = LEVELS[level].mines;
  let mines = [];
  let opened = [];
  let flagged = [];
  let cursor = {x: 0, y: 0};
  let over = false;
  let won = false;
  let minesPlaced = false;
  let startMs = api.now();
  let endMs = 0;
  let best = Number(api.storage.get("best." + level) || 0);
  function i(x, y){ return y * W + x; }
  function inRange(x, y){ return x >= 0 && y >= 0 && x < W && y < H; }
  function neighbors(x, y) {
    const out = [];
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (inRange(nx, ny)) out.push([nx, ny]);
    }
    return out;
  }
  function countAround(x, y) {
    return neighbors(x, y).filter(function(p){ return mines[i(p[0], p[1])]; }).length;
  }
  function randomize() {
    mines = new Array(W * H).fill(false);
    opened = new Array(W * H).fill(false);
    flagged = new Array(W * H).fill(false);
    over = false; won = false;
    minesPlaced = false;
    cursor = {x: 0, y: 0};
    startMs = api.now();
    endMs = 0;
  }
  function forbiddenFirstZone(sx, sy) {
    const set = {};
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = sx + dx, ny = sy + dy;
      if (inRange(nx, ny)) set[i(nx, ny)] = true;
    }
    return set;
  }
  function placeMinesFirstOpen(sx, sy) {
    function tryPlace(ban) {
      mines = new Array(W * H).fill(false);
      let n = 0;
      let guard = 0;
      while (n < MINES && guard < 2000) {
        guard += 1;
        const x = Math.floor(api.random(0, W));
        const y = Math.floor(api.random(0, H));
        const k = i(x, y);
        if (ban[k] || mines[k]) continue;
        mines[k] = true;
        n += 1;
      }
      return n === MINES && countAround(sx, sy) === 0;
    }
    let ban = forbiddenFirstZone(sx, sy);
    let ok = false;
    for (let attempts = 0; attempts < 120; attempts += 1) {
      if (tryPlace(ban)) { ok = true; break; }
    }
    if (!ok) {
      ban = {};
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const nx = sx + dx, ny = sy + dy;
        if (inRange(nx, ny)) ban[i(nx, ny)] = true;
      }
      for (let attempts = 0; attempts < 200; attempts += 1) {
        if (tryPlace(ban)) { ok = true; break; }
      }
    }
    if (!ok) {
      mines = new Array(W * H).fill(false);
      const ban3 = forbiddenFirstZone(sx, sy);
      let n = 0;
      let guard = 0;
      while (n < MINES && guard < 4000) {
        guard += 1;
        const x = Math.floor(api.random(0, W));
        const y = Math.floor(api.random(0, H));
        const k = i(x, y);
        if (ban3[k] || mines[k]) continue;
        mines[k] = true;
        n += 1;
      }
    }
    minesPlaced = true;
  }
  function setLevel(nextLevel) {
    const lk = LEVELS[nextLevel] ? nextLevel : "beginner";
    level = lk;
    W = LEVELS[level].w;
    H = LEVELS[level].h;
    MINES = LEVELS[level].mines;
    api.storage.set("level", level);
    best = Number(api.storage.get("best." + level) || 0);
    randomize();
  }
  function setCustom(w, h, minesCount) {
    W = Math.max(8, Math.min(40, Number(w) || 9));
    H = Math.max(8, Math.min(24, Number(h) || 9));
    const maxMines = Math.max(1, W * H - 10);
    MINES = Math.max(1, Math.min(maxMines, Number(minesCount) || 10));
    level = "custom";
    randomize();
  }
  function cycleLevel() {
    if (level === "beginner") return "intermediate";
    if (level === "intermediate") return "expert";
    return "beginner";
  }
  function flood(x, y) {
    const stack = [[x, y]];
    while (stack.length) {
      const p = stack.pop();
      const cx = p[0], cy = p[1], k = i(cx, cy);
      if (opened[k] || flagged[k]) continue;
      opened[k] = true;
      if (countAround(cx, cy) === 0) {
        neighbors(cx, cy).forEach(function(nn){ if (!opened[i(nn[0], nn[1])]) stack.push(nn); });
      }
    }
  }
  function expandAroundZeros() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const k = i(x, y);
          if (!opened[k] || mines[k]) continue;
          if (countAround(x, y) !== 0) continue;
          neighbors(x, y).forEach(function(nn) {
            const nk = i(nn[0], nn[1]);
            if (mines[nk] || opened[nk] || flagged[nk]) return;
            opened[nk] = true;
            changed = true;
          });
        }
      }
    }
  }
  function checkWin() {
    let openSafe = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const k = i(x, y);
      if (!mines[k] && opened[k]) openSafe += 1;
    }
    if (openSafe === W * H - MINES) {
      won = true;
      over = true;
      endMs = api.now();
      const elapsed = Math.max(1, Math.floor((endMs - startMs) / 1000));
      if (!best || elapsed < best) {
        best = elapsed;
        api.storage.set("best." + level, best);
      }
    }
  }
  function chordRevealAt(x, y) {
    const k = i(x, y);
    if (!opened[k] || mines[k]) return "Not an opened number cell.";
    const n = countAround(x, y);
    if (n <= 0) {
      expandAroundZeros();
      return "Expanded around zero.";
    }
    const around = neighbors(x, y);
    const flaggedCount = around.filter(function(p){ return flagged[i(p[0], p[1])]; }).length;
    if (flaggedCount < n) return "Not enough flags.";
    let openedNow = 0;
    for (let idx = 0; idx < around.length; idx += 1) {
      const p = around[idx];
      const nk = i(p[0], p[1]);
      if (opened[nk] || flagged[nk]) continue;
      if (mines[nk]) {
        opened[nk] = true;
        over = true;
        return "Boom! Wrong flags.";
      }
      flood(p[0], p[1]);
      openedNow += 1;
    }
    expandAroundZeros();
    if (openedNow === 0) return "No safe neighbors to open.";
    return "Opened surrounding safe cells.";
  }
  function reveal() {
    if (over) return "Game over.";
    const k = i(cursor.x, cursor.y);
    if (flagged[k]) return "Flag removed first.";
    if (opened[k]) {
      const m = chordRevealAt(cursor.x, cursor.y);
      checkWin();
      return won ? "You win!" : m;
    }
    if (!minesPlaced) placeMinesFirstOpen(cursor.x, cursor.y);
    if (mines[k]) {
      opened[k] = true;
      over = true;
      return "Boom!";
    }
    flood(cursor.x, cursor.y);
    expandAroundZeros();
    checkWin();
    return won ? "You win!" : "Revealed.";
  }
  function toggleFlag() {
    if (over) return "Game over.";
    const k = i(cursor.x, cursor.y);
    if (opened[k]) return "Already opened.";
    flagged[k] = !flagged[k];
    return flagged[k] ? "Flagged." : "Unflagged.";
  }
  function moveCursor(dx, dy) {
    cursor.x = Math.max(0, Math.min(W - 1, cursor.x + dx));
    cursor.y = Math.max(0, Math.min(H - 1, cursor.y + dy));
    return "Cursor moved.";
  }
  function encodeMsGrid() {
    let s = "";
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const k = i(x, y);
        const showMine = mines[k] && (opened[k] || (over && !won));
        if (showMine) s += "M";
        else if (opened[k] && !mines[k]) s += String(countAround(x, y));
        else if (!opened[k] && flagged[k]) s += "F";
        else s += "H";
      }
    }
    return s;
  }
  function render(note) {
    const flags = flagged.filter(Boolean).length;
    const elapsed = Math.floor(((over && endMs ? endMs : api.now()) - startMs) / 1000);
    api.updatePanelState(panelId, {
      markdown: "## Minesweeper",
      stats: {
        level: level,
        size: W + "x" + H,
        mines: MINES,
        flags: flags,
        time: elapsed + "s",
        best: best ? best + "s" : "-",
        state: won ? "win" : (over ? "lose" : "playing"),
        cursor: cursor.x + "," + cursor.y,
        _ms: encodeMsGrid(),
        _w: W,
        _h: H,
        _cx: cursor.x,
        _cy: cursor.y
      },
      items: [note || "初手は広く開きやすい配置。開いた数字マスを再度押すと、旗数一致で周囲を開きます。矢印・Enter・F。"],
      actions: [
        { label: "Lv: " + level, command: manifest.id + ".levelCycle" },
        { label: "Beginner", command: manifest.id + ".level", args: ["beginner"] },
        { label: "Intermediate", command: manifest.id + ".level", args: ["intermediate"] },
        { label: "Expert", command: manifest.id + ".level", args: ["expert"] },
        { label: "Custom 12x12/20", command: manifest.id + ".custom", args: [12, 12, 20] },
        { label: "◀", command: manifest.id + ".cursor", args: [-1, 0] },
        { label: "▲", command: manifest.id + ".cursor", args: [0, -1] },
        { label: "▼", command: manifest.id + ".cursor", args: [0, 1] },
        { label: "▶", command: manifest.id + ".cursor", args: [1, 0] },
        { label: "Reveal", command: manifest.id + ".reveal" },
        { label: "Flag", command: manifest.id + ".flag" },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  randomize();
  api.registerPanel({ id: panelId, title: "Minesweeper" });
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Minesweeper" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".level", title: "Set Minesweeper level" }, function(next){
    setLevel(String(next || "beginner"));
    render("Level: " + level + " (" + W + "x" + H + ", mines " + MINES + ")");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".levelCycle", title: "Cycle Minesweeper level" }, function(){
    setLevel(cycleLevel());
    render("Level: " + level + " (" + W + "x" + H + ", mines " + MINES + ")");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".custom", title: "Set custom Minesweeper field" }, function(w, h, m){
    setCustom(w, h, m);
    render("Custom: " + W + "x" + H + ", mines " + MINES);
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".cursor", title: "Move Minesweeper cursor" }, function(dx, dy){ const m = moveCursor(Number(dx)||0, Number(dy)||0); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".reveal", title: "Reveal Minesweeper cell" }, function(){ const m = reveal(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".flag", title: "Toggle Minesweeper flag" }, function(){ const m = toggleFlag(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New Minesweeper game" }, function(){ randomize(); render("New game started."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.puzzle-sudoku-pro": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const N = 9;
  const LEVELS = { easy: 36, normal: 46, hard: 54 };
  let level = String(api.storage.get("level") || "normal");
  if (!LEVELS[level]) level = "normal";
  let board = new Array(81).fill(0);
  let solution = new Array(81).fill(0);
  let givens = new Array(81).fill(false);
  let cursor = { x: 0, y: 0 };
  let note = "Ready.";
  let startMs = api.now();
  let best = Number(api.storage.get("best." + level) || 0);
  function i(x, y){ return y * N + x; }
  function baseSolved() {
    const out = [];
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) out.push(((x + y * 3 + Math.floor(y / 3)) % 9) + 1);
    return out;
  }
  function shuffle(arr){ for (let k = arr.length - 1; k > 0; k -= 1) { const j = Math.floor(api.random(0, k + 1)); const t = arr[k]; arr[k] = arr[j]; arr[j] = t; } return arr; }
  function shuffledSolution() {
    const s = baseSolved();
    const rowOrder = [];
    const colOrder = [];
    const bands = shuffle([0,1,2]);
    const stacks = shuffle([0,1,2]);
    for (let bi = 0; bi < 3; bi += 1) {
      const baseR = bands[bi] * 3;
      const innerR = shuffle([0,1,2]);
      for (let r = 0; r < 3; r += 1) rowOrder.push(baseR + innerR[r]);
      const baseC = stacks[bi] * 3;
      const innerC = shuffle([0,1,2]);
      for (let c = 0; c < 3; c += 1) colOrder.push(baseC + innerC[c]);
    }
    const mapDigits = shuffle([1,2,3,4,5,6,7,8,9]);
    const out = new Array(81).fill(0);
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      const v = s[i(colOrder[x], rowOrder[y])];
      out[i(x, y)] = mapDigits[v - 1];
    }
    return out;
  }
  function setLevel(next) {
    level = LEVELS[next] ? next : "normal";
    api.storage.set("level", level);
    best = Number(api.storage.get("best." + level) || 0);
  }
  function countSolutions(puz, limit) {
    const bd = puz.slice();
    function valid(k, v) {
      const x = k % 9;
      const y = Math.floor(k / 9);
      for (let c = 0; c < 9; c += 1) if (c !== x && bd[i(c, y)] === v) return false;
      for (let r = 0; r < 9; r += 1) if (r !== y && bd[i(x, r)] === v) return false;
      const bx = Math.floor(x / 3) * 3;
      const by = Math.floor(y / 3) * 3;
      for (let yy = by; yy < by + 3; yy += 1) for (let xx = bx; xx < bx + 3; xx += 1) {
        const kk = i(xx, yy);
        if (kk !== k && bd[kk] === v) return false;
      }
      return true;
    }
    function pickCell() {
      let bestK = -1;
      let bestCnt = 10;
      for (let k = 0; k < 81; k += 1) {
        if (bd[k] !== 0) continue;
        let cnt = 0;
        for (let v = 1; v <= 9; v += 1) if (valid(k, v)) cnt += 1;
        if (cnt < bestCnt) { bestCnt = cnt; bestK = k; }
      }
      return bestK;
    }
    let solutions = 0;
    function dfs() {
      if (solutions >= limit) return;
      const k = pickCell();
      if (k < 0) { solutions += 1; return; }
      for (let v = 1; v <= 9; v += 1) {
        if (!valid(k, v)) continue;
        bd[k] = v;
        dfs();
        bd[k] = 0;
        if (solutions >= limit) return;
      }
    }
    dfs();
    return solutions;
  }
  function newGame() {
    solution = shuffledSolution();
    board = solution.slice();
    givens = new Array(81).fill(true);
    const holes = LEVELS[level];
    const allIdx = [];
    for (let k = 0; k < 81; k += 1) allIdx.push(k);
    shuffle(allIdx);
    let opened = 0;
    for (let h = 0; h < allIdx.length && opened < holes; h += 1) {
      const k = allIdx[h];
      const keep = board[k];
      board[k] = 0;
      if (countSolutions(board, 2) === 1) {
        givens[k] = false;
        opened += 1;
      } else {
        board[k] = keep;
      }
    }
    startMs = api.now();
    note = "New " + level + " puzzle.";
  }
  function validAt(x, y, v) {
    if (v <= 0) return true;
    for (let c = 0; c < N; c += 1) if (c !== x && board[i(c, y)] === v) return false;
    for (let r = 0; r < N; r += 1) if (r !== y && board[i(x, r)] === v) return false;
    const bx = Math.floor(x / 3) * 3;
    const by = Math.floor(y / 3) * 3;
    for (let r = by; r < by + 3; r += 1) for (let c = bx; c < bx + 3; c += 1) {
      if ((c !== x || r !== y) && board[i(c, r)] === v) return false;
    }
    return true;
  }
  function errorCount() {
    let n = 0;
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      const v = board[i(x, y)];
      if (v > 0 && !validAt(x, y, v)) n += 1;
    }
    return n;
  }
  function solved() {
    for (let k = 0; k < 81; k += 1) if (board[k] !== solution[k]) return false;
    const elapsed = Math.max(1, Math.floor((api.now() - startMs) / 1000));
    if (!best || elapsed < best) {
      best = elapsed;
      api.storage.set("best." + level, best);
    }
    return true;
  }
  function setCell(v) {
    const k = i(cursor.x, cursor.y);
    if (givens[k]) return "Given cell.";
    board[k] = v;
    if (solved()) return "Solved!";
    return "Updated.";
  }
  function moveCursor(dx, dy) {
    cursor.x = Math.max(0, Math.min(8, cursor.x + dx));
    cursor.y = Math.max(0, Math.min(8, cursor.y + dy));
    return "Cursor moved.";
  }
  function encodeBoard() { return board.join(""); }
  function encodeGivens() { return givens.map(function(b){ return b ? "1" : "0"; }).join(""); }
  function render(msg) {
    api.updatePanelState(panelId, {
      markdown: "## Sudoku Pro",
      stats: {
        level: level,
        errors: errorCount(),
        complete: solved() ? "yes" : "no",
        time: Math.floor((api.now() - startMs) / 1000) + "s",
        best: best ? best + "s" : "-",
        cursor: cursor.x + "," + cursor.y,
        _sdk: encodeBoard(),
        _givens: encodeGivens(),
        _cx: cursor.x,
        _cy: cursor.y
      },
      items: [msg || note],
      actions: [
        { label: "Lv: " + level, command: manifest.id + ".levelCycle" },
        { label: "Easy", command: manifest.id + ".level", args: ["easy"] },
        { label: "Normal", command: manifest.id + ".level", args: ["normal"] },
        { label: "Hard", command: manifest.id + ".level", args: ["hard"] },
        { label: "New", command: manifest.id + ".new" },
        { label: "Hint", command: manifest.id + ".hint" }
      ].concat([1,2,3,4,5,6,7,8,9].map(function(n){ return { label: String(n), command: manifest.id + ".set", args: [n] }; })).concat([{ label: "Clear", command: manifest.id + ".clear" }])
    });
  }
  setLevel(level);
  newGame();
  api.registerPanel({ id: panelId, title: "Sudoku Pro" });
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Sudoku Pro" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".cursor", title: "Move Sudoku cursor" }, function(dx, dy){ const m = moveCursor(Number(dx)||0, Number(dy)||0); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".set", title: "Set Sudoku cell number" }, function(v){ const m = setCell(Math.max(1, Math.min(9, Number(v)||0))); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear Sudoku cell" }, function(){ const m = setCell(0); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".hint", title: "Fill Sudoku hint cell" }, function(){
    const k = i(cursor.x, cursor.y);
    if (givens[k]) { render("Given cell."); return { openPanelId: panelId }; }
    board[k] = solution[k];
    render(solved() ? "Solved!" : "Hint applied.");
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".new", title: "New Sudoku puzzle" }, function(){ newGame(); render("New " + level + " puzzle."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".level", title: "Set Sudoku level" }, function(next){ setLevel(String(next || "normal")); newGame(); render("Level: " + level); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".levelCycle", title: "Cycle Sudoku level" }, function(){ setLevel(level === "easy" ? "normal" : (level === "normal" ? "hard" : "easy")); newGame(); render("Level: " + level); return { openPanelId: panelId }; });
}
`,
  "builtin:game.board-chess-pro": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const N = 8;
  const INIT = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR";
  const VAL = { p:1, n:3, b:3, r:5, q:9, k:100 };
  let board = INIT.split("");
  let turn = "w";
  let selected = -1;
  let legalTargets = [];
  let mode = String(api.storage.get("mode") || "ai"); // ai/hotseat
  let aiLevel = String(api.storage.get("aiLevel") || "normal"); // easy/normal/hard
  let state = "playing";
  let msg = "White to move.";
  function i(x, y){ return y * N + x; }
  function xy(k){ return { x: k % N, y: Math.floor(k / N) }; }
  function inRange(x, y){ return x >= 0 && y >= 0 && x < N && y < N; }
  function col(p){ if (p === ".") return ""; return p === p.toUpperCase() ? "w" : "b"; }
  function t(p){ return p.toLowerCase(); }
  function opp(c){ return c === "w" ? "b" : "w"; }
  function clone(a){ return a.slice(); }
  function kingPos(src, c){ for (let k = 0; k < 64; k += 1) if (src[k] !== "." && col(src[k]) === c && t(src[k]) === "k") return k; return -1; }
  function pushRay(src, from, c, dx, dy, out) {
    const p = xy(from);
    let x = p.x + dx, y = p.y + dy;
    while (inRange(x, y)) {
      const k = i(x, y);
      if (src[k] === ".") out.push(k);
      else {
        if (col(src[k]) !== c) out.push(k);
        break;
      }
      x += dx; y += dy;
    }
  }
  function pseudoMoves(src, from, c) {
    const piece = src[from];
    if (piece === "." || col(piece) !== c) return [];
    const kind = t(piece);
    const p = xy(from);
    const out = [];
    if (kind === "p") {
      const dir = c === "w" ? -1 : 1;
      const y1 = p.y + dir;
      if (inRange(p.x, y1) && src[i(p.x, y1)] === ".") out.push(i(p.x, y1));
      const y2 = p.y + dir * 2;
      const start = c === "w" ? 6 : 1;
      if (p.y === start && src[i(p.x, y1)] === "." && inRange(p.x, y2) && src[i(p.x, y2)] === ".") out.push(i(p.x, y2));
      const caps = [p.x - 1, p.x + 1];
      for (let ci = 0; ci < caps.length; ci += 1) {
        const x = caps[ci];
        if (!inRange(x, y1)) continue;
        const k = i(x, y1);
        if (src[k] !== "." && col(src[k]) !== c) out.push(k);
      }
      return out;
    }
    if (kind === "n") {
      const ds = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
      for (let di = 0; di < ds.length; di += 1) {
        const x = p.x + ds[di][0], y = p.y + ds[di][1];
        if (!inRange(x, y)) continue;
        const k = i(x, y);
        if (src[k] === "." || col(src[k]) !== c) out.push(k);
      }
      return out;
    }
    if (kind === "b" || kind === "q") {
      pushRay(src, from, c, 1, 1, out); pushRay(src, from, c, 1, -1, out); pushRay(src, from, c, -1, 1, out); pushRay(src, from, c, -1, -1, out);
    }
    if (kind === "r" || kind === "q") {
      pushRay(src, from, c, 1, 0, out); pushRay(src, from, c, -1, 0, out); pushRay(src, from, c, 0, 1, out); pushRay(src, from, c, 0, -1, out);
    }
    if (kind === "k") {
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const x = p.x + dx, y = p.y + dy;
        if (!inRange(x, y)) continue;
        const k = i(x, y);
        if (src[k] === "." || col(src[k]) !== c) out.push(k);
      }
    }
    return out;
  }
  function attacked(src, sq, byColor) {
    for (let k = 0; k < 64; k += 1) {
      if (src[k] === "." || col(src[k]) !== byColor) continue;
      const pm = pseudoMoves(src, k, byColor);
      if (pm.indexOf(sq) >= 0) return true;
    }
    return false;
  }
  function applyMoveOn(src, from, to) {
    const p = src[from];
    src[from] = ".";
    let np = p;
    const yy = xy(to).y;
    if (t(p) === "p" && (yy === 0 || yy === 7)) np = col(p) === "w" ? "Q" : "q";
    src[to] = np;
  }
  function legalMovesFrom(src, from, c) {
    const out = [];
    const cand = pseudoMoves(src, from, c);
    for (let ci = 0; ci < cand.length; ci += 1) {
      const to = cand[ci];
      const nb = clone(src);
      applyMoveOn(nb, from, to);
      const kp = kingPos(nb, c);
      if (kp >= 0 && !attacked(nb, kp, opp(c))) out.push(to);
    }
    return out;
  }
  function allLegal(src, c) {
    const out = [];
    for (let from = 0; from < 64; from += 1) {
      if (src[from] === "." || col(src[from]) !== c) continue;
      const ts = legalMovesFrom(src, from, c);
      for (let ti = 0; ti < ts.length; ti += 1) out.push({ from: from, to: ts[ti] });
    }
    return out;
  }
  function scorePos(src) {
    let s = 0;
    for (let k = 0; k < 64; k += 1) {
      if (src[k] === ".") continue;
      const v = VAL[t(src[k])] || 0;
      s += col(src[k]) === "w" ? v : -v;
    }
    return s;
  }
  function chooseAiMove(moves) {
    if (!moves.length) return null;
    if (aiLevel === "easy") return moves[Math.floor(api.random(0, moves.length))] || moves[0];
    if (aiLevel === "normal") {
      let best = moves[0], bestSc = 9999;
      for (let mi = 0; mi < moves.length; mi += 1) {
        const mv = moves[mi];
        const nb = clone(board);
        applyMoveOn(nb, mv.from, mv.to);
        const sc = scorePos(nb);
        if (sc < bestSc) { bestSc = sc; best = mv; }
      }
      return best;
    }
    function minimax(src, c, d, alpha, beta) {
      const ms = allLegal(src, c);
      if (d <= 0 || !ms.length) return scorePos(src);
      if (c === "w") {
        let v = -99999;
        for (let m = 0; m < ms.length; m += 1) {
          const nb = clone(src);
          applyMoveOn(nb, ms[m].from, ms[m].to);
          const sc = minimax(nb, "b", d - 1, alpha, beta);
          if (sc > v) v = sc;
          if (v > alpha) alpha = v;
          if (beta <= alpha) break;
        }
        return v;
      }
      let v = 99999;
      for (let m = 0; m < ms.length; m += 1) {
        const nb = clone(src);
        applyMoveOn(nb, ms[m].from, ms[m].to);
        const sc = minimax(nb, "w", d - 1, alpha, beta);
        if (sc < v) v = sc;
        if (v < beta) beta = v;
        if (beta <= alpha) break;
      }
      return v;
    }
    let best = moves[0], bestSc = 99999;
    for (let mi = 0; mi < moves.length; mi += 1) {
      const mv = moves[mi];
      const nb = clone(board);
      applyMoveOn(nb, mv.from, mv.to);
      const sc = minimax(nb, "w", 2, -99999, 99999);
      if (sc < bestSc) { bestSc = sc; best = mv; }
    }
    return best;
  }
  function moveName(from, to) {
    const a = xy(from), b = xy(to);
    const files = "abcdefgh";
    return files[a.x] + (8 - a.y) + "-" + files[b.x] + (8 - b.y);
  }
  function updateGameState() {
    const ms = allLegal(board, turn);
    if (ms.length) { state = "playing"; return; }
    const kp = kingPos(board, turn);
    if (kp >= 0 && attacked(board, kp, opp(turn))) {
      state = "checkmate";
      msg = (turn === "w" ? "White" : "Black") + " is checkmated.";
      return;
    }
    state = "stalemate";
    msg = "Stalemate.";
  }
  function aiPlayIfNeeded() {
    if (mode !== "ai" || turn !== "b") return;
    const ms = allLegal(board, "b");
    if (!ms.length) { updateGameState(); return; }
    const mv = chooseAiMove(ms);
    if (!mv) return;
    applyMoveOn(board, mv.from, mv.to);
    turn = "w";
    selected = -1; legalTargets = [];
    msg = "AI: " + moveName(mv.from, mv.to);
    updateGameState();
  }
  function selectOrMoveCell(x, y) {
    const k = i(x, y);
    if (state !== "playing") return "Game finished. Start new game.";
    if (mode === "ai" && turn !== "w") return "AI thinking.";
    if (selected >= 0 && legalTargets.indexOf(k) >= 0) {
      const from = selected;
      applyMoveOn(board, from, k);
      turn = opp(turn);
      selected = -1; legalTargets = [];
      msg = "Moved " + moveName(from, k);
      updateGameState();
      aiPlayIfNeeded();
      return msg;
    }
    if (board[k] !== "." && col(board[k]) === turn) {
      selected = k;
      legalTargets = legalMovesFrom(board, k, turn);
      return "Selected.";
    }
    selected = -1; legalTargets = [];
    return "No piece selected.";
  }
  function reset() {
    board = INIT.split("");
    turn = "w";
    selected = -1;
    legalTargets = [];
    state = "playing";
    msg = "New game.";
    aiPlayIfNeeded();
  }
  function encodeBoard(){ return board.join(""); }
  function encodeTargets(){ return legalTargets.map(function(k){ const p = xy(k); return p.x + "," + p.y; }).join(";"); }
  function cycleMode(){ mode = mode === "ai" ? "hotseat" : "ai"; api.storage.set("mode", mode); }
  function cycleAi(){ aiLevel = aiLevel === "easy" ? "normal" : (aiLevel === "normal" ? "hard" : "easy"); api.storage.set("aiLevel", aiLevel); }
  function render(note) {
    const legalNow = allLegal(board, turn).length;
    const canHuman = mode === "hotseat" || turn === "w";
    const sel = selected >= 0 ? (xy(selected).x + "," + xy(selected).y) : "";
    api.updatePanelState(panelId, {
      markdown: "## Chess Pro",
      stats: {
        turn: turn === "w" ? "white" : "black",
        mode: mode,
        aiLevel: aiLevel,
        state: state,
        legalMoves: legalNow,
        _chess: encodeBoard(),
        _legal: encodeTargets(),
        _sel: sel,
        _canHumanMove: canHuman ? "1" : "0"
      },
      items: [note || msg],
      actions: [
        { label: "Mode: " + mode, command: manifest.id + ".mode" },
        { label: "AI: " + aiLevel, command: manifest.id + ".ai" },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Chess Pro" });
  reset();
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Chess Pro" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".cell", title: "Select or move chess piece" }, function(x, y){ const m = selectOrMoveCell(Number(x)||0, Number(y)||0); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".mode", title: "Toggle chess mode" }, function(){ cycleMode(); if (mode === "ai" && turn === "b") aiPlayIfNeeded(); render("Mode: " + mode); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".ai", title: "Cycle chess AI level" }, function(){ cycleAi(); render("AI level: " + aiLevel); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New chess game" }, function(){ reset(); render("New game."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.board-shogi-lite": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const N = 9;
  function initial() {
    const b = [];
    for (let y = 0; y < N; y += 1) { const r = []; for (let x = 0; x < N; x += 1) r.push("."); b.push(r); }
    b[0] = ["l","n","s","g","k","g","s","n","l"];
    b[1][1] = "r"; b[1][7] = "b";
    for (let x = 0; x < N; x += 1) b[2][x] = "p";
    b[8] = ["L","N","S","G","K","G","S","N","L"];
    b[7][1] = "B"; b[7][7] = "R";
    for (let x = 0; x < N; x += 1) b[6][x] = "P";
    return b;
  }
  let board = initial();
  let turn = "b"; // black first
  let mode = String(api.storage.get("mode") || "ai");
  let aiLevel = String(api.storage.get("aiLevel") || "normal");
  let sel = null;
  let legal = [];
  let hand = { b: { P:0, L:0, N:0, S:0, G:0, B:0, R:0 }, w: { P:0, L:0, N:0, S:0, G:0, B:0, R:0 } };
  let msg = "Black to move.";
  function inRange(x,y){ return x>=0&&y>=0&&x<N&&y<N; }
  function side(p){ if (p === ".") return ""; const raw = String(p).replace("+",""); return raw === raw.toUpperCase() ? "b" : "w"; }
  function opp(s){ return s === "b" ? "w" : "b"; }
  function baseKind(p){ const k = p.replace("+",""); return k.toUpperCase(); }
  function isPromoted(p){ return p.indexOf("+") >= 0; }
  function toPiece(side, kind, promoted){ const k = side === "b" ? kind : kind.toLowerCase(); return promoted ? "+" + k : k; }
  function get(x,y){ return board[y][x]; }
  function set(x,y,v){ board[y][x]=v; }
  function vecs(kind, promoted, s) {
    const f = s === "b" ? -1 : 1;
    if (kind === "K") return [[-1,-1], [0,-1], [1,-1], [-1,0], [1,0], [-1,1], [0,1], [1,1]];
    if (kind === "G" || (promoted && (kind === "P" || kind === "L" || kind === "N" || kind === "S"))) return [[-1,f],[0,f],[1,f],[-1,0],[1,0],[0,-f]];
    if (kind === "S") return [[-1,f],[0,f],[1,f],[-1,-f],[1,-f]];
    if (kind === "N") return [[-1,f*2],[1,f*2]];
    if (kind === "L") return [[0,f, true]];
    if (kind === "P") return [[0,f]];
    if (kind === "R") {
      const out = [[1,0,true],[-1,0,true],[0,1,true],[0,-1,true]];
      if (promoted) out.push([-1,-1],[1,-1],[-1,1],[1,1]);
      return out;
    }
    if (kind === "B") {
      const out = [[1,1,true],[-1,1,true],[1,-1,true],[-1,-1,true]];
      if (promoted) out.push([1,0],[-1,0],[0,1],[0,-1]);
      return out;
    }
    return [];
  }
  function canPromote(k){ return k === "P" || k === "L" || k === "N" || k === "S" || k === "B" || k === "R"; }
  function inPromoZone(s, y){ return s === "b" ? y <= 2 : y >= 6; }
  function legalFrom(x, y) {
    const p = get(x,y);
    if (p === ".") return [];
    const s = side(p);
    const kind = baseKind(p);
    const promoted = isPromoted(p);
    const out = [];
    const mvs = vecs(kind, promoted, s);
    for (let mi = 0; mi < mvs.length; mi += 1) {
      const mv = mvs[mi];
      const dx = mv[0], dy = mv[1], ray = !!mv[2];
      let nx = x + dx, ny = y + dy;
      while (inRange(nx, ny)) {
        const tp = get(nx, ny);
        if (tp === ".") out.push({ x:nx, y:ny, drop:false });
        else {
          if (side(tp) !== s) out.push({ x:nx, y:ny, drop:false });
          break;
        }
        if (!ray) break;
        nx += dx; ny += dy;
      }
    }
    return out;
  }
  function legalDrops(kind, s) {
    const out = [];
    function hasUnpromotedPawnInFile(file) {
      for (let yy = 0; yy < N; yy += 1) {
        const p = get(file, yy);
        if (p === ".") continue;
        if (side(p) !== s) continue;
        if (baseKind(p) === "P" && !isPromoted(p)) return true;
      }
      return false;
    }
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      if (get(x,y) !== ".") continue;
      if (kind === "P") {
        if ((s === "b" && y === 0) || (s === "w" && y === 8)) continue;
        if (hasUnpromotedPawnInFile(x)) continue; // nifu
      }
      if (kind === "L") {
        if ((s === "b" && y === 0) || (s === "w" && y === 8)) continue;
      }
      if (kind === "N") {
        if ((s === "b" && y <= 1) || (s === "w" && y >= 7)) continue;
      }
      out.push({ x:x, y:y, drop:true, kind:kind });
    }
    return out;
  }
  function allLegal(s) {
    const out = [];
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
      const p = get(x,y);
      if (p === "." || side(p) !== s) continue;
      const ls = legalFrom(x, y);
      for (let k = 0; k < ls.length; k += 1) out.push({ from:{x:x,y:y}, to:{x:ls[k].x,y:ls[k].y}, drop:false });
    }
    const hs = hand[s];
    Object.keys(hs).forEach(function(k){
      if (hs[k] <= 0) return;
      const ds = legalDrops(k, s);
      for (let di = 0; di < ds.length; di += 1) out.push({ from:null, to:{x:ds[di].x,y:ds[di].y}, drop:true, kind:k });
    });
    return out;
  }
  function applyMove(mv, s) {
    if (mv.drop) {
      const kind = mv.kind;
      hand[s][kind] = Math.max(0, hand[s][kind] - 1);
      set(mv.to.x, mv.to.y, toPiece(s, kind, false));
      return;
    }
    const from = mv.from, to = mv.to;
    const p = get(from.x, from.y);
    const target = get(to.x, to.y);
    if (target !== ".") {
      const capturedKind = baseKind(target);
      if (capturedKind !== "K") hand[s][capturedKind] = (hand[s][capturedKind] || 0) + 1;
    }
    set(from.x, from.y, ".");
    let promoted = isPromoted(p);
    const kind = baseKind(p);
    if (!promoted && canPromote(kind) && (inPromoZone(s, from.y) || inPromoZone(s, to.y))) promoted = true;
    set(to.x, to.y, toPiece(s, kind, promoted));
  }
  function hasKing(s) {
    const key = s === "b" ? "K" : "k";
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) if (get(x,y) === key) return true;
    return false;
  }
  function aiPick(ms) {
    if (!ms.length) return null;
    if (aiLevel === "easy") return ms[Math.floor(api.random(0, ms.length))] || ms[0];
    let best = ms[0], bestScore = -99999;
    for (let mi = 0; mi < ms.length; mi += 1) {
      const m = ms[mi];
      const tp = get(m.to.x, m.to.y);
      let s = 0;
      if (tp !== ".") s += 10;
      if (m.drop) s += 1;
      if (aiLevel === "hard") {
        if ((m.to.x === 4 && m.to.y === 4) || (m.to.x === 4 && m.to.y === 3) || (m.to.x === 4 && m.to.y === 5)) s += 3;
      }
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }
  function advanceTurnWithPasses() {
    let hop = 0;
    while (hop < 3) {
      const ms = allLegal(turn);
      if (ms.length) return false;
      const o = opp(turn);
      const oms = allLegal(o);
      if (!oms.length) { msg = "Game finished."; return true; }
      turn = o;
      msg = "No legal move. Turn switched.";
      hop += 1;
    }
    return false;
  }
  function aiPlayIfNeeded() {
    if (mode !== "ai") return;
    let guard = 0;
    while (turn === "w" && guard < 4) {
      if (advanceTurnWithPasses()) return;
      if (turn !== "w") return;
      const ms = allLegal("w");
      if (!ms.length) return;
      const pick = aiPick(ms);
      if (!pick) return;
      applyMove(pick, "w");
      turn = "b";
      sel = null;
      legal = [];
      if (!hasKing("b") || !hasKing("w")) { msg = "Game finished."; return; }
      msg = "AI moved.";
      if (advanceTurnWithPasses()) return;
      guard += 1;
    }
  }
  function selectCell(x, y) {
    if (mode === "ai" && turn !== "b") return "AI turn.";
    if (sel) {
      for (let li = 0; li < legal.length; li += 1) {
        const m = legal[li];
        if (m.to.x === x && m.to.y === y) {
          applyMove(m, turn);
          turn = opp(turn);
          sel = null; legal = [];
          if (!hasKing("b") || !hasKing("w")) { msg = "Game finished."; return msg; }
          if (advanceTurnWithPasses()) return msg;
          aiPlayIfNeeded();
          return "Moved.";
        }
      }
    }
    const p = get(x,y);
    if (p !== "." && side(p) === turn) {
      sel = { drop:false, x:x, y:y };
      legal = legalFrom(x, y).map(function(t){ return { from:{x:x,y:y}, to:{x:t.x,y:t.y}, drop:false }; });
      return "Selected.";
    }
    sel = null; legal = [];
    return "No piece selected.";
  }
  function selectDrop(kind) {
    if (mode === "ai" && turn !== "b") return "AI turn.";
    if ((hand[turn][kind] || 0) <= 0) return "No piece in hand.";
    sel = { drop:true, kind:kind };
    legal = legalDrops(kind, turn).map(function(t){ return { from:null, to:{x:t.x,y:t.y}, drop:true, kind:kind }; });
    return "Drop selected.";
  }
  function reset() {
    board = initial();
    hand = { b: { P:0, L:0, N:0, S:0, G:0, B:0, R:0 }, w: { P:0, L:0, N:0, S:0, G:0, B:0, R:0 } };
    turn = "b";
    sel = null;
    legal = [];
    msg = "Black to move.";
    aiPlayIfNeeded();
  }
  function encode() {
    const s = [];
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) s.push(get(x,y));
    return JSON.stringify({
      b: s,
      hand: hand,
      turn: turn,
      legal: legal.map(function(m){ return m.to.x + "," + m.to.y; }),
      sel: sel,
      mode: mode,
      aiLevel: aiLevel
    });
  }
  function cycleMode(){ mode = mode === "ai" ? "hotseat" : "ai"; api.storage.set("mode", mode); }
  function cycleAi(){ aiLevel = aiLevel === "easy" ? "normal" : (aiLevel === "normal" ? "hard" : "easy"); api.storage.set("aiLevel", aiLevel); }
  function render(note) {
    const hb = hand.b;
    api.updatePanelState(panelId, {
      markdown: "## Shogi Lite",
      stats: {
        turn: turn === "b" ? "black" : "white",
        mode: mode,
        aiLevel: aiLevel,
        handB: "P" + hb.P + " L" + hb.L + " N" + hb.N + " S" + hb.S + " G" + hb.G + " B" + hb.B + " R" + hb.R,
        _shogi: encode()
      },
      items: [note || msg],
      actions: [
        { label: "Mode: " + mode, command: manifest.id + ".mode" },
        { label: "AI: " + aiLevel, command: manifest.id + ".ai" },
        { label: "Drop P", command: manifest.id + ".drop", args: ["P"] },
        { label: "Drop G", command: manifest.id + ".drop", args: ["G"] },
        { label: "Drop B", command: manifest.id + ".drop", args: ["B"] },
        { label: "Drop R", command: manifest.id + ".drop", args: ["R"] },
        { label: "New Game", command: manifest.id + ".new" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Shogi Lite" });
  reset();
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Shogi Lite" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".cell", title: "Select or move shogi piece" }, function(x, y){ const m = selectCell(Number(x)||0, Number(y)||0); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".drop", title: "Select shogi drop piece" }, function(kind){ const m = selectDrop(String(kind || "P").toUpperCase()); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".mode", title: "Toggle shogi mode" }, function(){ cycleMode(); if (mode === "ai" && turn === "w") aiPlayIfNeeded(); render("Mode: " + mode); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".ai", title: "Cycle shogi AI level" }, function(){ cycleAi(); render("AI level: " + aiLevel); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New shogi game" }, function(){ reset(); render("New game."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.puzzle-puyo-burst": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const W = 6, H = 12;
  const COLORS = [1,2,3,4];
  let board = [];
  let pair = null;
  let nextPair = null;
  let x = 2, y = 0;
  let dir = 0;
  let score = Number(api.storage.get("score") || 0);
  let chains = 0;
  let level = Number(api.storage.get("level") || 1);
  let over = false;
  let last = api.now();
  let timer = null;
  function newBoard(){ board = []; for (let r=0;r<H;r+=1) board.push(new Array(W).fill(0)); }
  function randColor(){ return COLORS[Math.floor(api.random(0, COLORS.length))]; }
  function spawn(){
    if (!nextPair) nextPair = [randColor(), randColor()];
    pair = [nextPair[0], nextPair[1]];
    nextPair = [randColor(), randColor()];
    x = 2; y = 0; dir = 0;
    if (!can(x,y,dir)) over = true;
  }
  function blocks(px, py, pd){ const ds = [[0,-1],[1,0],[0,1],[-1,0]][pd%4]; return [[px,py,pair[0]],[px+ds[0],py+ds[1],pair[1]]]; }
  function can(px, py, pd){ const b = blocks(px, py, pd); for (let bi=0;bi<b.length;bi+=1){ const t=b[bi]; const xx=t[0], yy=t[1]; if (xx<0||yy<0||xx>=W||yy>=H) return false; if (board[yy][xx]) return false; } return true; }
  function lock(){ const b=blocks(x,y,dir); for (let bi=0;bi<b.length;bi+=1){ const t=b[bi]; board[t[1]][t[0]] = t[2]; } }
  function gravity(){ let moved=false; for (let x=0;x<W;x+=1){ for (let y=H-2;y>=0;y-=1){ if (!board[y][x]) continue; let ny=y; while (ny+1<H && !board[ny+1][x]) ny+=1; if (ny!==y){ board[ny][x]=board[y][x]; board[y][x]=0; moved=true; } } } return moved; }
  function clearGroups(){
    const vis = [];
    for (let y=0;y<H;y+=1) vis.push(new Array(W).fill(false));
    let removed = 0;
    let groups = 0;
    const colors = {};
    for (let y=0;y<H;y+=1) for (let x=0;x<W;x+=1) {
      const c = board[y][x];
      if (!c || vis[y][x]) continue;
      const q=[[x,y]], comp=[]; vis[y][x]=true;
      while (q.length) {
        const p=q.pop(); comp.push(p);
        const nx=[[1,0],[-1,0],[0,1],[0,-1]];
        for (let ni=0;ni<nx.length;ni+=1){
          const xx=p[0]+nx[ni][0], yy=p[1]+nx[ni][1];
          if (xx<0||yy<0||xx>=W||yy>=H) continue;
          if (vis[yy][xx] || board[yy][xx]!==c) continue;
          vis[yy][xx]=true; q.push([xx,yy]);
        }
      }
      if (comp.length >= 4) {
        groups += 1;
        colors[c] = true;
        for (let ci=0;ci<comp.length;ci+=1){ const p=comp[ci]; board[p[1]][p[0]]=0; removed+=1; }
      }
    }
    return { removed: removed, groups: groups, colors: Object.keys(colors).length };
  }
  function settle(){
    chains = 0;
    while (true) {
      gravity();
      const rm = clearGroups();
      if (!rm.removed) break;
      chains += 1;
      const colorBonus = Math.max(1, rm.colors);
      const groupBonus = Math.max(1, rm.groups);
      score += rm.removed * 10 * (chains + colorBonus + groupBonus - 1);
      if (score > 0 && score % 300 === 0) level = Math.min(9, level + 1);
    }
  }
  function tick(){
    if (over) return "Game over.";
    if (can(x, y+1, dir)) { y += 1; return "Down."; }
    lock();
    settle();
    spawn();
    api.storage.set("score", score);
    api.storage.set("level", level);
    return over ? "Game over." : "Locked.";
  }
  function move(dx){ if (over) return "Game over."; if (can(x+dx, y, dir)) { x+=dx; return "Moved."; } return "Blocked."; }
  function rot(){ if (over) return "Game over."; const nd=(dir+1)%4; if (can(x,y,nd)) { dir=nd; return "Rotated."; } return "Blocked."; }
  function drop(){ if (over) return "Game over."; while (can(x,y+1,dir)) y+=1; return tick(); }
  function encode(){
    const temp = board.map(function(r){ return r.slice(); });
    if (!over && pair) {
      const b=blocks(x,y,dir);
      for (let bi=0;bi<b.length;bi+=1){ const t=b[bi]; temp[t[1]][t[0]] = t[2]; }
    }
    return temp.map(function(r){ return r.join(""); }).join("/");
  }
  function speedMs(){ return Math.max(110, 620 - level * 50); }
  function auto(){ if (over) return; const now = api.now(); if (now - last < speedMs()) return; last = now; render(tick()); }
  function ensureTimer(){ if (timer != null) return; timer = setInterval(auto, 70); }
  function render(note){
    api.updatePanelState(panelId, {
      markdown: "## Puyo Burst",
      stats: { score: score, level: level, chains: chains, state: over ? "game over" : "playing", _puyo: encode() },
      items: [note || "Connect 4+ same colors to pop.", "Next: " + (nextPair ? nextPair.join("-") : "-")],
      actions: [
        { label: "◀", command: manifest.id + ".left" },
        { label: "▶", command: manifest.id + ".right" },
        { label: "⟳", command: manifest.id + ".rot" },
        { label: "Tick", command: manifest.id + ".tick" },
        { label: "Drop", command: manifest.id + ".drop" },
        { label: "New", command: manifest.id + ".new" }
      ]
    });
  }
  function newGame(){ newBoard(); score = 0; chains = 0; level = 1; over = false; nextPair = null; spawn(); last = api.now(); }
  newGame();
  api.registerPanel({ id: panelId, title: "Puyo Burst" });
  ensureTimer();
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Puyo Burst" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".left", title: "Move puyo pair left" }, function(){ const m=move(-1); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".right", title: "Move puyo pair right" }, function(){ const m=move(1); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".rot", title: "Rotate puyo pair" }, function(){ const m=rot(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".tick", title: "Advance puyo one tick" }, function(){ const m=tick(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".drop", title: "Hard drop puyo pair" }, function(){ const m=drop(); render(m); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New puyo game" }, function(){ newGame(); render("New game."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.card-solitaire-klondike": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const SUITS = ["S","H","D","C"];
  const RANK = [1,2,3,4,5,6,7,8,9,10,11,12,13];
  let stock = [];
  let waste = [];
  let foundations = { S:0, H:0, D:0, C:0 };
  let tableau = [];
  let drawCount = Number(api.storage.get("drawCount") || 1) === 3 ? 3 : 1;
  let msg = "Ready.";
  function cardColor(c){ return c.suit === "H" || c.suit === "D" ? "R" : "B"; }
  function cardText(c){ const r = c.rank === 1 ? "A" : (c.rank === 11 ? "J" : (c.rank === 12 ? "Q" : (c.rank === 13 ? "K" : String(c.rank)))); return r + c.suit; }
  function shuffle(arr){ for (let i=arr.length-1;i>0;i-=1){ const j=Math.floor(api.random(0,i+1)); const t=arr[i]; arr[i]=arr[j]; arr[j]=t; } return arr; }
  function freshDeck(){ const d=[]; for(let s=0;s<SUITS.length;s+=1) for(let r=0;r<RANK.length;r+=1) d.push({ suit:SUITS[s], rank:RANK[r], up:false }); return shuffle(d); }
  function setup() {
    const d = freshDeck();
    stock = [];
    waste = [];
    foundations = { S:0, H:0, D:0, C:0 };
    tableau = [];
    for (let c=0;c<7;c+=1) {
      const col = [];
      for (let r=0;r<=c;r+=1) {
        const k = d.pop();
        k.up = r === c;
        col.push(k);
      }
      tableau.push(col);
    }
    while (d.length) stock.push(d.pop());
    msg = "New game.";
  }
  function canToFoundation(card){ return foundations[card.suit] + 1 === card.rank; }
  function canToTableau(card, col) {
    if (!col.length) return card.rank === 13;
    const top = col[col.length - 1];
    if (!top.up) return false;
    return cardColor(card) !== cardColor(top) && card.rank + 1 === top.rank;
  }
  function faceupStart(col) {
    for (let i = 0; i < col.length; i += 1) if (col[i].up) return i;
    return col.length;
  }
  function validRun(col, start) {
    if (start < 0 || start >= col.length) return false;
    for (let i = start; i < col.length; i += 1) if (!col[i].up) return false;
    for (let i = start; i < col.length - 1; i += 1) {
      const a = col[i], b = col[i + 1];
      if (cardColor(a) === cardColor(b)) return false;
      if (a.rank !== b.rank + 1) return false;
    }
    return true;
  }
  function draw() {
    if (!stock.length) {
      while (waste.length) { const c = waste.pop(); c.up = false; stock.push(c); }
      msg = "Recycle waste to stock.";
      return;
    }
    let drew = 0;
    let lastText = "";
    while (stock.length && drew < drawCount) {
      const c = stock.pop();
      c.up = true;
      waste.push(c);
      lastText = cardText(c);
      drew += 1;
    }
    msg = "Drew " + drew + " card(s)" + (lastText ? " (" + lastText + ")" : "");
  }
  function moveWasteToFoundation() {
    if (!waste.length) { msg = "Waste empty."; return; }
    const c = waste[waste.length - 1];
    if (!canToFoundation(c)) { msg = "Cannot move to foundation."; return; }
    waste.pop();
    foundations[c.suit] = c.rank;
    msg = "Moved " + cardText(c) + " to foundation.";
  }
  function moveWasteToTableau(idx) {
    if (!waste.length) { msg = "Waste empty."; return; }
    if (idx < 0 || idx >= 7) { msg = "Invalid column."; return; }
    const c = waste[waste.length - 1];
    if (!canToTableau(c, tableau[idx])) { msg = "Cannot place there."; return; }
    waste.pop();
    tableau[idx].push(c);
    msg = "Moved " + cardText(c) + " to column " + (idx + 1);
  }
  function moveTableauToFoundation(idx) {
    if (idx < 0 || idx >= 7 || !tableau[idx].length) { msg = "Invalid column."; return; }
    const top = tableau[idx][tableau[idx].length - 1];
    if (!top.up) { msg = "Top card is facedown."; return; }
    if (!canToFoundation(top)) { msg = "Cannot move to foundation."; return; }
    tableau[idx].pop();
    foundations[top.suit] = top.rank;
    if (tableau[idx].length && !tableau[idx][tableau[idx].length - 1].up) tableau[idx][tableau[idx].length - 1].up = true;
    msg = "Moved " + cardText(top) + " to foundation.";
  }
  function moveTableauToTableau(from, to) {
    if (from < 0 || from >= 7 || to < 0 || to >= 7 || from === to) { msg = "Invalid move."; return; }
    if (!tableau[from].length) { msg = "Source empty."; return; }
    const start = faceupStart(tableau[from]);
    if (start >= tableau[from].length) { msg = "No face-up run."; return; }
    let moved = -1;
    for (let s = start; s < tableau[from].length; s += 1) {
      const first = tableau[from][s];
      if (!validRun(tableau[from], s)) continue;
      if (!canToTableau(first, tableau[to])) continue;
      const run = tableau[from].splice(s);
      for (let ri = 0; ri < run.length; ri += 1) tableau[to].push(run[ri]);
      moved = run.length;
      break;
    }
    if (moved < 0) { msg = "Cannot place there."; return; }
    if (tableau[from].length && !tableau[from][tableau[from].length - 1].up) tableau[from][tableau[from].length - 1].up = true;
    msg = "Moved run (" + moved + ") to column " + (to + 1);
  }
  function moveFoundationToTableau(suit, idx) {
    const s = String(suit || "").toUpperCase();
    if (!foundations[s]) { msg = "Foundation empty."; return; }
    if (idx < 0 || idx >= 7) { msg = "Invalid column."; return; }
    const c = { suit: s, rank: foundations[s], up: true };
    if (!canToTableau(c, tableau[idx])) { msg = "Cannot place there."; return; }
    foundations[s] -= 1;
    tableau[idx].push(c);
    msg = "Moved " + cardText(c) + " to column " + (idx + 1);
  }
  function toggleDrawMode() {
    drawCount = drawCount === 1 ? 3 : 1;
    api.storage.set("drawCount", drawCount);
  }
  function won(){ return foundations.S === 13 && foundations.H === 13 && foundations.D === 13 && foundations.C === 13; }
  function encode(){
    return JSON.stringify({
      stock: stock.length,
      waste: waste.length ? cardText(waste[waste.length - 1]) : "--",
      draw: drawCount,
      f: foundations,
      tab: tableau.map(function(col){ return col.map(function(c){ return c.up ? cardText(c) : "##"; }); })
    });
  }
  function render(note){
    api.updatePanelState(panelId, {
      markdown: "## Solitaire (Klondike Lite)",
      stats: {
        stock: stock.length,
        waste: waste.length ? cardText(waste[waste.length - 1]) : "--",
        draw: drawCount,
        foundations: "S" + foundations.S + " H" + foundations.H + " D" + foundations.D + " C" + foundations.C,
        state: won() ? "win" : "playing",
        _sol: encode()
      },
      items: [note || msg],
      actions: [
        { label: "Draw x" + drawCount, command: manifest.id + ".drawMode" },
        { label: "Draw", command: manifest.id + ".draw" },
        { label: "Waste→F", command: manifest.id + ".wf" },
        { label: "Waste→T1", command: manifest.id + ".wt", args: [0] },
        { label: "Waste→T2", command: manifest.id + ".wt", args: [1] },
        { label: "Waste→T3", command: manifest.id + ".wt", args: [2] },
        { label: "Waste→T4", command: manifest.id + ".wt", args: [3] },
        { label: "Waste→T5", command: manifest.id + ".wt", args: [4] },
        { label: "Waste→T6", command: manifest.id + ".wt", args: [5] },
        { label: "Waste→T7", command: manifest.id + ".wt", args: [6] },
        { label: "T1→F", command: manifest.id + ".tf", args: [0] },
        { label: "T2→F", command: manifest.id + ".tf", args: [1] },
        { label: "T3→F", command: manifest.id + ".tf", args: [2] },
        { label: "T4→F", command: manifest.id + ".tf", args: [3] },
        { label: "T5→F", command: manifest.id + ".tf", args: [4] },
        { label: "T6→F", command: manifest.id + ".tf", args: [5] },
        { label: "T7→F", command: manifest.id + ".tf", args: [6] },
        { label: "T1→T2", command: manifest.id + ".tt", args: [0,1] },
        { label: "T2→T3", command: manifest.id + ".tt", args: [1,2] },
        { label: "T3→T4", command: manifest.id + ".tt", args: [2,3] },
        { label: "T4→T5", command: manifest.id + ".tt", args: [3,4] },
        { label: "T5→T6", command: manifest.id + ".tt", args: [4,5] },
        { label: "T6→T7", command: manifest.id + ".tt", args: [5,6] },
        { label: "FS→T1", command: manifest.id + ".ft", args: ["S", 0] },
        { label: "FH→T2", command: manifest.id + ".ft", args: ["H", 1] },
        { label: "FD→T3", command: manifest.id + ".ft", args: ["D", 2] },
        { label: "FC→T4", command: manifest.id + ".ft", args: ["C", 3] },
        { label: "New", command: manifest.id + ".new" }
      ]
    });
  }
  setup();
  api.registerPanel({ id: panelId, title: "Solitaire" });
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Solitaire" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".draw", title: "Draw Solitaire card" }, function(){ draw(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".drawMode", title: "Toggle Solitaire draw mode" }, function(){ toggleDrawMode(); render("Draw mode x" + drawCount + "."); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".wf", title: "Move waste to foundation" }, function(){ moveWasteToFoundation(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".wt", title: "Move waste to tableau" }, function(to){ moveWasteToTableau(Number(to)||0); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".tf", title: "Move tableau top to foundation" }, function(from){ moveTableauToFoundation(Number(from)||0); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".tt", title: "Move tableau top to tableau" }, function(from, to){ moveTableauToTableau(Number(from)||0, Number(to)||0); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".ft", title: "Move foundation to tableau" }, function(suit, to){ moveFoundationToTableau(String(suit||"S"), Number(to)||0); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New Solitaire game" }, function(){ setup(); render("New game."); return { openPanelId: panelId }; });
}
`,
  "builtin:game.board-connect-four": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  const W = 7, H = 6;
  let board = [];
  let turn = 1; // 1=Red, 2=Yellow
  let winner = 0; // 0=none,1=red,2=yellow,3=draw
  let mode = String(api.storage.get("mode") || "ai");
  if (mode !== "ai" && mode !== "2p") mode = "ai";
  let msg = "Ready.";
  function reset() {
    board = [];
    for (let y = 0; y < H; y += 1) {
      const row = [];
      for (let x = 0; x < W; x += 1) row.push(0);
      board.push(row);
    }
    turn = 1;
    winner = 0;
    msg = "New game.";
  }
  function canDrop(col) { return col >= 0 && col < W && board[0][col] === 0; }
  function drop(col, p) {
    for (let y = H - 1; y >= 0; y -= 1) {
      if (board[y][col] === 0) {
        board[y][col] = p;
        return y;
      }
    }
    return -1;
  }
  function inBoard(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }
  function wonAt(x, y, p) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let d = 0; d < dirs.length; d += 1) {
      const dx = dirs[d][0], dy = dirs[d][1];
      let cnt = 1;
      let nx = x + dx, ny = y + dy;
      while (inBoard(nx, ny) && board[ny][nx] === p) { cnt += 1; nx += dx; ny += dy; }
      nx = x - dx; ny = y - dy;
      while (inBoard(nx, ny) && board[ny][nx] === p) { cnt += 1; nx -= dx; ny -= dy; }
      if (cnt >= 4) return true;
    }
    return false;
  }
  function full() {
    for (let x = 0; x < W; x += 1) if (board[0][x] === 0) return false;
    return true;
  }
  function aiPick() {
    const order = [3, 2, 4, 1, 5, 0, 6];
    for (let i = 0; i < order.length; i += 1) {
      const c = order[i];
      if (!canDrop(c)) continue;
      const y = drop(c, 2);
      const win = wonAt(c, y, 2);
      board[y][c] = 0;
      if (win) return c;
    }
    for (let i = 0; i < order.length; i += 1) {
      const c = order[i];
      if (!canDrop(c)) continue;
      const y = drop(c, 1);
      const block = wonAt(c, y, 1);
      board[y][c] = 0;
      if (block) return c;
    }
    for (let i = 0; i < order.length; i += 1) if (canDrop(order[i])) return order[i];
    return 0;
  }
  function play(col) {
    const c = Number(col);
    if (winner) { msg = "Game is over. Start new game."; return; }
    if (!canDrop(c)) { msg = "Cannot drop there."; return; }
    const y = drop(c, turn);
    if (wonAt(c, y, turn)) {
      winner = turn;
      msg = (turn === 1 ? "Red" : "Yellow") + " wins!";
      return;
    }
    if (full()) {
      winner = 3;
      msg = "Draw game.";
      return;
    }
    turn = turn === 1 ? 2 : 1;
    msg = "Dropped to column " + (c + 1) + ".";
    if (mode === "ai" && turn === 2 && !winner) {
      const aiCol = aiPick();
      if (canDrop(aiCol)) {
        const aiY = drop(aiCol, 2);
        if (wonAt(aiCol, aiY, 2)) {
          winner = 2;
          msg = "Yellow (AI) wins!";
          return;
        }
        if (full()) {
          winner = 3;
          msg = "Draw game.";
          return;
        }
        turn = 1;
        msg = "AI dropped to column " + (aiCol + 1) + ".";
      }
    }
  }
  function encode() {
    return board.map(function(r){ return r.join(""); }).join("/");
  }
  function render(note) {
    api.updatePanelState(panelId, {
      markdown: "## Connect Four",
      stats: {
        mode: mode,
        turn: turn === 1 ? "red" : "yellow",
        winner: winner === 0 ? "-" : (winner === 1 ? "red" : (winner === 2 ? "yellow" : "draw")),
        _turn: turn,
        _c4: encode()
      },
      items: [note || msg],
      actions: [
        { label: "Drop 1", command: manifest.id + ".drop", args: [0] },
        { label: "Drop 2", command: manifest.id + ".drop", args: [1] },
        { label: "Drop 3", command: manifest.id + ".drop", args: [2] },
        { label: "Drop 4", command: manifest.id + ".drop", args: [3] },
        { label: "Drop 5", command: manifest.id + ".drop", args: [4] },
        { label: "Drop 6", command: manifest.id + ".drop", args: [5] },
        { label: "Drop 7", command: manifest.id + ".drop", args: [6] },
        { label: mode === "ai" ? "Mode: AI" : "Mode: 2P", command: manifest.id + ".mode" },
        { label: "New", command: manifest.id + ".new" }
      ]
    });
  }
  function setMode(next) {
    const n = String(next || "").toLowerCase();
    if (n === "ai" || n === "2p") mode = n;
    else mode = mode === "ai" ? "2p" : "ai";
    api.storage.set("mode", mode);
  }
  reset();
  api.registerPanel({ id: panelId, title: "Connect Four" });
  render("Ready.");
  api.registerCommand({ command: manifest.id + ".open", title: "Open Connect Four" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".drop", title: "Drop disc to column" }, function(col){ play(Number(col) || 0); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".mode", title: "Toggle Connect Four mode" }, function(next){ setMode(next); reset(); render("Mode: " + mode); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".new", title: "New Connect Four game" }, function(){ reset(); render("New game."); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.calendar-planner": `
function activate(api, manifest) {
  var panelId = manifest.id + ".panel";
  var now = new Date(api.now());
  var viewYear = Number(api.storage.get("viewYear")) || now.getFullYear();
  var viewMonth = Number(api.storage.get("viewMonth"));
  if (!viewMonth && viewMonth !== 0) viewMonth = now.getMonth();
  var events = api.storage.get("calEvents");
  if (!events || typeof events !== "object") events = {};
  function save(){ api.storage.set("viewYear", viewYear); api.storage.set("viewMonth", viewMonth); api.storage.set("calEvents", events); }
  function dk(y,m,d){ return y+"-"+(m<9?"0":"")+(m+1)+"-"+(d<10?"0":"")+d; }
  function daysInMonth(y,m){ return new Date(y,m+1,0).getDate(); }
  function firstDow(y,m){ return new Date(y,m,1).getDay(); }
  function render() {
    var today = new Date(api.now());
    var todayKey = dk(today.getFullYear(), today.getMonth(), today.getDate());
    var dim = daysInMonth(viewYear, viewMonth);
    var fd = firstDow(viewYear, viewMonth);
    var cells = [];
    for (var b = 0; b < fd; b++) cells.push("_");
    for (var d = 1; d <= dim; d++) {
      var key = dk(viewYear, viewMonth, d);
      var ev = events[key];
      var flag = key === todayKey ? "T" : "";
      if (ev && ev.length) { cells.push(flag + d + ":" + ev.length); } else { cells.push(flag + d); }
    }
    var monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var selKey = String(api.storage.get("selDate") || todayKey);
    var selEvents = events[selKey] || [];
    var selItems = selEvents.map(function(e, idx){ return (e.done ? "[x] " : "[ ] ") + e.time + " " + e.text + " #" + (idx+1); });
    api.updatePanelState(panelId, {
      markdown: "## " + monthNames[viewMonth] + " " + viewYear,
      stats: { year: viewYear, month: viewMonth + 1, today: todayKey, selected: selKey, totalEvents: Object.keys(events).reduce(function(a,k){ return a + (events[k]||[]).length; }, 0) },
      items: ["GRID:" + cells.join(","), "SEL:" + selKey].concat(selItems),
      actions: []
    });
  }
  api.registerPanel({ id: panelId, title: "Calendar Planner" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Calendar" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".prevMonth", title: "Previous month" }, function(){ viewMonth--; if (viewMonth<0){viewMonth=11;viewYear--;} save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".nextMonth", title: "Next month" }, function(){ viewMonth++; if (viewMonth>11){viewMonth=0;viewYear++;} save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".selectDate", title: "Select date" }, function(key){ api.storage.set("selDate", String(key)); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add event" }, function(time, text){ var key = String(api.storage.get("selDate") || dk(new Date(api.now()).getFullYear(), new Date(api.now()).getMonth(), new Date(api.now()).getDate())); if (!events[key]) events[key]=[]; events[key].push({ time: String(time||"09:00"), text: String(text||"Event"), done: false }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".toggle", title: "Toggle event" }, function(idx){ var key = String(api.storage.get("selDate")); if (events[key] && events[key][Number(idx)]) events[key][Number(idx)].done = !events[key][Number(idx)].done; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove event" }, function(idx){ var key = String(api.storage.get("selDate")); if (events[key]) { events[key].splice(Number(idx), 1); if (!events[key].length) delete events[key]; } save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".goToday", title: "Go to today" }, function(){ var t = new Date(api.now()); viewYear=t.getFullYear(); viewMonth=t.getMonth(); api.storage.set("selDate", dk(viewYear, viewMonth, t.getDate())); save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.goal-tracker-pro": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let goals = api.storage.get("goals");
  if (!Array.isArray(goals)) goals = [{ name: "Ship extension pack", progress: 35 }, { name: "Test AI game modes", progress: 10 }];
  function save(){ api.storage.set("goals", goals); }
  function pct(){ if (!goals.length) return 0; return Math.round(goals.reduce(function(a,g){ return a + Number(g.progress||0); }, 0) / goals.length); }
  function render(note){
    api.updatePanelState(panelId, {
      markdown: "## Goal Tracker Pro",
      stats: { goals: goals.length, avgProgress: pct() + "%" },
      items: [note || "Track milestones."] .concat(goals.map(function(g, idx){ return (idx + 1) + ". " + g.name + " [" + g.progress + "%]"; })),
      actions: [
        { label: "Add Goal", command: manifest.id + ".add", args: ["New Goal"] },
        { label: "Goal1 +10%", command: manifest.id + ".inc", args: [0, 10] },
        { label: "Goal2 +10%", command: manifest.id + ".inc", args: [1, 10] },
        { label: "Goal1 -10%", command: manifest.id + ".inc", args: [0, -10] },
        { label: "Archive done", command: manifest.id + ".archive" },
        { label: "Reset", command: manifest.id + ".reset" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Goal Tracker Pro" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Goal Tracker Pro" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add goal item" }, function(name){ goals.push({ name: String(name||"Goal"), progress: 0 }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".inc", title: "Increase goal progress" }, function(idx, step){ const i = Number(idx)||0; if (goals[i]) goals[i].progress = Math.max(0, Math.min(100, Number(goals[i].progress||0) + (Number(step)||10))); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove goal item" }, function(idx){ const i = Number(idx)||0; if (i >= 0 && i < goals.length) goals.splice(i, 1); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".archive", title: "Archive completed goals" }, function(){ goals = goals.filter(function(g){ return Number(g.progress || 0) < 100; }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".reset", title: "Reset all goals" }, function(){ for (let i=0;i<goals.length;i+=1) goals[i].progress = 0; save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.time-blocker": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let blocks = api.storage.get("blocks");
  if (!Array.isArray(blocks)) blocks = [{ range:"09:00-10:30", title:"Code" }, { range:"14:00-15:00", title:"Review" }];
  function save(){ api.storage.set("blocks", blocks); }
  function render(note){
    blocks.sort(function(a,b){ return String(a.range).localeCompare(String(b.range)); });
    api.updatePanelState(panelId, {
      markdown: "## Time Blocker",
      stats: { blocks: blocks.length, focusHours: blocks.reduce(function(acc, b){
        const m = String(b.range || "").match(/^(\\d\\d):(\\d\\d)-(\\d\\d):(\\d\\d)$/);
        if (!m) return acc;
        const start = Number(m[1]) * 60 + Number(m[2]);
        const end = Number(m[3]) * 60 + Number(m[4]);
        return acc + Math.max(0, end - start);
      }, 0) + "m" },
      items: [note || "Manage focus blocks."] .concat(blocks.map(function(b){ return b.range + " " + b.title; })),
      actions: [
        { label: "Add 16:00-17:00", command: manifest.id + ".add", args: ["16:00-17:00", "Deep Work"] },
        { label: "Add 11:30-12:00", command: manifest.id + ".add", args: ["11:30-12:00", "Inbox"] },
        { label: "Sort", command: manifest.id + ".sort" },
        { label: "Clear", command: manifest.id + ".clear" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Time Blocker" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Time Blocker" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add time block" }, function(range, title){ blocks.push({ range:String(range||"00:00-01:00"), title:String(title||"Task") }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".sort", title: "Sort time blocks" }, function(){ blocks.sort(function(a,b){ return String(a.range).localeCompare(String(b.range)); }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove time block" }, function(idx){ const i = Number(idx)||0; if (i >= 0 && i < blocks.length) blocks.splice(i, 1); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear time blocks" }, function(){ blocks = []; save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.weekly-review": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let wins = api.storage.get("wins");
  let learns = api.storage.get("learns");
  let next = api.storage.get("next");
  if (!Array.isArray(wins)) wins = ["Fixed runtime bug"];
  if (!Array.isArray(learns)) learns = ["Need stronger tests"];
  if (!Array.isArray(next)) next = ["Ship v0.4"];
  function save(){ api.storage.set("wins", wins); api.storage.set("learns", learns); api.storage.set("next", next); }
  function render(note){
    api.updatePanelState(panelId, {
      markdown: "## Weekly Review",
      stats: { wins: wins.length, learns: learns.length, next: next.length },
      items: [note || "Reflect and plan.", "Wins: " + wins.join(" | "), "Learns: " + learns.join(" | "), "Next: " + next.join(" | ")],
      actions: [
        { label: "Add Win", command: manifest.id + ".w", args: ["Completed high-priority task"] },
        { label: "Add Learn", command: manifest.id + ".l", args: ["Identify root cause faster"] },
        { label: "Add Next", command: manifest.id + ".n", args: ["Prepare next sprint goals"] },
        { label: "Generate Summary", command: manifest.id + ".summary" },
        { label: "Clear", command: manifest.id + ".clear" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Weekly Review" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Weekly Review" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".w", title: "Add weekly win" }, function(t){ wins.push(String(t||"win")); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".l", title: "Add weekly learning" }, function(t){ learns.push(String(t||"learn")); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".n", title: "Add next week plan" }, function(t){ next.push(String(t||"next")); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".addTyped", title: "Add typed weekly item" }, function(kind, text){
    const k = String(kind || "").toLowerCase();
    const t = String(text || "").trim();
    if (!t) return { openPanelId: panelId };
    if (k === "wins" || k === "win" || k === "w") wins.push(t);
    else if (k === "learns" || k === "learn" || k === "l") learns.push(t);
    else next.push(t);
    save();
    render();
    return { openPanelId: panelId };
  });
  api.registerCommand({ command: manifest.id + ".summary", title: "Generate weekly summary" }, function(){
    const text = "Summary: " + wins.length + " wins / " + learns.length + " learns / " + next.length + " next actions";
    render(text);
    return { openPanelId: panelId, message: text };
  });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear weekly review" }, function(){ wins=[]; learns=[]; next=[]; save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.meeting-notes": `
function activate(api, manifest) {
  const panelId = manifest.id + ".panel";
  let meetings = api.storage.get("meetings");
  if (!Array.isArray(meetings)) meetings = [{ title: "Weekly Sync", notes: ["Agenda", "Decisions", "Action items"] }];
  let active = Number(api.storage.get("active") || 0);
  function cur(){ if (!meetings[active]) active = 0; return meetings[active]; }
  function save(){ api.storage.set("meetings", meetings); api.storage.set("active", active); }
  function render(note){
    const m = cur();
    api.updatePanelState(panelId, {
      markdown: "## Meeting Notes",
      stats: { meeting: m.title, lines: m.notes.length, docs: meetings.length },
      items: [note || "Capture structured meeting notes."].concat(m.notes),
      actions: [
        { label: "Add timestamp", command: manifest.id + ".add" },
        { label: "New Meeting", command: manifest.id + ".newMeeting", args: ["Meeting@" + new Date(api.now()).toLocaleDateString()] },
        { label: "Next Meeting", command: manifest.id + ".nextMeeting" },
        { label: "Template", command: manifest.id + ".template" },
        { label: "Clear", command: manifest.id + ".clear" }
      ]
    });
  }
  api.registerPanel({ id: panelId, title: "Meeting Notes" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Meeting Notes" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add meeting note line" }, function(){ cur().notes.push("- " + new Date(api.now()).toLocaleTimeString() + " "); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".newMeeting", title: "Create meeting notes document" }, function(title){ meetings.push({ title: String(title || ("Meeting " + (meetings.length + 1))), notes: ["Agenda", "Decisions", "Action items"] }); active = meetings.length - 1; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".nextMeeting", title: "Switch active meeting notes document" }, function(){ active = (active + 1) % meetings.length; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".append", title: "Append custom meeting note line" }, function(text){ const t = String(text || "").trim(); if (t) { cur().notes.push(t); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove meeting note line" }, function(idx){ const i = Number(idx)||0; if (i >= 0 && i < cur().notes.length) { cur().notes.splice(i, 1); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".template", title: "Reset meeting note template" }, function(){ cur().notes=["Agenda","Decisions","Action items","Risks"]; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".clear", title: "Clear meeting notes" }, function(){ cur().notes=[]; save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.notion-notes": `
function activate(api, manifest) {
  var panelId = manifest.id + ".panel";
  var pages = api.storage.get("pages");
  if (!Array.isArray(pages) || !pages.length) pages = [{ id: "p1", title: "Welcome", icon: "📝", blocks: [{ type: "h1", text: "Welcome to Notion Notes" }, { type: "p", text: "A rich block-based note-taking tool." }, { type: "todo", text: "Try adding blocks", done: false }, { type: "todo", text: "Create new pages", done: true }, { type: "divider" }, { type: "quote", text: "Organize your thoughts." }], pinned: false, createdAt: api.now(), updatedAt: api.now() }];
  var activeIdx = Number(api.storage.get("activeIdx")) || 0;
  if (activeIdx >= pages.length) activeIdx = 0;
  function save(){ api.storage.set("pages", pages); api.storage.set("activeIdx", activeIdx); }
  function cur(){ return pages[activeIdx] || pages[0]; }
  function render() {
    var p = cur();
    var pageList = pages.map(function(pg, i){ return (i === activeIdx ? ">" : " ") + (pg.pinned ? "★ " : "  ") + pg.icon + " " + pg.title; });
    var blockLines = p.blocks.map(function(b, i){
      if (b.type === "h1") return "H1|" + i + "|" + b.text;
      if (b.type === "h2") return "H2|" + i + "|" + b.text;
      if (b.type === "h3") return "H3|" + i + "|" + b.text;
      if (b.type === "todo") return "TODO|" + i + "|" + (b.done ? "1" : "0") + "|" + b.text;
      if (b.type === "bullet") return "BULLET|" + i + "|" + b.text;
      if (b.type === "quote") return "QUOTE|" + i + "|" + b.text;
      if (b.type === "code") return "CODE|" + i + "|" + b.text;
      if (b.type === "divider") return "DIVIDER|" + i;
      return "P|" + i + "|" + (b.text || "");
    });
    api.updatePanelState(panelId, {
      markdown: p.icon + " " + p.title,
      stats: { pages: pages.length, blocks: p.blocks.length, updated: new Date(p.updatedAt).toLocaleDateString() },
      items: ["PAGES:"].concat(pageList).concat(["BLOCKS:"]).concat(blockLines),
      actions: []
    });
  }
  api.registerPanel({ id: panelId, title: "Notion Notes" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Notion Notes" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".selectPage", title: "Select page" }, function(idx){ activeIdx = Math.max(0, Math.min(pages.length - 1, Number(idx)||0)); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".newPage", title: "New page" }, function(title, icon){ pages.push({ id: "p" + Date.now(), title: String(title || "Untitled"), icon: String(icon || "📄"), blocks: [{ type: "p", text: "" }], pinned: false, createdAt: api.now(), updatedAt: api.now() }); activeIdx = pages.length - 1; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".deletePage", title: "Delete page" }, function(){ if (pages.length <= 1) return { openPanelId: panelId }; pages.splice(activeIdx, 1); if (activeIdx >= pages.length) activeIdx = pages.length - 1; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".setTitle", title: "Set page title" }, function(t){ cur().title = String(t || "Untitled"); cur().updatedAt = api.now(); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".addBlock", title: "Add block" }, function(type, text){ cur().blocks.push({ type: String(type || "p"), text: String(text || ""), done: false }); cur().updatedAt = api.now(); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".editBlock", title: "Edit block text" }, function(idx, text){ var b = cur().blocks[Number(idx)]; if (b) { b.text = String(text); cur().updatedAt = api.now(); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".toggleTodo", title: "Toggle todo" }, function(idx){ var b = cur().blocks[Number(idx)]; if (b && b.type === "todo") { b.done = !b.done; cur().updatedAt = api.now(); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".removeBlock", title: "Remove block" }, function(idx){ var i = Number(idx); if (i >= 0 && i < cur().blocks.length) { cur().blocks.splice(i, 1); cur().updatedAt = api.now(); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".moveBlock", title: "Move block up" }, function(idx){ var i = Number(idx); if (i > 0 && i < cur().blocks.length) { var tmp = cur().blocks[i]; cur().blocks[i] = cur().blocks[i-1]; cur().blocks[i-1] = tmp; cur().updatedAt = api.now(); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".togglePin", title: "Toggle pin" }, function(){ cur().pinned = !cur().pinned; save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".duplicatePage", title: "Duplicate page" }, function(){ var cp = JSON.parse(JSON.stringify(cur())); cp.id = "p" + Date.now(); cp.title += " (copy)"; cp.createdAt = api.now(); cp.updatedAt = api.now(); pages.push(cp); activeIdx = pages.length - 1; save(); render(); return { openPanelId: panelId }; });
}
`,
  "builtin:productivity.paper-manager": `
function activate(api, manifest) {
  var panelId = manifest.id + ".panel";
  var papers = api.storage.get("papers");
  if (!Array.isArray(papers)) papers = [
    { id: 1, title: "Attention Is All You Need", authors: "Vaswani et al.", year: 2017, venue: "NeurIPS", tags: ["transformer","attention"], status: "read", rating: 5, notes: "Foundational transformer paper.", addedAt: api.now() },
    { id: 2, title: "BERT: Pre-training of Deep Bidirectional Transformers", authors: "Devlin et al.", year: 2019, venue: "NAACL", tags: ["nlp","pretraining"], status: "reading", rating: 4, notes: "", addedAt: api.now() },
    { id: 3, title: "ResNet: Deep Residual Learning", authors: "He et al.", year: 2016, venue: "CVPR", tags: ["vision","cnn"], status: "unread", rating: 0, notes: "", addedAt: api.now() }
  ];
  var nextId = papers.reduce(function(m,p){ return Math.max(m, p.id||0); }, 0) + 1;
  var filterTag = String(api.storage.get("filterTag") || "");
  var filterStatus = String(api.storage.get("filterStatus") || "");
  var sortBy = String(api.storage.get("sortBy") || "addedAt");
  function save(){ api.storage.set("papers", papers); api.storage.set("filterTag", filterTag); api.storage.set("filterStatus", filterStatus); api.storage.set("sortBy", sortBy); }
  function filtered() {
    var r = papers.slice();
    if (filterTag) r = r.filter(function(p){ return (p.tags||[]).indexOf(filterTag) >= 0; });
    if (filterStatus) r = r.filter(function(p){ return p.status === filterStatus; });
    r.sort(function(a,b){
      if (sortBy === "year") return (b.year||0) - (a.year||0);
      if (sortBy === "rating") return (b.rating||0) - (a.rating||0);
      if (sortBy === "title") return String(a.title).localeCompare(String(b.title));
      return (b.addedAt||0) - (a.addedAt||0);
    });
    return r;
  }
  function allTags(){ var s = {}; papers.forEach(function(p){ (p.tags||[]).forEach(function(t){ s[t]=1; }); }); return Object.keys(s).sort(); }
  function hasPdf(id) { return !!api.storage.get("pdf_" + id); }
  function render() {
    var fp = filtered();
    var lines = fp.map(function(p){
      return "PJ:" + JSON.stringify({ id:p.id, status:p.status, rating:p.rating||0, year:p.year, authors:p.authors, title:p.title, venue:p.venue||"", tags:p.tags||[], notes:p.notes||"", hasPdf:hasPdf(p.id) });
    });
    var stats = { total: papers.length, read: papers.filter(function(p){return p.status==="read";}).length, reading: papers.filter(function(p){return p.status==="reading";}).length, unread: papers.filter(function(p){return p.status==="unread";}).length };
    api.updatePanelState(panelId, {
      markdown: "## Paper Manager",
      stats: stats,
      items: ["TAGS:" + allTags().join(","), "FILTER_TAG:" + filterTag, "FILTER_STATUS:" + filterStatus, "SORT:" + sortBy].concat(lines),
      actions: []
    });
  }
  api.registerPanel({ id: panelId, title: "Paper Manager" });
  render();
  api.registerCommand({ command: manifest.id + ".open", title: "Open Paper Manager" }, function(){ render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".add", title: "Add paper" }, function(title, authors, year, venue){ papers.push({ id: nextId++, title: String(title||"Untitled"), authors: String(authors||""), year: Number(year)||new Date(api.now()).getFullYear(), venue: String(venue||""), tags: [], status: "unread", rating: 0, notes: "", addedAt: api.now() }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".remove", title: "Remove paper" }, function(id){ api.storage.set("pdf_" + Number(id), null); papers = papers.filter(function(p){ return p.id !== Number(id); }); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".setStatus", title: "Set status" }, function(id, status){ var p = papers.find(function(p){return p.id===Number(id);}); if (p) { p.status = String(status||"unread"); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".setRating", title: "Set rating" }, function(id, r){ var p = papers.find(function(p){return p.id===Number(id);}); if (p) { p.rating = Math.max(0, Math.min(5, Number(r)||0)); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".addTag", title: "Add tag" }, function(id, tag){ var p = papers.find(function(p){return p.id===Number(id);}); if (p && tag) { if ((p.tags||[]).indexOf(String(tag))<0) { p.tags = (p.tags||[]).concat([String(tag)]); save(); render(); } } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".removeTag", title: "Remove tag" }, function(id, tag){ var p = papers.find(function(p){return p.id===Number(id);}); if (p) { p.tags = (p.tags||[]).filter(function(t){return t!==String(tag);}); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".setNotes", title: "Set notes" }, function(id, text){ var p = papers.find(function(p){return p.id===Number(id);}); if (p) { p.notes = String(text||""); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".setMeta", title: "Set paper metadata" }, function(id, title, authors, year, venue){ var p = papers.find(function(p){return p.id===Number(id);}); if (p) { if (title) p.title = String(title); if (authors) p.authors = String(authors); if (year) p.year = Number(year)||p.year; if (venue) p.venue = String(venue); save(); render(); } return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".attachPdf", title: "Attach PDF data" }, function(id, dataUrl){ api.storage.set("pdf_" + Number(id), String(dataUrl||"")); render(); return { openPanelId: panelId, message: "PDF attached." }; });
  api.registerCommand({ command: manifest.id + ".removePdf", title: "Remove PDF" }, function(id){ api.storage.set("pdf_" + Number(id), null); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".getPdf", title: "Get PDF data URL" }, function(id){ return { openPanelId: panelId, message: "PDF_DATA:" + String(api.storage.get("pdf_" + Number(id)) || "") }; });
  api.registerCommand({ command: manifest.id + ".filterTag", title: "Filter by tag" }, function(tag){ filterTag = String(tag||""); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".filterStatus", title: "Filter by status" }, function(s){ filterStatus = String(s||""); save(); render(); return { openPanelId: panelId }; });
  api.registerCommand({ command: manifest.id + ".sort", title: "Sort papers" }, function(by){ sortBy = String(by||"addedAt"); save(); render(); return { openPanelId: panelId }; });
}
`
};

export function resolveBuiltinEntry(entryId: string): string | null {
  return entries[entryId] ?? null;
}
