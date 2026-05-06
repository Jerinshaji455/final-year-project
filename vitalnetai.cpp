// VitalNet AI - ESP32 Pulse Oximeter with MQTT v4.1 (FIXED)
// FIXES APPLIED:
//   BUG 1 — DEVICE_MAP MACs lowercased to match WiFi.macAddress() output
//   BUG 2 — delay(200) added after WiFi.mode(WIFI_STA) before resolvePatientId()
//            so MAC is not read as 00:00:00:00:00:00 during cold boot

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

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// ------------------------------------------------------------------ MAC -> Patient ID mapping
// BUG 1 FIX: All MACs must be lowercase to match WiFi.macAddress() after .toLowerCase()
struct DeviceEntry {
  const char* mac;
  const char* patientId;
};

const DeviceEntry DEVICE_MAP[] = {
  { "38:18:2b:b2:67:9c", "PT-1000" },  // was already lowercase — OK
  { "94:54:c5:2f:26:60", "PT-1002" },  // FIXED: was "94:54:C5:2F:26:60"
  { "b4:bf:e9:11:f7:74", "PT-1001" },  // FIXED: was "B4:BF:E9:11:F7:74"
};
const int DEVICE_MAP_SIZE = sizeof(DEVICE_MAP) / sizeof(DEVICE_MAP[0]);

// ------------------------------------------------------------------ runtime state
char resolvedPatientId[32] = "PT-UNKNOWN";
char mqttTopic[64] = "";
char deviceMac[18] = "";

unsigned long wifiLastAttempt = 0;
unsigned long mqttLastAttempt = 0;
unsigned long lastDebugTime = 0;
const unsigned long WIFI_RETRY_INTERVAL = 5000;
const unsigned long MQTT_RETRY_INTERVAL = 3000;
const unsigned long DEBUG_INTERVAL = 1000;

// ------------------------------------------------------------------ thresholds
#define IR_MIN_THRESHOLD    10000
#define IR_VALID_THRESHOLD  50000
#define IR_MAX_THRESHOLD    180000

// ------------------------------------------------------------------ algorithm state
const float alphaDC = 0.92f;
float dcIR = 0, dcRed = 0;
bool firstRun = true;

#define LP_SIZE 5
float lpBufferIR[LP_SIZE], lpBufferRed[LP_SIZE];
int lpIndex = 0;

#define SMOOTH_SIZE 10
float hrArray[SMOOTH_SIZE];
int hrWriteIdx = 0;
float smoothedHR = 0;
int hrSampleCount = 0;

#define SPO2_SMOOTH_SIZE 6
float spo2Array[SPO2_SMOOTH_SIZE];
int spo2WriteIdx = 0;
int spo2SampleCount = 0;
float acIRSqSum = 0;
float acRedSqSum = 0;
int opticalSampleCount = 0;

unsigned long lastBeatTime = 0;
bool beatDetected = false;
bool fingerDetected = false;

float currentSpO2 = 0;
bool readingReady = false;

unsigned long lastPublishTime = 0;
bool fingerRemovedPublished = true;
unsigned long lastNoFingerPublishAttempt = 0;
const unsigned long PUBLISH_INTERVAL = 1000;
const unsigned long NO_FINGER_PUBLISH_INTERVAL = 1000;

// ================================================================== helpers
void printDebug(uint32_t irValue) {
  unsigned long now = millis();
  if (now - lastDebugTime < DEBUG_INTERVAL) return;
  lastDebugTime = now;

  Serial.print("IR: "); Serial.print(irValue);
  Serial.print(" | finger: "); Serial.print(fingerDetected ? "yes" : "no");
  Serial.print(" | beats: "); Serial.print(hrSampleCount);
  Serial.print(" | ready: "); Serial.print(readingReady ? "yes" : "no");
  Serial.print(" | WiFi: "); Serial.print(WiFi.status() == WL_CONNECTED ? "ok" : "down");
  Serial.print(" | MQTT: "); Serial.println(mqttClient.connected() ? "ok" : "down");
}

