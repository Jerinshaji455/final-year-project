// VitalNet AI — ESP32 Pulse Oximeter with MQTT  v3
// Finger gate: Code 1 (IR_MIN / IR_MAX thresholds)
// Algorithm:   Code 2 (DC-EMA + LP filter + beat timing + ratio SpO2)
// Output:      Code 1 (RESULT block + publishVitals JSON)

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include "MAX30105.h"

MAX30105 particleSensor;

// ------------------------------------------------------------------ credentials
const char* WIFI_SSID   = "iQOO Neo 10";
const char* WIFI_PASS   = "netvenomone";
const char* MQTT_BROKER = "10.78.4.241";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER   = "";
const char* MQTT_PASS   = "";
const char* MQTT_TOPIC  = "clinic/patients/PT-1000/vitals";

WiFiClient   espClient;
PubSubClient mqttClient(espClient);

unsigned long wifiLastAttempt = 0;
unsigned long mqttLastAttempt = 0;
const unsigned long WIFI_RETRY_INTERVAL = 5000;
const unsigned long MQTT_RETRY_INTERVAL = 3000;

// ------------------------------------------------------------------ thresholds (Code 1)
#define IR_MIN_THRESHOLD  50000
#define IR_MAX_THRESHOLD  180000

// ------------------------------------------------------------------ algorithm state (Code 2)
const float alphaDC = 0.92f;
float dcIR  = 0, dcRed = 0;
bool  firstRun = true;

#define LP_SIZE 5
float lpBufferIR[LP_SIZE], lpBufferRed[LP_SIZE];
int   lpIndex = 0;

#define SMOOTH_SIZE 10
float hrArray[SMOOTH_SIZE];
int   hrWriteIdx = 0;
float smoothedHR = 0;
int   hrSampleCount = 0;          // how many real beats have fed the buffer

unsigned long lastBeatTime = 0;
bool  beatDetected   = false;
bool  fingerDetected = false;

float currentSpO2 = 0;
bool  readingReady = false;       // true once we have ≥3 real beats

// publish throttle — don't spam every beat
unsigned long lastPublishTime = 0;
const unsigned long PUBLISH_INTERVAL = 2000;

// ================================================================== WiFi
void tryConnectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - wifiLastAttempt < WIFI_RETRY_INTERVAL) return;
  wifiLastAttempt = now;

  Serial.print("WiFi: connecting to "); Serial.println(WIFI_SSID);
  WiFi.disconnect(true); delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    Serial.print("."); delay(300);
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("✔ WiFi connected! IP = "); Serial.println(WiFi.localIP());
  } else {
    Serial.println("✘ WiFi connect failed. Retrying...");
  }
}

// ================================================================== MQTT
bool ensureMqttConnected() {
  if (mqttClient.connected()) return true;
  unsigned long now = millis();
  if (now - mqttLastAttempt < MQTT_RETRY_INTERVAL) return false;
  mqttLastAttempt = now;
  if (WiFi.status() != WL_CONNECTED) { Serial.println("MQTT: WiFi not up."); return false; }

  Serial.print("Connecting to MQTT... ");
  String cid = "esp32-pt1000-"; cid += String(random(0xffff), HEX);
  if (mqttClient.connect(cid.c_str(), MQTT_USER, MQTT_PASS)) {
    Serial.println("✔ MQTT connected!"); return true;
  }
  Serial.print("✘ MQTT failed, state="); Serial.println(mqttClient.state());
  return false;
}

// ================================================================== publish (Code 1 format)
void publishVitals(int spo2Val, int hrVal) {
  if (!mqttClient.connected()) ensureMqttConnected();
  if (!mqttClient.connected()) return;

  char payload[256];
  snprintf(payload, sizeof(payload),
    "{\"id\":\"PT-1000\",\"name\":\"Jerin Shaji\",\"spo2\":%d,\"hr\":%d,\"ts\":%lu}",
    spo2Val, hrVal, millis());
  mqttClient.publish(MQTT_TOPIC, payload, false);
  Serial.print("MQTT Publish → "); Serial.println(payload);
}

// ================================================================== reset
void resetSensorState() {
  dcIR = dcRed = 0; firstRun = true;
  lpIndex = 0;
  smoothedHR = 0; hrWriteIdx = 0; hrSampleCount = 0;
  currentSpO2 = 0; readingReady = false;
  beatDetected = false; lastBeatTime = 0;
  for (int i = 0; i < SMOOTH_SIZE; i++) hrArray[i]     = 0;
  for (int i = 0; i < LP_SIZE;     i++) lpBufferIR[i]  = lpBufferRed[i] = 0;
}

