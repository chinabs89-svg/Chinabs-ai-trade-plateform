const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const STARTING_BALANCE = 10000;
const RISK_PERCENT = 0.0075;
const MAX_ANALYSIS_HISTORY = 500;

// Keep the existing filename so v0.8 can reuse v0.7 state.
const STATE_FILE =
  process.env.STATE_FILE ||
  "/data/chinab-v07-state.json";

let market = null;
let priceHistory = [];

let state = {
  schemaVersion: 9,

  cash: STARTING_BALANCE,
  openTrade: null,
  history: [],

  automation: false,

  peakPortfolio: STARTING_BALANCE,
  maxDrawdown: 0,

  lastAnalysis: null,
  lastMarketUpdate: null,
  lastSignal: "WAIT",
  lastDecision: null,

  analysisHistory: [],
  analysisCycles: 0,

  startedAt: Date.now()
};

function loadState() {
  try {

    if (!fs.existsSync(STATE_FILE))
      return;

    const saved =
      JSON.parse(
        fs.readFileSync(
          STATE_FILE,
          "utf8"
        )
      );

    state = {
      ...state,
      ...saved,

      history:
        Array.isArray(saved.history)
          ? saved.history
          : [],

      analysisHistory:
        Array.isArray(saved.analysisHistory)
          ? saved.analysisHistory
          : []
    };

    state.schemaVersion = 8;

    console.log(
      "Existing paper state loaded."
    );

  } catch (err) {

    console.error(
      "Could not load saved state:",
      err.message
    );
  }
}

function saveState() {
  try {

    const dir =
      path.dirname(
        STATE_FILE
      );

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(
        dir,
        {
          recursive: true
        }
      );
    }

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        state,
        null,
        2
      )
    );

  } catch (err) {

    console.error(
      "Could not save state:",
      err.message
    );
  }
}

function average(arr) {

  if (!arr.length)
    return 0;

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) /
    arr.length
  );
}

