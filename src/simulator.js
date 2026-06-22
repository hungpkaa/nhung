const API_BASE = process.env.API_BASE || "http://localhost:3000";
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 10000);

const state = {
  soil: 48,
  temperature: 29,
  airHumidity: 68,
  light: 60,
  waterLevel: 82,
  pump: false,
  buzzer: false,
  growLight: false,
  systemOn: true,
  mode: "AUTO",
  manualPump: false,
  pumpStartedAt: 0,
  lightTrend: 1,
  waterLowTicks: 0,
  pumpCooldownTicks: 0,
  lastScenario: "none",
  lastAction: ""
};

const defaults = {
  dryThreshold: 35,
  wetThreshold: 75,
  lightThreshold: 25,
  waterLowThreshold: 20,
  maxPumpTime: 10
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function noise(amount) {
  return Math.random() * amount * 2 - amount;
}

function approach(current, target, factor) {
  return current + (target - current) * factor;
}

async function api(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return response.json();
}

async function readControl() {
  const control = await api("/api/control");
  state.systemOn = Boolean(control.systemOn);
  state.mode = control.mode || "AUTO";
  state.manualPump = Boolean(control.manualPump);
  return {
    settings: control.settings || defaults,
    scenario: control.scenario?.name || "none"
  };
}

async function clearScenario() {
  await api("/api/scenario", {
    method: "POST",
    body: JSON.stringify({ name: "none" })
  });
}

function balanceTarget(settings) {
  return clamp(settings.dryThreshold + 12, settings.dryThreshold + 5, settings.wetThreshold - 8);
}

function resetScenarioRuntime() {
  state.manualPump = false;
  state.pump = false;
  state.buzzer = false;
  state.growLight = false;
  state.pumpStartedAt = 0;
  state.waterLowTicks = 0;
  state.pumpCooldownTicks = 0;
}

function applyScenario(name, settings) {
  if (!name || name === "none" || name === state.lastScenario) return;

  state.systemOn = true;
  state.mode = "AUTO";
  resetScenarioRuntime();

  if (name === "dry_soil") {
    state.soil = clamp(settings.dryThreshold - 7, 5, 100);
    state.waterLevel = clamp(settings.waterLowThreshold + 55, 0, 100);
    state.light = 62;
    state.lastAction = "Kịch bản demo: đất bị khô nhanh";
  }

  if (name === "low_water") {
    state.soil = balanceTarget(settings);
    state.light = 62;
    state.waterLevel = clamp(settings.waterLowThreshold - 4, 0, 100);
    state.lastAction = "Kịch bản demo: bình chứa thiếu nước";
  }

  if (name === "low_light") {
    state.soil = balanceTarget(settings);
    state.waterLevel = clamp(settings.waterLowThreshold + 55, 0, 100);
    state.light = clamp(settings.lightThreshold - 14, 5, 100);
    state.lightTrend = 1;
    state.lastAction = "Kịch bản demo: ánh sáng yếu";
  }

  if (name === "reset_environment") {
    state.soil = 50;
    state.temperature = 29;
    state.airHumidity = 68;
    state.light = 60;
    state.waterLevel = 82;
    state.lastAction = "Đã reset môi trường về trạng thái ổn định";
  }

  state.lastScenario = name;
}

function updateLight(settings) {
  if (state.light >= 92) state.lightTrend = -1;
  if (state.light <= 10) state.lightTrend = 1;

  const naturalChange = state.lightTrend * 1.4 + noise(0.8);
  const growLightBoost = state.systemOn && state.growLight ? 4.5 : 0;
  state.light = clamp(state.light + naturalChange + growLightBoost, 5, 100);
  state.growLight = state.systemOn && state.light <= settings.lightThreshold;
}

function updateClimate() {
  const targetTemperature = 24 + state.light * 0.11;
  state.temperature = clamp(approach(state.temperature, targetTemperature, 0.18) + noise(0.12), 22, 38);

  const targetAirHumidity = 88 - state.temperature * 0.9 + (state.soil - 50) * 0.1;
  state.airHumidity = clamp(approach(state.airHumidity, targetAirHumidity, 0.18) + noise(0.25), 35, 95);
}

function updateWaterRecovery(settings) {
  if (state.waterLevel > settings.waterLowThreshold) {
    state.waterLowTicks = 0;
    return null;
  }

  state.waterLowTicks += 1;
  state.pump = false;

  if (state.waterLowTicks >= 3) {
    state.waterLevel = clamp(settings.waterLowThreshold + 45 + noise(1.5), 0, 100);
    state.waterLowTicks = 0;
    return "Đã bổ sung nước vào bình";
  }

  return "Bình thiếu nước, đang chờ bổ sung";
}

function decidePump(settings) {
  if (!state.systemOn) {
    state.pump = false;
    return "Hệ thống đang tắt";
  }

  if (state.pumpCooldownTicks > 0) {
    state.pump = false;
    state.pumpCooldownTicks -= 1;
    return "Bảo vệ bơm: đang chờ ổn định";
  }

  if (state.waterLevel <= settings.waterLowThreshold) {
    state.pump = false;
    return "Bình thiếu nước, đang chờ bổ sung";
  }

  if (state.mode === "MANUAL") {
    state.pump = state.manualPump;
    return state.pump ? "Bơm thủ công đang chạy" : "Chế độ thủ công sẵn sàng";
  }

  const target = balanceTarget(settings);
  if (state.soil <= settings.dryThreshold) {
    state.pump = true;
    return "Đang tưới để đưa đất về vùng cân bằng";
  }

  if (state.pump && state.soil < target) return "Đang tưới để đưa đất về vùng cân bằng";

  if (state.pump && state.soil >= target) {
    state.pump = false;
    return "Đất đã đủ ẩm, bơm đã tắt";
  }

  if (state.soil >= settings.wetThreshold) {
    state.pump = false;
    return "Đất quá ẩm, bơm đã tắt";
  }

  return "Độ ẩm đất đang phù hợp";
}

function enforcePumpRuntime(settings, status) {
  if (state.pump && !state.pumpStartedAt) state.pumpStartedAt = Date.now();

  if (!state.pump) {
    state.pumpStartedAt = 0;
    return status;
  }

  const maxRuntimeMs = Math.max(settings.maxPumpTime * 1000, INTERVAL_MS * 4);
  if (Date.now() - state.pumpStartedAt > maxRuntimeMs) {
    state.pump = false;
    state.buzzer = true;
    state.pumpStartedAt = 0;
    state.pumpCooldownTicks = 1;
    return "Bảo vệ bơm: quá thời gian giới hạn";
  }

  return status;
}

function updateSoilAndWater() {
  if (state.pump) {
    state.soil = clamp(state.soil + 5.4 + noise(0.5), 0, 100);
    state.waterLevel = clamp(state.waterLevel - 1.9 + noise(0.12), 0, 100);
    return;
  }

  const dryingByLight = state.light > 70 ? 0.55 : 0.25;
  const dryingByHeat = state.temperature > 30 ? 0.45 : 0.15;
  state.soil = clamp(state.soil - 0.75 - dryingByLight - dryingByHeat + noise(0.2), 0, 100);
  state.waterLevel = clamp(state.waterLevel - 0.06 + noise(0.02), 0, 100);
}

function updateAlerts(settings) {
  state.growLight = state.systemOn && state.light <= settings.lightThreshold;
  state.buzzer =
    state.systemOn &&
    (state.waterLevel <= settings.waterLowThreshold ||
      state.soil <= settings.dryThreshold ||
      state.soil >= settings.wetThreshold ||
      state.pumpCooldownTicks > 0);
}

function finalStatus(settings, status) {
  if (!state.systemOn) return "Hệ thống đang tắt";
  if (state.lastAction) return state.lastAction;
  if (status.startsWith("Bảo vệ bơm")) return status;
  if (state.waterLevel <= settings.waterLowThreshold) return "Bình thiếu nước, đang chờ bổ sung";
  if (state.mode === "MANUAL") return status;
  if (state.growLight) return "Đèn cây đang bù ánh sáng yếu";
  if (state.pump) return "Đang tưới để đưa đất về vùng cân bằng";
  if (state.soil <= settings.dryThreshold) return "Đất quá khô, bơm đang chạy";
  if (state.soil >= settings.wetThreshold) return "Đất quá ẩm, bơm đã tắt";
  return status;
}

function updateEnvironment(settings, scenario) {
  state.lastAction = "";
  applyScenario(scenario, settings);

  updateLight(settings);
  updateClimate();

  const recoveryStatus = updateWaterRecovery(settings);
  if (recoveryStatus) state.lastAction = recoveryStatus;

  let status = recoveryStatus || decidePump(settings);
  status = enforcePumpRuntime(settings, status);

  updateSoilAndWater();
  updateAlerts(settings);

  return finalStatus(settings, status);
}

async function tick() {
  const { settings, scenario } = await readControl();
  const status = updateEnvironment(settings, scenario);

  if (scenario && scenario !== "none") {
    await clearScenario();
  } else if (scenario === "none") {
    state.lastScenario = "none";
  }

  const payload = {
    soil: Number(state.soil.toFixed(1)),
    temperature: Number(state.temperature.toFixed(1)),
    airHumidity: Number(state.airHumidity.toFixed(1)),
    light: Number(state.light.toFixed(1)),
    waterLevel: Number(state.waterLevel.toFixed(1)),
    pump: state.pump,
    buzzer: state.buzzer,
    growLight: state.growLight,
    systemOn: state.systemOn,
    mode: state.mode,
    status
  };

  const result = await api("/api/sensor", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  console.log(
    `[SIM] id=${result.data.id} đất=${payload.soil}% nhiệt=${payload.temperature}°C nước=${payload.waterLevel}% bơm=${payload.pump ? "BẬT" : "TẮT"} chế_độ=${payload.mode} | ${payload.status}`
  );
}

async function main() {
  console.log(`[SIM] Bộ mô phỏng Smart Garden đang gửi dữ liệu tới ${API_BASE}`);
  await tick();
  setInterval(() => {
    tick().catch((error) => console.error(`[SIM] ${error.message}`));
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error(`[SIM] ${error.message}`);
  process.exit(1);
});
