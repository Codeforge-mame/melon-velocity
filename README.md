# 🚀 Melon Velocity

[![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React Native](https://img.shields.io/badge/React_Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactnative.dev/)
[![Expo](https://img.shields.io/badge/Expo-000000?style=for-the-badge&logo=expo&logoColor=white)](https://expo.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)

A full-stack, cross-platform application featuring an **Expo (React Native)** client, a **FastAPI (Python)** REST API, and **Docker Compose** for containerized orchestration.

---

## 🏗️ Project Structure

```text
melon-velocity/
├── .devcontainer/     # Development container configuration
├── expo-client/       # Cross-platform mobile & web frontend (Expo / React Native)
├── server/            # Backend REST API (Python / FastAPI)
└── .gitignore         # Git ignore rules
```
---

📋 Prerequisites
Ensure you have the following installed on your machine before getting started:

Git

Docker & Docker Compose

Node.js (v18+ recommended) & npm or yarn

Python (v3.10+ recommended) & uv (Package manager)

Expo Go app on your iOS/Android device (optional)
---

🚀 Getting Started
1. Clone the Repository
```Bash
git clone [https://github.com/Codeforge-mame/melon-velocity.git](https://github.com/Codeforge-mame/melon-velocity.git)
cd melon-velocity
```

### 2. Environment Configuration

Copy the example environment files for both the server and client:

```bash
# Backend environment variables
cp server/.env.example server/.env

# Frontend environment variables
cp expo-client/.env.example expo-client/.env
```
*(Update the `.env` files with your specific API keys, database URLs, and local IP address for Expo.)*

---

## Running the Application

### Option A: Using Docker Compose (Recommended)

#### 1. Start the backend server:
  ```bash
     cd server
     docker compose up --build
  ```

#### 2.Start the Expo client (in a new terminal window):
   ```bash
    cd expo-client
    npx expo start
   ```

- **Backend API:** `http://localhost:8000`
- **API Documentation (Swagger UI):** `http://localhost:8000/docs`

### Option B: Manual Local Setup

#### 1. Start the FastAPI Server

```bash
cd server

# Sync environment using uv
uv sync

# Activate virtual environment
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate

# Launch FastAPI server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

#### 2. Start the Expo Client

Open a new terminal window:

```bash
cd expo-client

# Install frontend dependencies
npm install

# Start Expo dev server
npx expo start
```

**Controls:**
- Press **`w`** to open in a web browser.
- Press **`a`** to open on an Android emulator.
- Press **`i`** to open on an iOS simulator.
- Scan the QR code using the **Expo Go** app on your physical device.

---

## Tech Stack

- **Frontend:** React Native, Expo, TypeScript
- **Backend:** Python, FastAPI, UV
- **DevOps & Tooling:** Docker, Docker Compose

---

## Contributing

1. Fork the repository.
2. Create a new feature branch (`git checkout -b feature/your-feature`).
3. Commit your changes (`git commit -m 'Add some feature'`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a Pull Request.