function calculateRSI(
  prices,
  period = 14
) {

  if (
    prices.length <
    period + 1
  )
    return 50;

  const recent =
    prices.slice(
      -(period + 1)
    );

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {

    const diff =
      recent[i] -
      recent[i - 1];

    if (diff > 0)
      gains += diff;
    else
      losses +=
        Math.abs(diff);
  }

  if (losses === 0)
    return 100;

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function getIndicators() {

  if (
    !market ||
    priceHistory.length < 36
  )
    return null;

  const shortMA =
    average(
      priceHistory.slice(-12)
    );

  const longMA =
    average(
      priceHistory.slice(-36)
    );

  const rsi =
    calculateRSI(
      priceHistory,
      14
    );

  return {
    shortMA,
    longMA,
    rsi
  };
}

function determineSignal() {

  const ind =
    getIndicators();

  if (!ind) {

    return {
      signal: "WAIT",
      score: 0,
      reason:
        "Insufficient historical data.",
      rules: []
    };
  }

  const change =
    Number(
      market.change || 0
    );

  const rules = [];

  if (
    Math.abs(change) >= 8
  ) {

    return {
      signal: "WAIT",
      score: 0,

      reason:
        "Extreme 24-hour volatility filter is active.",

      rules: [
        {
          name: "Trend",
          passed: false,
          detail:
            "Trade evaluation blocked"
        },
        {
          name: "Momentum",
          passed: false,
          detail:
            "Trade evaluation blocked"
        },
        {
          name: "24h Direction",
          passed: false,
          detail:
            change.toFixed(2) +
            "%"
        },
        {
          name: "Volatility",
          passed: false,
          detail:
            Math.abs(change)
              .toFixed(2) +
            "% exceeds safety limit"
        },
        {
          name:
            "Entry Confirmation",
          passed: false,
          detail:
            "Blocked by volatility filter"
        }
      ]
    };
  }

  let longScore = 0;
  let shortScore = 0;

  const bullishTrend =
    ind.shortMA >
    ind.longMA;

  if (bullishTrend)
    longScore += 2;
  else
    shortScore += 2;

  rules.push({
    name: "Trend",
    passed: true,

    detail:
      bullishTrend
        ? "Short MA above Long MA"
        : "Short MA below Long MA"
  });

  const longMomentum =
    ind.rsi >= 52 &&
    ind.rsi <= 70;

  const shortMomentum =
    ind.rsi <= 48 &&
    ind.rsi >= 30;

  if (longMomentum)
    longScore += 2;

  if (shortMomentum)
    shortScore += 2;

  rules.push({
    name: "Momentum",

    passed:
      longMomentum ||
      shortMomentum,

    detail:
      "RSI-style momentum " +
      ind.rsi.toFixed(1)
  });

  const positiveChange =
    change > 0;

  if (positiveChange)
    longScore += 1;
  else
    shortScore += 1;

  rules.push({
    name: "24h Direction",
    passed: true,
    detail:
      change.toFixed(2) +
      "%"
  });

  rules.push({
    name: "Volatility",
    passed: true,
    detail:
      "Within safety limit"
  });

  let signal = "WAIT";

  let reason =
    "Indicators do not agree strongly enough.";

  if (longScore >= 4) {

    signal = "LONG";

    reason =
      "Trend and momentum conditions favour upside.";
  }

  if (shortScore >= 4) {

    signal = "SHORT";

    reason =
      "Trend and momentum conditions favour downside.";
  }

  rules.push({
    name:
      "Entry Confirmation",

    passed:
      signal !== "WAIT",

    detail:
      signal === "WAIT"
        ? "No confirmed entry"
        : signal +
          " confirmed"
  });

  return {
    signal,

    score:
      Math.max(
        longScore,
        shortScore
      ),

    reason,
    rules
  };
}

function tradePnl() {

  if (
    !state.openTrade ||
    !market
  )
    return 0;

  const t =
    state.openTrade;

  if (
    t.side === "LONG"
  ) {

    return (
      market.price -
      t.entry
    ) *
    t.quantity;
  }

  return (
    t.entry -
    market.price
  ) *
  t.quantity;
}

function getPortfolioValue() {

  let total =
    Number(
      state.cash || 0
    );

  if (state.openTrade) {

    total +=
      Number(
        state.openTrade
          .positionValue || 0
      ) +
      tradePnl();
  }

  return total;
}

function updateDrawdown() {

  const total =
    getPortfolioValue();

  if (
    total >
    state.peakPortfolio
  ) {

    state.peakPortfolio =
      total;
  }

  const drawdown =
    state.peakPortfolio > 0

      ? (
          (
            state.peakPortfolio -
            total
          ) /
          state.peakPortfolio
        ) * 100

      : 0;

  if (
    drawdown >
    state.maxDrawdown
  ) {

    state.maxDrawdown =
      drawdown;
  }
}

function openTrade(side) {

  if (
    state.openTrade ||
    !market
  )
    return;

  const entry =
    market.price;

  const stopDistance =
    entry * 0.025;

  const riskCash =
    getPortfolioValue() *
    RISK_PERCENT;

  let quantity =
    riskCash /
    stopDistance;

  let positionValue =
    quantity *
    entry;

  if (
    positionValue >
    state.cash
  ) {

    positionValue =
      state.cash;

    quantity =
      positionValue /
      entry;
  }

  let stop;
  let target;

  if (
    side === "LONG"
  ) {

    stop =
      entry * 0.975;

    target =
      entry * 1.05;

  } else {

    stop =
      entry * 1.025;

    target =
      entry * 0.95;
  }

  state.openTrade = {
    side,
    entry,
    stop,
    target,
    quantity,
    positionValue,

    riskCash,

    openedAt:
      Date.now()
  };

  state.cash -=
    positionValue;

  console.log(
    "PAPER TRADE OPENED:",
    side,
    entry
  );

  saveState();
}

function closeTrade(reason) {

  if (
    !state.openTrade ||
    !market
  )
    return;

  const t =
    state.openTrade;

  const pnl =
    tradePnl();

  const returnPercent =
    t.positionValue
      ? (
          pnl /
          t.positionValue
        ) * 100
      : 0;

  const durationMs =
    Date.now() -
    t.openedAt;

  state.cash +=
    t.positionValue +
    pnl;

  state.history.unshift({
    side:
      t.side,

    entry:
      t.entry,

    exit:
      market.price,

    quantity:
      t.quantity,

    positionValue:
      t.positionValue,

    pnl,

    returnPercent,

    reason,

    openedAt:
      t.openedAt,

    closedAt:
      Date.now(),

    durationMs
  });

  console.log(
    "PAPER TRADE CLOSED:",
    reason,
    "P&L:",
    pnl.toFixed(2)
  );

  state.openTrade =
    null;

  updateDrawdown();
  saveState();
}

function checkOpenTrade() {

  if (
    !state.openTrade ||
    !market
  )
    return;

  const t =
    state.openTrade;

  if (
    t.side === "LONG" &&
    market.price <=
      t.stop
  ) {

    closeTrade(
      "Stop loss"
    );

    return;
  }

  if (
    t.side === "LONG" &&
    market.price >=
      t.target
  ) {

    closeTrade(
      "Take profit"
    );

    return;
  }

  if (
    t.side === "SHORT" &&
    market.price >=
      t.stop
  ) {

    closeTrade(
      "Stop loss"
    );

    return;
  }

  if (
    t.side === "SHORT" &&
    market.price <=
      t.target
  ) {

    closeTrade(
      "Take profit"
    );
  }
}

async function loadMarket() {

  const simpleUrl =
    "https://api.coingecko.com/api/v3/simple/price" +
    "?ids=bitcoin" +
    "&vs_currencies=cad" +
    "&include_24hr_change=true";

  const chartUrl =
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart" +
    "?vs_currency=cad" +
    "&days=7";

  try {

    const [
      simpleRes,
      chartRes
    ] =
      await Promise.all([
        fetch(simpleUrl),
        fetch(chartUrl)
      ]);

    if (
      !simpleRes.ok ||
      !chartRes.ok
    ) {

      throw new Error(
        "CoinGecko request failed"
      );
    }

    const simple =
      await simpleRes.json();

    const chart =
      await chartRes.json();

    market = {
      price:
        simple.bitcoin.cad,

      change:
        simple.bitcoin
          .cad_24h_change
    };

    priceHistory =
      chart.prices.map(
        item => item[1]
      );

    state.lastMarketUpdate =
      Date.now();

    return true;

  } catch (err) {

    console.error(
      "Market error:",
      err.message
    );

    return false;
  }
}

function recordAnalysis(
  decision,
  source = "automatic"
) {

  const ind =
    getIndicators();

  const record = {
    time:
      Date.now(),

    source,

    price:
      market
        ? market.price
        : null,

    change24:
      market
        ? market.change
        : null,

    shortMA:
      ind
        ? ind.shortMA
        : null,

    longMA:
      ind
        ? ind.longMA
        : null,

    rsi:
      ind
        ? ind.rsi
        : null,

    signal:
      decision.signal,

    score:
      decision.score,

    reason:
      decision.reason,

    openTrade:
      state.openTrade
        ? state.openTrade.side
        : null,

    portfolio:
      getPortfolioValue()
  };

  state.analysisHistory.unshift(
    record
  );

  if (
    state.analysisHistory.length >
    MAX_ANALYSIS_HISTORY
  ) {

    state.analysisHistory =
      state.analysisHistory.slice(
        0,
        MAX_ANALYSIS_HISTORY
      );
  }

  state.analysisCycles =
    Number(
      state.analysisCycles || 0
    ) + 1;
}

async function performAnalysis(
  source = "automatic",
  allowEntry = true
) {

  const loaded =
    await loadMarket();

  if (!loaded)
    return false;

  checkOpenTrade();

  const decision =
    determineSignal();

  state.lastAnalysis =
    Date.now();

  state.lastSignal =
    decision.signal;

  state.lastDecision =
    decision;

  recordAnalysis(
    decision,
    source
  );

  if (
    allowEntry &&
    !state.openTrade &&
    (
      decision.signal ===
        "LONG" ||
      decision.signal ===
        "SHORT"
    )
  ) {

    openTrade(
      decision.signal
    );
  }

  updateDrawdown();
  saveState();

  return true;
}

async function tradingCycle() {

  if (
    !state.automation
  )
    return;

  console.log(
    "Running automated v0.8 paper analysis..."
  );

  await performAnalysis(
    "automatic",
    true
  );
}

function performance() {

  const total =
    state.history.length;

  const wins =
    state.history.filter(
      x => x.pnl > 0
    ).length;

  const losses =
    state.history.filter(
      x => x.pnl < 0
    ).length;

  const breakEven =
    state.history.filter(
      x => x.pnl === 0
    ).length;

  const realizedPnl =
    state.history.reduce(
      (
        sum,
        x
      ) =>
        sum +
        Number(
          x.pnl || 0
        ),

      0
    );

  const grossProfit =
    state.history
      .filter(
        x => x.pnl > 0
      )
      .reduce(
        (
          sum,
          x
        ) =>
          sum + x.pnl,

        0
      );

  const grossLoss =
    Math.abs(
      state.history
        .filter(
          x => x.pnl < 0
        )
        .reduce(
          (
            sum,
            x
          ) =>
            sum + x.pnl,

          0
        )
    );

  const averagePnl =
    total
      ? realizedPnl /
        total
      : 0;

  const profitFactor =
    grossLoss > 0
      ? grossProfit /
        grossLoss
      : grossProfit > 0
      ? null
      : 0;

  return {
    total,
    wins,
    losses,
    breakEven,

    winRate:
      total
        ? (
            wins /
            total
          ) * 100
        : 0,

    realizedPnl,
    grossProfit,
    grossLoss,
    averagePnl,
    profitFactor
  };
}

function signalStats() {

  const records =
    state.analysisHistory || [];

  return {
    total:
      records.length,

    long:
      records.filter(
        x =>
          x.signal ===
          "LONG"
      ).length,

    short:
      records.filter(
        x =>
          x.signal ===
          "SHORT"
      ).length,

    wait:
      records.filter(
        x =>
          x.signal ===
          "WAIT"
      ).length
  };
}

function apiState() {

  return {
    version: "0.8",

    schemaVersion:
      state.schemaVersion,

    automation:
      state.automation,

    market,

    indicators:
      getIndicators(),

    decision:
      state.lastDecision,

    cash:
      state.cash,

    portfolio:
      getPortfolioValue(),

    openTrade:
      state.openTrade

        ? {
            ...state.openTrade,

            currentPnl:
              tradePnl()
          }

        : null,

    history:
      state.history.slice(
        0,
        50
      ),

    performance:
      performance(),

    maxDrawdown:
      state.maxDrawdown,

    lastAnalysis:
      state.lastAnalysis,

    lastMarketUpdate:
      state.lastMarketUpdate,

    analysisCycles:
      state.analysisCycles,

    signalStats:
      signalStats(),

    analysisHistory:
      state.analysisHistory.slice(
        0,
        100
      ),

    serverStartedAt:
      state.startedAt,

    serverTime:
      Date.now(),

    liveTrading:
      false,

    leverage:
      false,

    riskPercent:
      RISK_PERCENT
  };
}

function sendJson(
  res,
  status,
  data
) {

  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json",

      "Cache-Control":
        "no-store"
    }
  );

  res.end(
    JSON.stringify(
      data
    )
  );
}

