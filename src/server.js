const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "smart_garden.sqlite");

const DEFAULT_SETTINGS = {
  dryThreshold: 35,
  wetThreshold: 75,
  lightThreshold: 25,
  waterLowThreshold: 20,
  maxPumpTime: 10
};

const DEFAULT_CONTROL = {
  systemOn: true,
  mode: "AUTO",
  manualPump: false
};

const VALID_SCENARIOS = new Set(["none", "dry_soil", "low_water", "low_light", "reset_environment"]);

let db;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isProvided(value) {
  return value !== undefined && value !== null;
}

function parseBoundedNumber(value, min, max, label) {
  if (!isProvided(value) || String(value).trim() === "") {
    throw httpError(400, `${label} là bắt buộc`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw httpError(400, `${label} phải là số`);
  }

  if (number < min || number > max) {
    throw httpError(400, `${label} phải trong khoảng ${min}-${max}`);
  }

  return number;
}

function readAliasedValue(payload, keys, label) {
  for (const key of keys) {
    if (isProvided(payload[key])) return payload[key];
  }

  throw httpError(400, `${label} là bắt buộc`);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toUpperCase() === "ON" || String(value).toLowerCase() === "true";
}

function normalizeMode(mode, fallback = "AUTO") {
  const next = String(mode || fallback).toUpperCase();
  return next === "MANUAL" ? "MANUAL" : "AUTO";
}

function normalizeScenario(value) {
  const scenario = String(value || "none");
  return VALID_SCENARIOS.has(scenario) ? scenario : "none";
}

function normalizeSettings(payload, current = DEFAULT_SETTINGS) {
  const next = {
    dryThreshold: isProvided(payload.dryThreshold ?? payload.soilDryThreshold)
      ? parseBoundedNumber(payload.dryThreshold ?? payload.soilDryThreshold, 0, 100, "Ngưỡng đất khô")
      : current.dryThreshold,
    wetThreshold: isProvided(payload.wetThreshold ?? payload.soilWetThreshold)
      ? parseBoundedNumber(payload.wetThreshold ?? payload.soilWetThreshold, 0, 100, "Ngưỡng đất quá ẩm")
      : current.wetThreshold,
    lightThreshold: isProvided(payload.lightThreshold ?? payload.lightLowThreshold)
      ? parseBoundedNumber(payload.lightThreshold ?? payload.lightLowThreshold, 0, 100, "Ngưỡng ánh sáng yếu")
      : current.lightThreshold,
    waterLowThreshold: isProvided(payload.waterLowThreshold)
      ? parseBoundedNumber(payload.waterLowThreshold, 0, 100, "Ngưỡng thiếu nước")
      : current.waterLowThreshold,
    maxPumpTime: isProvided(payload.maxPumpTime ?? payload.pumpMaxSeconds)
      ? parseBoundedNumber(payload.maxPumpTime ?? payload.pumpMaxSeconds, 1, 300, "Giới hạn bơm")
      : current.maxPumpTime
  };

  if (next.dryThreshold >= next.wetThreshold) {
    throw httpError(400, "Ngưỡng đất khô phải nhỏ hơn ngưỡng đất quá ẩm");
  }

  return next;
}

function buildStatus(reading, settings) {
  if (!reading) return "Đang chờ dữ liệu từ ESP32";
  if (reading.systemOn === 0) return "Hệ thống đang tắt";
  if (reading.waterLevel <= settings.waterLowThreshold) return "Bình chứa sắp hết nước";
  if (reading.soil <= settings.dryThreshold) return "Đất quá khô";
  if (reading.soil >= settings.wetThreshold) return "Đất quá ẩm";
  if (reading.light <= settings.lightThreshold) return "Ánh sáng yếu";
  return "Độ ẩm đất đang phù hợp";
}

function buildAlerts(reading, settings) {
  const alerts = [];
  if (!reading) return alerts;
  if (reading.systemOn === 0) {
    alerts.push({ type: "info", message: "Hệ thống đang tắt" });
    return alerts;
  }
  if (reading.waterLevel <= settings.waterLowThreshold) {
    alerts.push({ type: "danger", message: "Thiếu nước trong bình chứa" });
  }
  if (reading.soil <= settings.dryThreshold) {
    alerts.push({ type: "warning", message: "Đất quá khô" });
  }
  if (reading.soil >= settings.wetThreshold) {
    alerts.push({ type: "info", message: "Đất quá ẩm" });
  }
  if (reading.light <= settings.lightThreshold) {
    alerts.push({ type: "info", message: "Ánh sáng yếu" });
  }
  if (reading.status && reading.status.toLowerCase().includes("quá thời gian")) {
    alerts.push({ type: "danger", message: "Bơm chạy quá thời gian giới hạn" });
  }
  return alerts;
}

function severityFor(reading, settings) {
  if (!reading) return "info";
  if (reading.systemOn === 0) return "info";
  if (reading.waterLevel <= settings.waterLowThreshold) return "danger";
  if (reading.status && reading.status.toLowerCase().includes("quá thời gian")) return "danger";
  if (reading.soil <= settings.dryThreshold || reading.soil >= settings.wetThreshold || reading.light <= settings.lightThreshold) return "warning";
  return "stable";
}

async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sensor_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      soil REAL NOT NULL,
      temperature REAL NOT NULL,
      airHumidity REAL NOT NULL,
      light REAL NOT NULL,
      waterLevel REAL NOT NULL,
      pump INTEGER NOT NULL,
      buzzer INTEGER NOT NULL,
      growLight INTEGER NOT NULL,
      systemOn INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS control_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      systemOn INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'AUTO',
      manualPump INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scenario_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'none',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", key, String(value));
  }

  await db.run(
    "INSERT OR IGNORE INTO control_state (id, systemOn, mode, manualPump) VALUES (1, ?, ?, ?)",
    DEFAULT_CONTROL.systemOn ? 1 : 0,
    DEFAULT_CONTROL.mode,
    DEFAULT_CONTROL.manualPump ? 1 : 0
  );

  await db.run("INSERT OR IGNORE INTO scenario_state (id, name) VALUES (1, 'none')");
}

