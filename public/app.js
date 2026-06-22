const state = {
  systemOn: true,
  mode: "AUTO",
  manualPump: false,
  chart: null
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  insightPanel: document.querySelector("#insightPanel"),
  smartStatus: document.querySelector("#smartStatus"),
  temperature: document.querySelector("#temperature"),
  airHumidity: document.querySelector("#airHumidity"),
  soil: document.querySelector("#soil"),
  light: document.querySelector("#light"),
  waterLevel: document.querySelector("#waterLevel"),
  systemState: document.querySelector("#systemState"),
  modeState: document.querySelector("#modeState"),
  pumpState: document.querySelector("#pumpState"),
  buzzerState: document.querySelector("#buzzerState"),
  growLightState: document.querySelector("#growLightState"),
  pumpActivations: document.querySelector("#pumpActivations"),
  drySoilAlerts: document.querySelector("#drySoilAlerts"),
  lowWaterAlerts: document.querySelector("#lowWaterAlerts"),
  lowLightAlerts: document.querySelector("#lowLightAlerts"),
  lastUpdated: document.querySelector("#lastUpdated"),
  alerts: document.querySelector("#alerts"),
  systemToggle: document.querySelector("#systemToggle"),
  autoMode: document.querySelector("#autoMode"),
  manualMode: document.querySelector("#manualMode"),
  pumpToggle: document.querySelector("#pumpToggle"),
  settingsForm: document.querySelector("#settingsForm")
};

const settingFields = [
  "dryThreshold",
  "wetThreshold",
  "lightThreshold",
  "waterLowThreshold",
  "maxPumpTime"
];

const settingMeta = {
  dryThreshold: { label: "Ngưỡng đất khô", min: 0, max: 100 },
  wetThreshold: { label: "Ngưỡng đất quá ẩm", min: 0, max: 100 },
  lightThreshold: { label: "Ngưỡng ánh sáng yếu", min: 0, max: 100 },
  waterLowThreshold: { label: "Cảnh báo thiếu nước", min: 0, max: 100 },
  maxPumpTime: { label: "Giới hạn bơm", min: 1, max: 300 }
};

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function fmt(value, digits = 1) {
  if (value === null || value === undefined) return "--";
  return Number(value).toFixed(digits);
}

function onOff(value) {
  return value ? "BẬT" : "TẮT";
}

function modeLabel(mode) {
  return mode === "MANUAL" ? "THỦ CÔNG" : "TỰ ĐỘNG";
}

function setConnection(online) {
  els.connectionStatus.textContent = online ? "Đang trực tuyến" : "Mất kết nối";
  els.connectionStatus.classList.toggle("online", online);
  els.connectionStatus.classList.toggle("offline", !online);
}

function setInsight(status, severity = "info") {
  els.smartStatus.textContent = status || "Đang chờ dữ liệu";
  els.insightPanel.classList.remove("stable", "warning", "danger", "info");
  els.insightPanel.classList.add(severity);
}

function syncControls() {
  els.systemToggle.textContent = state.systemOn ? "Tắt hệ thống" : "Bật hệ thống";
  els.systemToggle.classList.toggle("off", !state.systemOn);

  els.autoMode.classList.toggle("active", state.mode === "AUTO");
  els.manualMode.classList.toggle("active", state.mode === "MANUAL");
  els.autoMode.disabled = !state.systemOn;
  els.manualMode.disabled = !state.systemOn;

  els.pumpToggle.disabled = !state.systemOn || state.mode !== "MANUAL";
  els.pumpToggle.textContent = state.manualPump ? "Tắt bơm" : "Bật bơm";
  els.pumpToggle.classList.toggle("on", state.manualPump);
}

function renderLatest(payload) {
  const latest = payload.latest;
  state.systemOn = Boolean(payload.control?.systemOn);
  state.mode = payload.control?.mode || "AUTO";
  state.manualPump = Boolean(payload.control?.manualPump);

  setInsight(payload.status, payload.severity);

  if (latest) {
    els.temperature.textContent = fmt(latest.temperature);
    els.airHumidity.textContent = fmt(latest.airHumidity);
    els.soil.textContent = fmt(latest.soil);
    els.light.textContent = fmt(latest.light);
    els.waterLevel.textContent = fmt(latest.waterLevel);
    els.systemState.textContent = onOff(Boolean(latest.systemOn));
    els.modeState.textContent = modeLabel(latest.mode);
    els.pumpState.textContent = onOff(Boolean(latest.pump));
    els.buzzerState.textContent = onOff(Boolean(latest.buzzer));
    els.growLightState.textContent = onOff(Boolean(latest.growLight));
    els.lastUpdated.textContent = new Date(`${latest.createdAt}Z`).toLocaleString("vi-VN");
  }

  settingFields.forEach((field) => {
    const input = document.querySelector(`#${field}`);
    if (document.activeElement !== input) input.value = payload.settings[field];
  });

  renderAlerts(payload.alerts || []);
  syncControls();
}

