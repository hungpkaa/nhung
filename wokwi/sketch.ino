#include <WiFi.h>
#include <ArduinoJson.h>
#include <DHT.h>

// Wokwi web + ngrok HTTP endpoint: điền host ngrok, không kèm http:// hoặc https://.
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
const char* SERVER_HOST = "trifocals-laundry-simplify.ngrok-free.dev";
const int SERVER_PORT = 80;

const unsigned long CONTROL_POLL_MS = 6000;
const unsigned long SENSOR_POST_MS = 2000;
const int DEMO_TICKS = 5;
const bool DEBUG_HTTP = false;

const int DHT_PIN = 15;
const int SOIL_PIN = 34;
const int LIGHT_PIN = 32;
const int WATER_PIN = 35;
const int PUMP_PIN = 26;
const int BUZZER_PIN = 27;
const int GROW_LIGHT_PIN = 25;

DHT dht(DHT_PIN, DHT22);
WiFiClient netClient;

String mode = "AUTO";
String statusText = "Hệ thống đang khởi động";
String activeScenario = "none";
String scenarioMessage = "";
bool systemOn = true;
bool pump = false;
bool buzzer = false;
bool growLight = false;
bool manualPumpCommand = false;
bool pumpTimeout = false;

float dryThreshold = 35;
float wetThreshold = 75;
float lightThreshold = 25;
float waterLowThreshold = 20;
int maxPumpTime = 10;

float demoSoil = 50;
float demoLight = 60;
float demoWaterLevel = 82;
int demoTicksRemaining = 0;

unsigned long pumpStartedAt = 0;
unsigned long pumpCooldownUntil = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastSensorPost = 0;
String lastHttpBody = "";

float clampFloat(float value, float minValue, float maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

void blinkPin(int pin, int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH);
    delay(delayMs);
    digitalWrite(pin, LOW);
    delay(delayMs);
  }
}

float percentFromAdc(int pin, bool invert) {
  int raw = analogRead(pin);
  int pct = map(raw, 0, 4095, 0, 100);
  pct = constrain(pct, 0, 100);
  return invert ? 100 - pct : pct;
}

float balanceTarget() {
  return clampFloat(dryThreshold + 12, dryThreshold + 5, wetThreshold - 8);
}

int readHttpStatus(Client& client) {
  String statusLine = client.readStringUntil('\n');
  statusLine.trim();
  if (DEBUG_HTTP) {
    Serial.println(statusLine);
  }

  int firstSpace = statusLine.indexOf(' ');
  if (firstSpace < 0) return -1;

  int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
  String codeText = secondSpace > firstSpace
    ? statusLine.substring(firstSpace + 1, secondSpace)
    : statusLine.substring(firstSpace + 1);

  return codeText.toInt();
}

int sendHttpRequest(const String& method, const String& path, const String& body = "") {
  lastHttpBody = "";

  IPAddress serverIp;
  if (WiFi.hostByName(SERVER_HOST, serverIp)) {
    if (DEBUG_HTTP) {
      Serial.print("Resolved ");
      Serial.print(SERVER_HOST);
      Serial.print(" -> ");
      Serial.println(serverIp);
    }
  } else {
    Serial.print("DNS failed: ");
    Serial.println(SERVER_HOST);
    return -3;
  }

  netClient.setTimeout(5000);
  netClient.stop();

  if (DEBUG_HTTP) {
    Serial.print("Connecting to ");
    Serial.print(SERVER_HOST);
    Serial.print(":");
    Serial.println(SERVER_PORT);
  }

  if (!netClient.connect(SERVER_HOST, SERVER_PORT)) {
    Serial.println("TCP connect failed");
    netClient.stop();
    return -1;
  }

  if (DEBUG_HTTP) {
    Serial.println("TCP connected");
  }

  netClient.print(method);
  netClient.print(" ");
  netClient.print(path);
  netClient.println(" HTTP/1.1");
  netClient.print("Host: ");
  netClient.println(SERVER_HOST);
  netClient.println("User-Agent: ESP32-Wokwi");
  netClient.println("ngrok-skip-browser-warning: true");
  netClient.println("Connection: close");

  if (method == "POST") {
    netClient.println("Content-Type: application/json; charset=utf-8");
    netClient.print("Content-Length: ");
    netClient.println(body.length());
  }

  netClient.println();

  if (method == "POST") {
    netClient.print(body);
  }

  unsigned long startedAt = millis();
  while (!netClient.available()) {
    if (millis() - startedAt > 5000) {
      Serial.println("HTTP response timeout");
      netClient.stop();
      return -2;
    }
    delay(10);
  }

  int statusCode = readHttpStatus(netClient);

  while (netClient.connected() || netClient.available()) {
    String line = netClient.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
  }

  while (netClient.available()) {
    lastHttpBody += netClient.readString();
  }

  netClient.stop();
  return statusCode;
}

void setPump(bool nextPump) {
  if (nextPump && !pump) {
    pumpStartedAt = millis();
    pumpTimeout = false;
  }

  if (!nextPump) {
    pumpStartedAt = 0;
  }

  pump = nextPump;
  digitalWrite(PUMP_PIN, pump ? HIGH : LOW);
}