async function getSettings() {
  const rows = await db.all("SELECT key, value FROM settings");
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(settings, row.key)) {
      settings[row.key] = Number(row.value);
    }
  }
  return settings;
}

async function updateSettings(payload) {
  const next = normalizeSettings(payload || {}, await getSettings());
  for (const [key, value] of Object.entries(next)) {
    await db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      String(value)
    );
  }
  return next;
}

async function getControl() {
  const row = await db.get("SELECT systemOn, mode, manualPump, updatedAt FROM control_state WHERE id = 1");
  return {
    systemOn: normalizeBoolean(row?.systemOn, DEFAULT_CONTROL.systemOn),
    mode: normalizeMode(row?.mode, DEFAULT_CONTROL.mode),
    manualPump: normalizeBoolean(row?.manualPump, DEFAULT_CONTROL.manualPump),
    updatedAt: row?.updatedAt
  };
}

async function updateControl(payload) {
  const current = await getControl();
  const next = {
    systemOn: normalizeBoolean(payload.systemOn, current.systemOn),
    mode: normalizeMode(payload.mode, current.mode),
    manualPump: normalizeBoolean(payload.manualPump ?? payload.pump ?? payload.pumpOn, current.manualPump)
  };

  if (!next.systemOn || next.mode === "AUTO") {
    next.manualPump = false;
  }

  await db.run(
    "UPDATE control_state SET systemOn = ?, mode = ?, manualPump = ?, updatedAt = datetime('now') WHERE id = 1",
    next.systemOn ? 1 : 0,
    next.mode,
    next.manualPump ? 1 : 0
  );

  return getControl();
}

async function getScenario() {
  const row = await db.get("SELECT name, updatedAt FROM scenario_state WHERE id = 1");
  return {
    name: normalizeScenario(row?.name),
    updatedAt: row?.updatedAt
  };
}

async function updateScenario(payload) {
  const name = normalizeScenario(payload?.name ?? payload?.scenario);
  await db.run(
    "UPDATE scenario_state SET name = ?, updatedAt = datetime('now') WHERE id = 1",
    name
  );

  if (name !== "none") {
    await updateControl({
      systemOn: true,
      mode: "AUTO",
      manualPump: false
    });
  }

  return getScenario();
}

async function getLatest() {
  return db.get("SELECT * FROM sensor_history ORDER BY id DESC LIMIT 1");
}

function normalizeSensor(payload, settings) {
  const reading = {
    soil: parseBoundedNumber(readAliasedValue(payload, ["soil", "soilMoisture"], "Độ ẩm đất"), 0, 100, "Độ ẩm đất"),
    temperature: parseBoundedNumber(readAliasedValue(payload, ["temperature"], "Nhiệt độ"), -20, 80, "Nhiệt độ"),
    airHumidity: parseBoundedNumber(readAliasedValue(payload, ["airHumidity"], "Độ ẩm không khí"), 0, 100, "Độ ẩm không khí"),
    light: parseBoundedNumber(readAliasedValue(payload, ["light", "lightLevel"], "Ánh sáng"), 0, 100, "Ánh sáng"),
    waterLevel: parseBoundedNumber(readAliasedValue(payload, ["waterLevel"], "Mực nước"), 0, 100, "Mực nước"),
    pump: normalizeBoolean(payload.pump ?? payload.pumpOn, false),
    buzzer: normalizeBoolean(payload.buzzer, false),
    growLight: normalizeBoolean(payload.growLight, false),
    systemOn: normalizeBoolean(payload.systemOn, true),
    mode: normalizeMode(payload.mode, "AUTO"),
    status: String(payload.status || "")
  };

  if (!reading.status) {
    reading.status = buildStatus(reading, settings);
  }

  return reading;
}

