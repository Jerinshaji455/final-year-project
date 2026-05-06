// bridge.js  v2 — multi-device, no patient_name field
const mqtt = require("mqtt");
const mysql = require("mysql2/promise");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// --- CONFIG - EDIT ---
const MQTT_BROKER_URL = "mqtt://127.0.0.1:1883";

const MQTT_OPTIONS = {
  username: "", // optional
  password: "",
};

const MYSQL_CONFIG = {
  host: "127.0.0.1",
  user: "root",
  password: "jerinshaji455",
  database: "clinicdb"
};


const HTTP_PORT = 4000;
// -----------------------

// IDs reserved for real ESP32 devices (PT-1000 to PT-1002, PT-1003 spare)
// PT-MAC-* are fallback IDs for unregistered devices — NOT treated as real
const REAL_DEVICE_IDS = new Set(["PT-1000", "PT-1001", "PT-1002", "PT-1003"]);

const isDevicePatientId = (patientId) =>
  REAL_DEVICE_IDS.has(patientId) || patientId.startsWith("PT-MAC-");

async function main() {
  // MySQL pool
  const pool = mysql.createPool(MYSQL_CONFIG);

  // Ensure table exists — no patient_name column
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vitals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      patient_id VARCHAR(64),
      device_mac VARCHAR(32),
      spo2 INT,
      hr INT,
      ts BIGINT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const [deviceMacColumns] = await pool.query("SHOW COLUMNS FROM vitals LIKE 'device_mac'");
  if (deviceMacColumns.length === 0) {
    await pool.query("ALTER TABLE vitals ADD COLUMN device_mac VARCHAR(32) NULL AFTER patient_id");
  }

  // Create MQTT client
  const mqttClient = mqtt.connect(MQTT_BROKER_URL, MQTT_OPTIONS);
  mqttClient.on("connect", () => {
    console.log("Connected to MQTT broker");
    mqttClient.subscribe("clinic/patients/+/vitals", (err) => {
      if (err) console.error("Subscribe failed:", err);
      else console.log("Subscribed to clinic/patients/+/vitals");
    });
  });

  mqttClient.on("error", (err) => {
    console.error("MQTT error:", err);
  });

  // Express + socket.io
  const app = express();
  app.use(cors());
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });

  // REST: return latest vitals per patient
  app.get("/api/patients", async (req, res) => {
    const [rows] = await pool.query(`
      SELECT t.patient_id, t.device_mac, t.spo2, t.hr, t.ts, t.received_at
      FROM vitals t
      INNER JOIN (
        SELECT patient_id, MAX(received_at) as mx FROM vitals GROUP BY patient_id
      ) m ON t.patient_id = m.patient_id AND t.received_at = m.mx
      ORDER BY t.patient_id
    `);
    res.json(rows);
  });

  // REST: return whether a given patient_id is a real device
  app.get("/api/patients/:id/isReal", (req, res) => {
    res.json({ isReal: isDevicePatientId(req.params.id) });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`Bridge HTTP + socket.io listening on ${HTTP_PORT}`);
  });

  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      // expected payload from ESP32: { id: "PT-1000", mac: "...", spo2: ..., hr: ..., ts: ... }
      // NO name field — patient identity is purely ID-based
      const topicMatch = topic.match(/^clinic\/patients\/([^/]+)\/vitals$/);
      const topicPatientId = topicMatch ? topicMatch[1] : null;
      const patientId = payload.id || payload.patient_id || topicPatientId || "unknown";
      const deviceMac = payload.mac || payload.device_mac || null;
      const spo2 = typeof payload.spo2 === "number" ? payload.spo2 : null;
      const hr = typeof payload.hr === "number" ? payload.hr : null;
      const ts = payload.ts || Date.now();

      const isReal = isDevicePatientId(patientId);
      console.log(`[${isReal ? "REAL" : "sim"}] ${patientId} → SpO2:${spo2} HR:${hr}`);

      // Emit to connected dashboards
      const emitPayload = {
        patient_id: patientId,
        device_mac: deviceMac,
        spo2,
        hr,
        ts,
        received_at: Date.now(),
        isReal,  // dashboard can use this to distinguish real vs simulated
      };
      io.emit("vitals", emitPayload);

      // Store in DB after emitting so MySQL latency does not delay live UI updates.
      pool.query(
        "INSERT INTO vitals (patient_id, device_mac, spo2, hr, ts) VALUES (?, ?, ?, ?, ?)",
        [patientId, deviceMac, spo2, hr, ts]
      ).catch((err) => console.error("DB insert failed:", err));

      console.log("Saved & emitted:", emitPayload);
    } catch (err) {
      console.error("Failed to handle message", err);
    }
  });

  io.on("connection", (socket) => {
    console.log("Dashboard connected:", socket.id);
    socket.on("disconnect", () => console.log("Dashboard disconnected:", socket.id));
  });
}

main().catch((err) => {
  console.error("Bridge error", err);
  process.exit(1);
});