void resolvePatientId() {
  // BUG 2 FIX: WiFi.macAddress() returns 00:00:00:00:00:00 if called too
  // early after WiFi.mode(). The delay(200) in setup() before this call
  // lets the radio initialise so the real MAC is available.
  String mac = WiFi.macAddress();
  mac.toLowerCase();
  strncpy(deviceMac, mac.c_str(), sizeof(deviceMac) - 1);
  deviceMac[sizeof(deviceMac) - 1] = '\0';

  Serial.print("This device MAC: ");
  Serial.println(deviceMac);

  for (int i = 0; i < DEVICE_MAP_SIZE; i++) {
    if (mac.equals(DEVICE_MAP[i].mac)) {
      strncpy(resolvedPatientId, DEVICE_MAP[i].patientId, sizeof(resolvedPatientId) - 1);
      resolvedPatientId[sizeof(resolvedPatientId) - 1] = '\0';
      Serial.print("Resolved Patient ID: ");
      Serial.println(resolvedPatientId);
      return;
    }
  }

  // Fallback for unregistered devices
  String tail = mac.substring(mac.length() - 5);
  tail.replace(":", "");
  String fallback = "PT-MAC-" + tail;
  strncpy(resolvedPatientId, fallback.c_str(), sizeof(resolvedPatientId) - 1);
  resolvedPatientId[sizeof(resolvedPatientId) - 1] = '\0';

  Serial.print("MAC not in DEVICE_MAP. Using fallback ID: ");
  Serial.println(resolvedPatientId);
  Serial.println("Add this MAC to DEVICE_MAP[] and reflash for a fixed PT-100x ID.");
}

// ================================================================== WiFi
void tryConnectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  unsigned long now = millis();
  if (wifiLastAttempt != 0 && now - wifiLastAttempt < WIFI_RETRY_INTERVAL) return;
  wifiLastAttempt = now;

  Serial.print("WiFi: connecting to "); Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    Serial.print(".");
    delay(300);
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP = ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi connect failed. Retrying...");
  }
}

// ================================================================== MQTT
bool ensureMqttConnected() {
  if (mqttClient.connected()) return true;

  unsigned long now = millis();
  if (mqttLastAttempt != 0 && now - mqttLastAttempt < MQTT_RETRY_INTERVAL) return false;
  mqttLastAttempt = now;

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("MQTT: WiFi not connected.");
    return false;
  }

  Serial.print("Connecting to MQTT... ");
  String cid = String(resolvedPatientId) + "-" + String(random(0xffff), HEX);
  if (mqttClient.connect(cid.c_str(), MQTT_USER, MQTT_PASS)) {
    Serial.println("MQTT connected.");
    return true;
  }

  Serial.print("MQTT failed, state=");
  Serial.println(mqttClient.state());
  return false;
}

// ================================================================== publish
bool publishVitals(int spo2Val, int hrVal) {
  if (!mqttClient.connected()) ensureMqttConnected();
  if (!mqttClient.connected()) return false;

  char payload[200];
  snprintf(payload, sizeof(payload),
    "{\"id\":\"%s\",\"mac\":\"%s\",\"spo2\":%d,\"hr\":%d,\"ts\":%lu}",
    resolvedPatientId, deviceMac, spo2Val, hrVal, millis());

  bool published = mqttClient.publish(mqttTopic, payload, false);
  Serial.print("MQTT Publish ");
  Serial.print(published ? "OK" : "FAILED");
  Serial.print(" -> ");
  Serial.println(payload);

  if (!published) {
    mqttClient.disconnect();
  }

  return published;
}

bool publishNoFinger() {
  return publishVitals(-1, -1);
}

void publishNoFingerIfNeeded() {
  if (fingerRemovedPublished) return;

  unsigned long now = millis();
  if (lastNoFingerPublishAttempt != 0 && now - lastNoFingerPublishAttempt < NO_FINGER_PUBLISH_INTERVAL) return;
  lastNoFingerPublishAttempt = now;

  if (publishNoFinger()) {
    fingerRemovedPublished = true;
  }
}

