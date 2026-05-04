// bridge.js
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

async function main() {
  // MySQL pool
  const pool = mysql.createPool(MYSQL_CONFIG);

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vitals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      patient_id VARCHAR(64),
      patient_name VARCHAR(255),
      spo2 INT,
      hr INT,
      ts BIGINT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

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

  // Basic REST: return latest vitals per patient (simple snapshot)
  app.get("/api/patients", async (req, res) => {
    const [rows] = await pool.query(`
      SELECT t.patient_id, t.patient_name, t.spo2, t.hr, t.ts, t.received_at
      FROM vitals t
      INNER JOIN (
        SELECT patient_id, MAX(received_at) as mx FROM vitals GROUP BY patient_id
      ) m ON t.patient_id = m.patient_id AND t.received_at = m.mx
      ORDER BY t.patient_id
    `);
    res.json(rows);
  });

  server.listen(HTTP_PORT, () => {
    console.log(`Bridge HTTP + socket.io listening on ${HTTP_PORT}`);
  });

  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      // expected: {id:"PT-1000", name:"Jerin Shaji", spo2:..., hr:..., ts:...}
      const patientId = payload.id || payload.patient_id || "unknown";
      const patientName = payload.name || payload.patient_name || "Unknown";
      const spo2 = typeof payload.spo2 === "number" ? payload.spo2 : null;
      const hr = typeof payload.hr === "number" ? payload.hr : null;
      const ts = payload.ts || Date.now();

      // Insert into DB
      await pool.query(
        "INSERT INTO vitals (patient_id, patient_name, spo2, hr, ts) VALUES (?, ?, ?, ?, ?)",
        [patientId, patientName, spo2, hr, ts]
      );

      // Emit to connected dashboards right away
      const emitPayload = {
        patient_id: patientId,
        patient_name: patientName,
        spo2,
        hr,
        ts,
        received_at: Date.now(),
      };
      io.emit("vitals", emitPayload);
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