void setOutputs() {
  digitalWrite(PUMP_PIN, pump ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, buzzer ? HIGH : LOW);
  digitalWrite(GROW_LIGHT_PIN, growLight ? HIGH : LOW);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(GROW_LIGHT_PIN, !digitalRead(GROW_LIGHT_PIN));
    delay(250);
    Serial.print(".");

    if (millis() - startedAt > 15000) {
      Serial.println("\nWiFi timeout, retrying");
      blinkPin(BUZZER_PIN, 5, 100);
      WiFi.disconnect();
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASS, 6);
      startedAt = millis();
    }
  }

  digitalWrite(GROW_LIGHT_PIN, LOW);
  blinkPin(GROW_LIGHT_PIN, 3, 120);
  Serial.println("\nWiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void clearScenarioOnServer() {
  StaticJsonDocument<64> doc;
  doc["name"] = "none";

  String body;
  serializeJson(doc, body);

  int code = sendHttpRequest("POST", "/api/scenario", body);
  Serial.print("POST /api/scenario none: ");
  Serial.println(code);
}

void startScenario(const String& scenarioName) {
  activeScenario = scenarioName;
  scenarioMessage = "";
  demoTicksRemaining = DEMO_TICKS;
  systemOn = true;
  mode = "AUTO";
  manualPumpCommand = false;
  pumpTimeout = false;
  pumpCooldownUntil = 0;

  if (scenarioName == "dry_soil") {
    demoSoil = clampFloat(dryThreshold - 6, 5, 100);
    demoWaterLevel = clampFloat(waterLowThreshold + 55, 0, 100);
    demoLight = 62;
    scenarioMessage = "Kịch bản demo: đất bị khô nhanh";
  } else if (scenarioName == "low_water") {
    demoSoil = balanceTarget();
    demoWaterLevel = clampFloat(waterLowThreshold - 4, 0, 100);
    demoLight = 62;
    setPump(false);
    scenarioMessage = "Kịch bản demo: bình chứa thiếu nước";
  } else if (scenarioName == "low_light") {
    demoSoil = balanceTarget();
    demoWaterLevel = clampFloat(waterLowThreshold + 55, 0, 100);
    demoLight = clampFloat(lightThreshold - 14, 5, 100);
    scenarioMessage = "Kịch bản demo: ánh sáng yếu";
  } else if (scenarioName == "reset_environment") {
    demoSoil = 50;
    demoWaterLevel = 82;
    demoLight = 60;
    setPump(false);
    buzzer = false;
    growLight = false;
    scenarioMessage = "Đã reset môi trường về trạng thái ổn định";
  }

  Serial.print("Scenario: ");
  Serial.println(scenarioName);
  clearScenarioOnServer();
}

void readControl() {
  if (WiFi.status() != WL_CONNECTED) return;

  int code = sendHttpRequest("GET", "/api/control");

  if (code != 200) {
    Serial.print("GET /api/control: ");
    Serial.println(code);
    blinkPin(BUZZER_PIN, 1, 120);
  }

  if (code != 200) return;

  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, lastHttpBody);

  if (error) {
    Serial.print("Control JSON error: ");
    Serial.println(error.c_str());
    return;
  }

  systemOn = doc["systemOn"] | systemOn;
  const char* receivedMode = doc["mode"] | mode.c_str();
  mode = String(receivedMode);
  manualPumpCommand = doc["manualPump"] | manualPumpCommand;
  dryThreshold = doc["settings"]["dryThreshold"] | dryThreshold;
  wetThreshold = doc["settings"]["wetThreshold"] | wetThreshold;
  lightThreshold = doc["settings"]["lightThreshold"] | lightThreshold;
  waterLowThreshold = doc["settings"]["waterLowThreshold"] | waterLowThreshold;
  maxPumpTime = doc["settings"]["maxPumpTime"] | maxPumpTime;

  const char* scenarioName = doc["scenario"]["name"] | "none";
  String scenario = String(scenarioName);
  if (scenario != "none") {
    startScenario(scenario);
  }

  if (!systemOn) {
    setPump(false);
    buzzer = false;
    growLight = false;
    statusText = "Hệ thống đang tắt";
  }
}

void pingServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  int code = sendHttpRequest("GET", "/api/health");

  Serial.print("GET /api/health: ");
  Serial.println(code);

  if (code == 200) {
    blinkPin(PUMP_PIN, 1, 250);
  } else {
    blinkPin(BUZZER_PIN, 3, 120);
  }
}