// ================================================================== reset
void resetSensorState() {
  dcIR = dcRed = 0;
  firstRun = true;
  lpIndex = 0;
  smoothedHR = 0;
  hrWriteIdx = 0;
  hrSampleCount = 0;
  spo2WriteIdx = 0;
  spo2SampleCount = 0;
  acIRSqSum = 0;
  acRedSqSum = 0;
  opticalSampleCount = 0;
  currentSpO2 = 0;
  readingReady = false;
  beatDetected = false;
  lastBeatTime = 0;

  for (int i = 0; i < SMOOTH_SIZE; i++) hrArray[i] = 0;
  for (int i = 0; i < SPO2_SMOOTH_SIZE; i++) spo2Array[i] = 0;
  for (int i = 0; i < LP_SIZE; i++) {
    lpBufferIR[i] = 0;
    lpBufferRed[i] = 0;
  }
}

// ================================================================== setup
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Initializing VitalNet AI v4.1 (fixed)...");

  // BUG 2 FIX: Set WiFi mode first, then wait 200ms for the radio to
  // initialise so WiFi.macAddress() returns the real MAC, not 00:00:00:00:00:00
  WiFi.mode(WIFI_STA);
  delay(200);            // <-- THIS is what was missing
  resolvePatientId();

  snprintf(mqttTopic, sizeof(mqttTopic), "clinic/patients/%s/vitals", resolvedPatientId);
  Serial.print("MQTT Topic: ");
  Serial.println(mqttTopic);

  tryConnectWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setKeepAlive(15);
  mqttClient.setSocketTimeout(3);

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found. Check SDA/SCL/VCC/GND wiring.");
    while (1) delay(1000);
  }

  particleSensor.setup(40, 4, 2, 200, 411, 4096);

  resetSensorState();
  Serial.println("Place finger lightly on the sensor.");
}