function serveStatic(
  req,
  res
) {

  let requestPath =
    req.url.split("?")[0];

  let filePath =
    requestPath === "/"
      ? "/index.html"
      : requestPath;

  const publicDir =
    path.join(
      __dirname,
      "public"
    );

  filePath =
    path.join(
      publicDir,
      filePath
    );

  if (
    !filePath.startsWith(
      publicDir
    )
  ) {

    res.writeHead(403);

    res.end(
      "Forbidden"
    );

    return;
  }

  fs.readFile(
    filePath,
    (
      err,
      data
    ) => {

      if (err) {

        res.writeHead(404);

        res.end(
          "Not found"
        );

        return;
      }

      const ext =
        path.extname(
          filePath
        );

      const types = {
        ".html":
          "text/html",

        ".css":
          "text/css",

        ".js":
          "application/javascript",

        ".json":
          "application/json"
      };

      res.writeHead(
        200,
        {
          "Content-Type":
            types[ext] ||
            "text/plain",

          "Cache-Control":
            "no-store"
        }
      );

      res.end(data);
    }
  );
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      if (
        req.method ===
          "GET" &&
        req.url ===
          "/api/state"
      ) {

        sendJson(
          res,
          200,
          apiState()
        );

        return;
      }

      if (
        req.method ===
          "GET" &&
        req.url ===
          "/api/health"
      ) {

        sendJson(
          res,
          200,
          {
            ok: true,
            version: "0.8",
            automation:
              state.automation,
            serverTime:
              Date.now(),
            lastAnalysis:
              state.lastAnalysis
          }
        );

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/api/start"
      ) {

        state.automation =
          true;

        saveState();

        await performAnalysis(
          "automation-start",
          true
        );

        sendJson(
          res,
          200,
          {
            ok: true,
            automation: true
          }
        );

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/api/stop"
      ) {

        state.automation =
          false;

        saveState();

        sendJson(
          res,
          200,
          {
            ok: true,
            automation: false
          }
        );

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/api/analyze"
      ) {

        await performAnalysis(
          "manual",
          false
        );

        sendJson(
          res,
          200,
          apiState()
        );

        return;
      }

      if (
        req.method ===
          "POST" &&
        req.url ===
          "/api/close"
      ) {

        if (
          state.openTrade
        ) {

          await loadMarket();

          closeTrade(
            "Manual close"
          );
        }

        sendJson(
          res,
          200,
          apiState()
        );

        return;
      }

      serveStatic(
        req,
        res
      );
    }
  );

loadState();

loadMarket()
  .then(() => {

    checkOpenTrade();

    updateDrawdown();

    saveState();
  });

setInterval(
  tradingCycle,
  60 * 1000
);

server.listen(
  PORT,
  () => {

    console.log(
      "Chinab's AI Trade Platform v0.8 running on port",
      PORT
    );

    console.log(
      "PAPER TRADING ONLY"
    );

    console.log(
      "LIVE TRADING: OFF"
    );

    console.log(
      "State file:",
      STATE_FILE
    );
  }
);