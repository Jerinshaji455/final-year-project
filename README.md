# 🏥 VitalNetAI – Real-Time IoT Patient Monitoring System

VitalNetAI is a real-time IoT-based healthcare monitoring system that captures patient vitals using an ESP32 device and visualizes them on a live dashboard using MQTT communication.

The system runs entirely on a local network, ensuring low latency and no cloud dependency.

---

## 🚀 System Architecture

ESP32 (Sensor Node)  
↓ (MQTT Publish)  
Mosquitto Broker (Local Server)  
↓  
Node.js Bridge  
↓  
Frontend Dashboard (React)

---

## 📁 Project Structure

final-year-project/

├── mosquitto.conf  
├── mosquitto.exe  
├── vitalnetai.cpp  

├── bridge/  
│   ├── bridge.js  
│   ├── package.json  

├── pages/  
│   ├── dashboard.jsx  
│   ├── Sign_in.jsx  
│   ├── Sign_up.jsx  

└── README.md  

---

## ⚙️ Prerequisites

- Node.js (v16 or higher)
- npm
- Arduino IDE / PlatformIO
- ESP32 USB drivers
- Same WiFi network for ESP32 and PC

---

## 🔧 Setup Instructions (Follow EXACT order)

### 🥇 Step 1: Flash ESP32 Firmware

Open `vitalnetai.cpp` and update:

const char* ssid = "YOUR_WIFI_NAME";  
const char* password = "YOUR_WIFI_PASSWORD";  
const char* mqtt_server = "YOUR_PC_IP";  

Notes:
- Replace `YOUR_PC_IP` with your computer’s local IP (example: 192.168.x.x)
- ESP32 and PC must be on the same network

Upload steps:
- Connect ESP32 via USB
- Select correct COM port
- Flash the code

---

### 🥈 Step 2: Start MQTT Broker (Mosquitto)

Open terminal in the project root (where mosquitto.exe exists)

Run:

.\mosquitto.exe -c .\mosquitto.conf -v

Expected:
- Broker starts successfully
- Running on port 1883

---

### 🥉 Step 3: Start Node Bridge

Navigate to bridge folder:

cd bridge

Install dependencies:

npm install

Run:

node bridge.js

---

### 🏁 Step 4: Run Frontend Dashboard

Navigate to pages folder:

cd pages

Install dependencies:

npm install

Run:

npm run dev

Open in browser:

http://localhost:3000

---

## 📡 Data Flow

ESP32 → MQTT → Mosquitto → Bridge → Dashboard

---

## 📊 Features

- Real-time vital monitoring (Heart Rate, SpO₂)
- MQTT-based communication
- Fully local deployment
- Modular architecture

---

## ⚠️ Troubleshooting

ESP32 not connecting:
- Check WiFi credentials
- Ensure same network

No data on dashboard:
- Ensure Mosquitto is running
- Ensure bridge is running
- Verify MQTT IP matches in ESP32 code

MQTT connection failed:
- Check broker IP
- Ensure port 1883 is not blocked by firewall

npm issues:
- Run: npm install --force

---

## 🔐 Notes

- This project is for academic/research use
- No external data sharing
- Works entirely on local network

---

## 👨‍💻 Contributors

- Jerin Shaji
- Team Members

---

## ✅ Final Outcome

If all steps are followed correctly, you will see real-time patient vitals updating live on the dashboard.