// ================================================================== loop
void loop() {
  tryConnectWiFi();
  mqttClient.loop();
  ensureMqttConnected();

  uint32_t irValue = particleSensor.getIR();
  printDebug(irValue);

  if (irValue < IR_MIN_THRESHOLD) {
    if (fingerDetected) {
      Serial.println("Finger removed.");
      fingerDetected = false;
      resetSensorState();
    }
    publishNoFingerIfNeeded();
    if (millis() - lastDebugTime < 150) {
      Serial.print("No publish: IR below threshold ");
      Serial.print(IR_MIN_THRESHOLD);
      Serial.println(". Place finger fully over MAX30102 LEDs.");
    }
    particleSensor.check();
    delay(100);
    return;
  }

  if (irValue < IR_VALID_THRESHOLD) {
    if (fingerDetected) {
      Serial.println("Weak signal. Finger not placed firmly enough.");
      fingerDetected = false;
      resetSensorState();
    }
    publishNoFingerIfNeeded();
    particleSensor.check();
    delay(100);
    return;
  }

  if (irValue > IR_MAX_THRESHOLD) {
    Serial.println("Signal too strong. Use lighter pressure.");
    delay(500);
    return;
  }

  if (!fingerDetected) {
    Serial.println("Finger detected. Measuring, keep still.");
    fingerDetected = true;
    fingerRemovedPublished = false;
  }

  particleSensor.check();

  while (particleSensor.available()) {
    uint32_t irRaw = particleSensor.getIR();
    uint32_t redRaw = particleSensor.getRed();
    particleSensor.nextSample();

    if (irRaw < IR_VALID_THRESHOLD) {
      Serial.println("Signal lost.");
      fingerDetected = false;
      resetSensorState();
      publishNoFingerIfNeeded();
      return;
    }

    if (firstRun) {
      dcIR = irRaw;
      dcRed = redRaw;
      firstRun = false;
    }

    dcIR = alphaDC * dcIR + (1.0f - alphaDC) * irRaw;
    dcRed = alphaDC * dcRed + (1.0f - alphaDC) * redRaw;

    float acIR = irRaw - dcIR;
    float acRed = redRaw - dcRed;

    acIRSqSum += acIR * acIR;
    acRedSqSum += acRed * acRed;
    opticalSampleCount++;

    lpBufferIR[lpIndex] = acIR;
    lpBufferRed[lpIndex] = acRed;
    lpIndex = (lpIndex + 1) % LP_SIZE;

    float filteredIR = 0, filteredRed = 0;
    for (int i = 0; i < LP_SIZE; i++) {
      filteredIR += lpBufferIR[i];
      filteredRed += lpBufferRed[i];
    }
    filteredIR /= LP_SIZE;
    filteredRed /= LP_SIZE;

    if (filteredIR > 30 && !beatDetected) {
      unsigned long now = millis();
      unsigned long interval = now - lastBeatTime;

      if (lastBeatTime != 0 && interval > 400 && interval < 1300) {
        float rawHR = 60000.0f / interval;

        hrArray[hrWriteIdx] = rawHR;
        hrWriteIdx = (hrWriteIdx + 1) % SMOOTH_SIZE;
        if (hrSampleCount < SMOOTH_SIZE) hrSampleCount++;

        float sum = 0;
        for (int i = 0; i < hrSampleCount; i++) {
          int idx = (hrWriteIdx - 1 - i + SMOOTH_SIZE) % SMOOTH_SIZE;
          sum += hrArray[idx];
        }
        smoothedHR = sum / hrSampleCount;

        if (dcIR > 0 && dcRed > 0 && opticalSampleCount >= 25) {
          float rmsIR = sqrtf(acIRSqSum / opticalSampleCount);
          float rmsRed = sqrtf(acRedSqSum / opticalSampleCount);

          if (rmsIR > 20 && rmsRed > 20) {
            float ratio = (rmsRed / dcRed) / (rmsIR / dcIR);
            if (ratio > 0.35f && ratio < 1.4f) {
              float candidateSpO2 = 104.0f - (17.0f * ratio);
              if (candidateSpO2 > 100.0f) candidateSpO2 = 100.0f;
              if (candidateSpO2 < 70.0f) candidateSpO2 = 70.0f;

              spo2Array[spo2WriteIdx] = candidateSpO2;
              spo2WriteIdx = (spo2WriteIdx + 1) % SPO2_SMOOTH_SIZE;
              if (spo2SampleCount < SPO2_SMOOTH_SIZE) spo2SampleCount++;

              float spo2Sum = 0;
              for (int i = 0; i < spo2SampleCount; i++) spo2Sum += spo2Array[i];
              currentSpO2 = spo2Sum / spo2SampleCount;
            }
          }

          acIRSqSum = 0;
          acRedSqSum = 0;
          opticalSampleCount = 0;
        }

        if (hrSampleCount >= 3 && spo2SampleCount >= 2) readingReady = true;
      }

      lastBeatTime = now;
      beatDetected = true;
    }

    if (filteredIR < -10) beatDetected = false;
  }

  unsigned long now = millis();
  if (readingReady && (now - lastPublishTime >= PUBLISH_INTERVAL)) {
    lastPublishTime = now;

    int finalHR = (int)smoothedHR;
    int finalSpO2 = (currentSpO2 > 0) ? (int)currentSpO2 : -1;

    Serial.println();
    Serial.println("========== RESULT ==========");
    Serial.print("Patient ID: "); Serial.println(resolvedPatientId);
    Serial.print("Device MAC: "); Serial.println(deviceMac);
    Serial.print("SpO2: "); Serial.print(finalSpO2); Serial.println("%");
    Serial.print("Heart Rate: "); Serial.print(finalHR); Serial.println(" BPM");
    Serial.println("============================");
    Serial.println();

    publishVitals(finalSpO2, finalHR);
    fingerRemovedPublished = false;
    lastNoFingerPublishAttempt = 0;
  }
}
