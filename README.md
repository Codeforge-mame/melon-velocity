# Melon Velocity

A full-stack cross-platform application built with **Expo (React Native)** for the client, **FastAPI (Python)** for the backend API, and **Docker Compose** for containerized orchestration.

---

## Project Structure

```text
melon-velocity/
├── .devcontainer/     # Development container configuration
├── expo-client/       # Cross-platform mobile & web frontend (Expo / React Native)
├── server/            # Backend REST API (Python / FastAPI)
└── .gitignore         # Git ignore rules
```

---

## Prerequisites

Ensure you have the following installed on your machine before getting started:

- **Git**
- **Docker** & **Docker Compose** (for containerized setup)
- **Node.js** (v18+ recommended) & **npm** or **yarn** (for local frontend development)
- **Python** (v3.10+ recommended) (for local backend development)
- **Expo Go** app on your iOS/Android device (optional, for physical device testing)

---

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/Codeforge-mame/melon-velocity.git
cd melon-velocity
```

### 2. Environment Configuration

Create environment files for both the server and client if required:

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

Run the full stack using Docker Compose:

```bash
docker compose up --build
```

- **Backend API:** `http://localhost:8000`
- **API Documentation (Swagger UI):** `http://localhost:8000/docs`

### Option B: Manual Local Setup

#### 1. Start the FastAPI Server

```bash
cd server
python -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

#### 2. Start the Expo Client

Open a new terminal window:

```bash
cd expo-client
npm install
npx expo start
```

- Press **`w`** to open in a web browser.
- Press **`a`** to open on an Android emulator.
- Press **`i`** to open on an iOS simulator.
- Scan the QR code using the **Expo Go** app on your physical device.

---

## Tech Stack

- **Frontend:** React Native, Expo
- **Backend:** Python, FastAPI
- **DevOps & Tooling:** Docker, Docker Compose, Dev Containers

---

## Contributing

1. Fork the repository.
2. Create a new feature branch (`git checkout -b feature/your-feature`).
3. Commit your changes (`git commit -m 'Add some feature'`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a Pull Request.