void updateDemoValues(float& soil, float& light, float& waterLevel) {
  if (demoTicksRemaining <= 0) {
    activeScenario = "none";
    scenarioMessage = "";
    return;
  }

  if (activeScenario == "dry_soil") {
    if (pump) {
      demoSoil = clampFloat(demoSoil + 5.6, 0, 100);
      demoWaterLevel = clampFloat(demoWaterLevel - 1.9, 0, 100);
    } else {
      demoSoil = clampFloat(demoSoil - 0.9, 0, 100);
    }
  } else if (activeScenario == "low_water") {
    if (demoTicksRemaining > 2) {
      demoWaterLevel = clampFloat(waterLowThreshold - 4, 0, 100);
    } else {
      demoWaterLevel = clampFloat(demoWaterLevel + 18, 0, 100);
    }
  } else if (activeScenario == "low_light") {
    demoLight = clampFloat(demoLight + (growLight ? 5.0 : 0.8), 0, 100);
  } else if (activeScenario == "reset_environment") {
    demoSoil = 50;
    demoWaterLevel = 82;
    demoLight = 60;
  }

  soil = demoSoil;
  light = demoLight;
  waterLevel = demoWaterLevel;
  demoTicksRemaining -= 1;
}

void applyControl(float soil, float light, float waterLevel) {
  if (!systemOn) {
    setPump(false);
    buzzer = false;
    growLight = false;
    statusText = "Hệ thống đang tắt";
    return;
  }

  growLight = light <= lightThreshold;

  if (waterLevel <= waterLowThreshold) {
    setPump(false);
    buzzer = true;
    statusText = "Bình thiếu nước, đang chờ bổ sung";
    return;
  }

  if (millis() < pumpCooldownUntil) {
    setPump(false);
    buzzer = true;
    statusText = "Bảo vệ bơm: đang chờ ổn định";
    return;
  }

  if (mode == "MANUAL") {
    setPump(manualPumpCommand);
    statusText = pump ? "Bơm thủ công đang chạy" : "Chế độ thủ công sẵn sàng";
  } else {
    if (soil >= wetThreshold) {
      setPump(false);
      statusText = "Đất quá ẩm, bơm đã tắt";
    } else if (soil <= dryThreshold) {
      setPump(true);
      statusText = "Đang tưới để đưa đất về vùng cân bằng";
    } else if (pump && soil < balanceTarget()) {
      statusText = "Đang tưới để đưa đất về vùng cân bằng";
    } else if (pump && soil >= balanceTarget()) {
      setPump(false);
      statusText = "Đất đã đủ ẩm, bơm đã tắt";
    } else {
      setPump(false);
      statusText = "Độ ẩm đất đang phù hợp";
    }
  }

  buzzer = soil <= dryThreshold || soil >= wetThreshold;

  if (growLight && !pump && !buzzer) {
    statusText = "Đèn cây đang bù ánh sáng yếu";
  }

  if (pump) {
    unsigned long maxPumpMs = max((unsigned long)maxPumpTime * 1000UL, SENSOR_POST_MS * 4UL);
    if (millis() - pumpStartedAt >= maxPumpMs) {
      setPump(false);
      pumpTimeout = true;
      pumpCooldownUntil = millis() + SENSOR_POST_MS;
      buzzer = true;
      statusText = "Bảo vệ bơm: quá thời gian giới hạn";
    }
  }
}

void postSensor() {
  float temperature = dht.readTemperature();
  float airHumidity = dht.readHumidity();
  float soil = percentFromAdc(SOIL_PIN, true);
  float light = percentFromAdc(LIGHT_PIN, false);
  float waterLevel = percentFromAdc(WATER_PIN, false);

  if (isnan(temperature)) temperature = 0;
  if (isnan(airHumidity)) airHumidity = 0;

  updateDemoValues(soil, light, waterLevel);
  applyControl(soil, light, waterLevel);

  if (scenarioMessage.length() > 0) {
    statusText = scenarioMessage;
    scenarioMessage = "";
  }

  setOutputs();

  if (WiFi.status() != WL_CONNECTED) return;

  StaticJsonDocument<512> doc;
  doc["soil"] = soil;
  doc["temperature"] = temperature;
  doc["airHumidity"] = airHumidity;
  doc["light"] = light;
  doc["waterLevel"] = waterLevel;
  doc["pump"] = pump;
  doc["buzzer"] = buzzer;
  doc["growLight"] = growLight;
  doc["systemOn"] = systemOn;
  doc["mode"] = mode;
  doc["status"] = statusText;

  String body;
  serializeJson(doc, body);

  int code = sendHttpRequest("POST", "/api/sensor?minimal=1", body);

  if (code != 201 && code != 204) {
    Serial.print("POST /api/sensor: ");
    Serial.println(code);
    blinkPin(BUZZER_PIN, 2, 120);
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Smart Garden ESP32 starting...");
  Serial.print("Server: http://");
  Serial.print(SERVER_HOST);
  Serial.print(":");
  Serial.println(SERVER_PORT);

  pinMode(PUMP_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GROW_LIGHT_PIN, OUTPUT);
  setOutputs();
  dht.begin();
  connectWifi();
  postSensor();
  lastSensorPost = millis();
}

void loop() {
  unsigned long now = millis();

  if (now - lastCommandPoll >= CONTROL_POLL_MS) {
    lastCommandPoll = now;
    readControl();
  }

  if (now - lastSensorPost >= SENSOR_POST_MS) {
    lastSensorPost = now;
    postSensor();
  }
}
