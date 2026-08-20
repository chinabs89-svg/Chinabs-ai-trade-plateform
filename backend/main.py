import os
import time
import threading
from datetime import datetime, timezone

import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Chinab's AI Trade Platform", version="0.7")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STARTING_BALANCE = float(os.getenv("STARTING_BALANCE", "10000"))
RISK_PERCENT = float(os.getenv("RISK_PERCENT", "0.0075"))
CHECK_INTERVAL_SECONDS = int(os.getenv("CHECK_INTERVAL_SECONDS", "60"))

state = {
    "mode": "PAPER",
    "automation": True,
    "starting_balance": STARTING_BALANCE,
    "cash": STARTING_BALANCE,
    "portfolio_value": STARTING_BALANCE,
    "btc_cad": None,
    "change_24h": None,
    "signal": "WAIT",
    "last_update": None,
    "message": "Paper-trading backend started.",
}


def get_market():
    url = (
        "https://api.coingecko.com/api/v3/simple/price"
        "?ids=bitcoin"
        "&vs_currencies=cad"
        "&include_24hr_change=true"
    )

    response = requests.get(url, timeout=15)
    response.raise_for_status()
    data = response.json()["bitcoin"]

    return float(data["cad"]), float(data.get("cad_24h_change", 0))


def analyze_market():
    try:
        price, change = get_market()

        if abs(change) >= 8:
            signal = "WAIT"
            message = "Extreme-volatility filter active."
        elif change >= 1:
            signal = "LONG"
            message = "Positive 24-hour momentum detected."
        elif change <= -1:
            signal = "SHORT"
            message = "Negative 24-hour momentum detected."
        else:
            signal = "WAIT"
            message = "No strong paper-trading signal."

        state.update(
            {
                "btc_cad": price,
                "change_24h": change,
                "signal": signal,
                "last_update": datetime.now(timezone.utc).isoformat(),
                "message": message,
            }
        )

    except Exception as exc:
        state["last_update"] = datetime.now(timezone.utc).isoformat()
        state["message"] = f"Market update error: {exc}"


def worker():
    while True:
        if state["automation"]:
            analyze_market()
        time.sleep(CHECK_INTERVAL_SECONDS)


@app.get("/")
def root():
    return {
        "name": "Chinab's AI Trade Platform",
        "version": "0.7",
        "mode": "PAPER TRADING ONLY",
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "0.7",
        "mode": "paper",
    }


@app.get("/state")
def get_state():
    return state


@app.post("/analyze")
def analyze():
    analyze_market()
    return state


threading.Thread(target=worker, daemon=True).start()