async function saveSensor(reading) {
  const result = await db.run(
    `INSERT INTO sensor_history
      (soil, temperature, airHumidity, light, waterLevel, pump, buzzer, growLight, systemOn, mode, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    reading.soil,
    reading.temperature,
    reading.airHumidity,
    reading.light,
    reading.waterLevel,
    reading.pump ? 1 : 0,
    reading.buzzer ? 1 : 0,
    reading.growLight ? 1 : 0,
    reading.systemOn ? 1 : 0,
    reading.mode,
    reading.status
  );
  return db.get("SELECT * FROM sensor_history WHERE id = ?", result.lastID);
}

async function buildSummary() {
  const settings = await getSettings();
  const rows = await db.all("SELECT * FROM sensor_history ORDER BY id DESC LIMIT 200");
  const ordered = [...rows].reverse();
  let pumpActivations = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    if (ordered[i].pump === 1 && (!previous || previous.pump === 0)) {
      pumpActivations += 1;
    }
  }

  return {
    samples: rows.length,
    pumpActivations,
    drySoilAlerts: rows.filter((row) => row.systemOn === 1 && row.soil <= settings.dryThreshold).length,
    lowWaterAlerts: rows.filter((row) => row.systemOn === 1 && row.waterLevel <= settings.waterLowThreshold).length,
    wetSoilAlerts: rows.filter((row) => row.systemOn === 1 && row.soil >= settings.wetThreshold).length,
    lowLightAlerts: rows.filter((row) => row.systemOn === 1 && row.light <= settings.lightThreshold).length,
    latestStatus: rows[0]?.status || "Đang chờ dữ liệu",
    health: rows[0] ? severityFor(rows[0], settings) : "info"
  };
}

async function main() {
  await initDb();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "smart-garden-api" });
  });

  app.post("/api/sensor", async (req, res, next) => {
    try {
      const settings = await getSettings();
      const sensor = normalizeSensor(req.body || {}, settings);
      const saved = await saveSensor(sensor);
      if (req.query.minimal === "1") {
        res.status(204).end();
        return;
      }

      res.status(201).json({
        data: saved,
        alerts: buildAlerts(saved, settings)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/latest", async (_req, res, next) => {
    try {
      const settings = await getSettings();
      const latest = await getLatest();
      const control = await getControl();
      res.json({
        latest,
        control,
        settings,
        alerts: buildAlerts(latest, settings),
        status: latest ? latest.status : "Đang chờ dữ liệu từ ESP32",
        severity: severityFor(latest, settings)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/history", async (req, res, next) => {
    try {
      const limit = clampNumber(req.query.limit, 1, 500, 60);
      const rows = await db.all("SELECT * FROM sensor_history ORDER BY id DESC LIMIT ?", limit);
      res.json(rows.reverse());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/control", async (_req, res, next) => {
    try {
      res.json({
        ...(await getControl()),
        settings: await getSettings(),
        scenario: await getScenario()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/control", async (req, res, next) => {
    try {
      res.json(await updateControl(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/settings", async (_req, res, next) => {
    try {
      res.json(await getSettings());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings", async (req, res, next) => {
    try {
      res.json(await updateSettings(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/settings", async (req, res, next) => {
    try {
      res.json(await updateSettings(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/scenario", async (_req, res, next) => {
    try {
      res.json(await getScenario());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/scenario", async (req, res, next) => {
    try {
      res.json(await updateScenario(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/summary", async (_req, res, next) => {
    try {
      res.json(await buildSummary());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/telemetry", (req, res, next) => {
    req.url = "/api/sensor";
    app.handle(req, res, next);
  });

  app.get("/api/telemetry", (req, res, next) => {
    req.url = `/api/history${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
    app.handle(req, res, next);
  });

  app.get("/api/status", (req, res, next) => {
    req.url = "/api/latest";
    app.handle(req, res, next);
  });

  app.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || error.status || 500;
    if (statusCode >= 500) console.error(error);
    res.status(statusCode).json({
      error: statusCode >= 500 ? "Lỗi máy chủ nội bộ" : error.message
    });
  });

  app.listen(PORT, () => {
    console.log(`Smart Garden API running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