// ================================================================== setup
void setup() {
  Serial.begin(115200);
  Serial.println("Initializing...");

  tryConnectWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found!"); while (1);
  }

  // Code 1 original sensor settings
  particleSensor.setup(40, 4, 2, 200, 411, 4096);

  resetSensorState();
  Serial.println("Place finger lightly...");
}

// ================================================================== loop
void loop() {
  tryConnectWiFi();
  mqttClient.loop();
  ensureMqttConnected();

  // ---- Code 1 finger gate: quick IR check ----
  uint32_t irValue = particleSensor.getIR();

  if (irValue < IR_MIN_THRESHOLD) {
    if (fingerDetected) {
      Serial.println("Finger removed");
      fingerDetected = false;
      resetSensorState();
    }
    particleSensor.check();
    delay(100);
    return;
  }

  if (irValue > IR_MAX_THRESHOLD) {
    Serial.println("Signal too strong! Use lighter pressure");
    delay(500);
    return;
  }

  if (!fingerDetected) {
    Serial.println("Finger detected! Measuring... (keep still for ~5s)");
    fingerDetected = true;
  }

  // ---- Drain all buffered samples — continuous, no 100-sample hard stop ----
  particleSensor.check();

  while (particleSensor.available()) {
    uint32_t irRaw  = particleSensor.getIR();
    uint32_t redRaw = particleSensor.getRed();
    particleSensor.nextSample();

    // Finger removed mid-read
    if (irRaw < IR_MIN_THRESHOLD) {
      Serial.println("Signal lost!");
      fingerDetected = false;
      resetSensorState();
      return;
    }

    // ---- DC removal (EMA) ----
    if (firstRun) { dcIR = irRaw; dcRed = redRaw; firstRun = false; }
    dcIR  = alphaDC * dcIR  + (1.0f - alphaDC) * irRaw;
    dcRed = alphaDC * dcRed + (1.0f - alphaDC) * redRaw;

    float acIR  = irRaw  - dcIR;
    float acRed = redRaw - dcRed;

    // ---- Low-pass (5-sample moving average) ----
    lpBufferIR[lpIndex]  = acIR;
    lpBufferRed[lpIndex] = acRed;
    lpIndex = (lpIndex + 1) % LP_SIZE;

    float filteredIR = 0, filteredRed = 0;
    for (int i = 0; i < LP_SIZE; i++) {
      filteredIR  += lpBufferIR[i];
      filteredRed += lpBufferRed[i];
    }
    filteredIR  /= LP_SIZE;
    filteredRed /= LP_SIZE;

    // ---- Beat detection ----
    if (filteredIR > 30 && !beatDetected) {
      unsigned long now      = millis();
      unsigned long interval = now - lastBeatTime;

      // Accept interval: 46–150 BPM
      if (lastBeatTime != 0 && interval > 400 && interval < 1300) {
        float rawHR = 60000.0f / interval;

        hrArray[hrWriteIdx] = rawHR;
        hrWriteIdx = (hrWriteIdx + 1) % SMOOTH_SIZE;
        if (hrSampleCount < SMOOTH_SIZE) hrSampleCount++;

        // Average only real beats collected so far
        float sum = 0;
        int   cnt = hrSampleCount;
        for (int i = 0; i < cnt; i++) {
          int idx = (hrWriteIdx - 1 - i + SMOOTH_SIZE) % SMOOTH_SIZE;
          sum += hrArray[idx];
        }
        smoothedHR = sum / cnt;

        // SpO2 via AC/DC ratio
        if (dcIR > 0 && dcRed > 0) {
          float ratio = (filteredRed / dcRed) / (filteredIR / dcIR);
          currentSpO2 = 110.0f - (18.0f * ratio);
          if (currentSpO2 > 100.0f) currentSpO2 = 100.0f;
          if (currentSpO2 <  88.0f) currentSpO2 =  90.0f;
        }

        // Need at least 3 beats before reporting
        if (hrSampleCount >= 3) readingReady = true;
      }

      lastBeatTime = now;
      beatDetected = true;
    }

    if (filteredIR < -10) beatDetected = false;
  }

  // ---- Print + publish every PUBLISH_INTERVAL once we have data ----
  unsigned long now = millis();
  if (readingReady && (now - lastPublishTime >= PUBLISH_INTERVAL)) {
    lastPublishTime = now;

    int finalHR   = (int)smoothedHR;
    int finalSpO2 = (currentSpO2 > 0) ? (int)currentSpO2 : -1;

    Serial.println("\n========== RESULT ==========");
    if (finalSpO2 > 0) {
      Serial.print("SpO2: "); Serial.print(finalSpO2); Serial.println("%");
    } else {
      Serial.println("SpO2: Unable to read");
    }
    Serial.print("Heart Rate: "); Serial.print(finalHR); Serial.println(" BPM");
    Serial.println("============================\n");

    publishVitals(finalSpO2, finalHR);
  }
}