function renderSummary(summary) {
  els.pumpActivations.textContent = summary.pumpActivations ?? "--";
  els.drySoilAlerts.textContent = summary.drySoilAlerts ?? "--";
  els.lowWaterAlerts.textContent = summary.lowWaterAlerts ?? "--";
  els.lowLightAlerts.textContent = summary.lowLightAlerts ?? "--";
}

function renderAlerts(alerts) {
  if (!alerts.length) {
    els.alerts.innerHTML = '<div class="alert">Hệ thống đang ổn định</div>';
    return;
  }
  els.alerts.innerHTML = alerts
    .map((alert) => `<div class="alert ${alert.type}">${alert.message}</div>`)
    .join("");
}

function ensureChart() {
  if (state.chart) return state.chart;
  const ctx = document.querySelector("#telemetryChart");
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Độ ẩm đất", data: [], borderColor: "#2f7d4c", tension: 0.35 },
        { label: "Nhiệt độ", data: [], borderColor: "#c74343", tension: 0.35 },
        { label: "Mực nước", data: [], borderColor: "#356ca8", tension: 0.35 },
        { label: "Ánh sáng", data: [], borderColor: "#c28a10", tension: 0.35 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: "index", intersect: false },
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { position: "bottom" } }
    }
  });
  return state.chart;
}

function validateSettingsPayload(payload) {
  for (const field of settingFields) {
    const meta = settingMeta[field];
    const rawValue = String(payload[field]).trim();
    const value = Number(rawValue);

    if (rawValue === "" || !Number.isFinite(value)) {
      return `${meta.label} phải là số`;
    }

    if (value < meta.min || value > meta.max) {
      return `${meta.label} phải trong khoảng ${meta.min}-${meta.max}`;
    }
  }

  if (Number(payload.dryThreshold) >= Number(payload.wetThreshold)) {
    return "Ngưỡng đất khô phải nhỏ hơn ngưỡng đất quá ẩm";
  }

  return "";
}

async function refreshChart() {
  const rows = await api("/api/history?limit=30");
  const chart = ensureChart();
  chart.data.labels = rows.map((row) =>
    new Date(`${row.createdAt}Z`).toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
  );
  chart.data.datasets[0].data = rows.map((row) => row.soil);
  chart.data.datasets[1].data = rows.map((row) => row.temperature);
  chart.data.datasets[2].data = rows.map((row) => row.waterLevel);
  chart.data.datasets[3].data = rows.map((row) => row.light);
  chart.update();
}

let refreshingLatest = false;
let refreshingStats = false;

async function refreshLatest() {
  renderLatest(await api("/api/latest"));
}

async function refreshStats() {
  renderSummary(await api("/api/summary"));
  await refreshChart();
}

async function refreshLatestTick() {
  if (refreshingLatest) return;
  refreshingLatest = true;
  try {
    await refreshLatest();
    setConnection(true);
  } catch (error) {
    console.error(error);
    setConnection(false);
  } finally {
    refreshingLatest = false;
  }
}

async function refreshStatsTick() {
  if (refreshingStats) return;
  refreshingStats = true;
  try {
    await refreshStats();
  } catch (error) {
    console.error(error);
  } finally {
    refreshingStats = false;
  }
}

async function refreshAll() {
  try {
    await refreshLatest();
    await refreshStats();
    setConnection(true);
  } catch (error) {
    console.error(error);
    setConnection(false);
  }
}

async function setControl(next) {
  const data = await api("/api/control", {
    method: "POST",
    body: JSON.stringify({
      systemOn: state.systemOn,
      mode: state.mode,
      manualPump: state.manualPump,
      ...next
    })
  });
  state.systemOn = data.systemOn;
  state.mode = data.mode;
  state.manualPump = data.manualPump;
  syncControls();
  await refreshAll();
}

async function runScenario(name) {
  await api("/api/scenario", {
    method: "POST",
    body: JSON.stringify({ name })
  });
  setInsight("Đã gửi kịch bản demo, simulator sẽ xử lý ở chu kỳ kế tiếp", "info");
}

els.systemToggle.addEventListener("click", () => {
  setControl({ systemOn: !state.systemOn, manualPump: false });
});
els.autoMode.addEventListener("click", () => {
  setControl({ mode: "AUTO", manualPump: false });
});
els.manualMode.addEventListener("click", () => {
  setControl({ mode: "MANUAL" });
});
els.pumpToggle.addEventListener("click", () => {
  setControl({ mode: "MANUAL", manualPump: !state.manualPump });
});

document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => runScenario(button.dataset.scenario));
});

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {};
  settingFields.forEach((field) => {
    payload[field] = document.querySelector(`#${field}`).value;
  });

  const errorMessage = validateSettingsPayload(payload);
  if (errorMessage) {
    setInsight(errorMessage, "danger");
    return;
  }

  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setInsight("Đã lưu ngưỡng mới", "stable");
    await refreshAll();
  } catch (error) {
    setInsight(error.message, "danger");
  }
});

refreshAll();
setInterval(refreshLatestTick, 1000);
setInterval(refreshStatsTick, 1500);
