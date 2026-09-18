import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_WALLET = "0x0000000000000000000000000000000000000000";
const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");

loadDotEnv(ENV_PATH);

const configPath = process.env.CONFIG_PATH || path.join(ROOT, "config.json");
const statePath = process.env.STATE_PATH || path.join(ROOT, "state.json");
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const DEFAULT_SUBGRAPH_POSITIONS_QUERY = `
  query Positions($owner: String!) {
    positions(where: { owner: $owner, liquidity_gt: "0" }) {
      id
      owner
      liquidity
      depositedToken0
      depositedToken1
      withdrawnToken0
      withdrawnToken1
      token0 {
        symbol
        derivedETH
      }
      token1 {
        symbol
        derivedETH
      }
      tickLower {
        tickIdx
      }
      tickUpper {
        tickIdx
      }
      pool {
        id
        tick
        totalValueLockedUSD
        feesUSD
        poolDayData(first: 7, orderBy: date, orderDirection: desc) {
          date
          feesUSD
          tvlUSD
        }
        token0 {
          symbol
          derivedETH
        }
        token1 {
          symbol
          derivedETH
        }
      }
    }
    bundles(first: 1) {
      ethPriceUSD
    }
  }
`;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig(configPath);
  const intervalMs = Number(process.env.CHECK_INTERVAL_SECONDS || config.checkIntervalSeconds || 60) * 1000;

  if (once) {
    await runCheck(config);
    return;
  }

  await runCheck(config).catch((error) => console.error("[monitor] check failed:", error));
  setInterval(() => {
    runCheck(config).catch((error) => console.error("[monitor] check failed:", error));
  }, intervalMs);
}

async function runCheck(config) {
  const wallet = process.env.WALLET || config.wallet || DEFAULT_WALLET;
  const state = readState(statePath);
  const sources = (config.sources || []).filter((source) => source.enabled !== false);

  if (sources.length === 0) {
    console.log("No enabled sources. Edit config.json and set enabled=true after adding each API URL.");
    return;
  }

  const allPositions = [];
  const nestRewards = [];
  for (const source of sources) {
    try {
      const positions = await fetchSource(source, wallet);
      allPositions.push(...positions);
      console.log(`[${source.name}] ${positions.length} position(s) checked`);
      if (source.parser === "nest") {
        const rewards = await fetchNestRewards(source, wallet);
        if (rewards) nestRewards.push(rewards);
      }
    } catch (error) {
      console.error(`[${source.name}] failed: ${error.message}`);
    }
  }

  enrichPositionUsdSizes(allPositions);
  const holdingsSummary = formatHoldingsSummary(allPositions);
  const holdingsMessage = formatHoldingsTelegramMessage(holdingsSummary, allPositions, nestRewards);
  console.log(`\n${formatTerminalMessage(holdingsMessage)}\n`);
  const alerts = diffState(state, allPositions);
  writeState(statePath, state);

  if (dryRun) {
    console.log("[dry-run] Telegram send skipped.");
  } else {
    await sendTelegram(holdingsMessage);
  }

  for (const alert of alerts) {
    const message = formatTelegramMessage(alert, holdingsSummary);
    console.log(`\n${formatTerminalMessage(message)}\n`);
    if (dryRun) {
      console.log("[dry-run] Telegram alert send skipped.");
    } else {
      await sendTelegram(message);
    }
  }

  if (alerts.length === 0) {
    console.log("No out-of-range positions.");
  }
}

async function fetchSource(source, wallet) {
  if (source.type === "api") {
    return fetchApiSource(source, wallet);
  }
  if (source.type === "subgraph") {
    return fetchSubgraphSource(source, wallet);
  }

  throw new Error(`Unsupported source type: ${source.type}`);
}

async function fetchApiSource(source, wallet) {
  const url = source.url.replaceAll("{wallet}", wallet);
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "user-agent": "hyperevm-pool-range-monitor/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  const data = await response.json();
  if (source.parser === "nest") {
    return extractNestPositions(data, source.name);
  }
  return extractPositions(data, source.name);
}

async function fetchSubgraphSource(source, wallet) {
  const query = source.query || DEFAULT_SUBGRAPH_POSITIONS_QUERY;
  const variables = {
    wallet,
    owner: wallet.toLowerCase()
  };
  const response = await fetch(source.url, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "user-agent": "hyperevm-pool-range-monitor/1.0"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${source.url}`);
  }

  const data = await response.json();
  if (data.errors?.length) {
    throw new Error(`Subgraph error: ${data.errors.map((error) => error.message).join("; ")}`);
  }
  return extractSubgraphPositions(data.data || data, source.name);
}

async function fetchNestRewards(source, wallet) {
  const url = (source.rewardsUrl || "https://app.usenest.xyz/api/blaze/claim/claim-status?publicAddress={wallet}")
    .replaceAll("{wallet}", wallet);

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "hyperevm-pool-range-monitor/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }

    const data = await response.json();
    const decimals = source.rewardsDecimals ?? 18;
    const rawTotalRewards = readString(data, ["totalAvailable", "amount", "totalRewards", "availableRewards"]);
    const rawClaimed = readString(data, ["totalClaimed", "claimed", "claimedRewards"]);
    const totalRewardsAmount = rawTokenAmountToNumber(rawTotalRewards, decimals);
    const claimedAmount = rawTokenAmountToNumber(rawClaimed, decimals) || 0;
    const availableAmount = Number.isFinite(totalRewardsAmount)
      ? Math.max(totalRewardsAmount - claimedAmount, 0)
      : undefined;
    const tokenPriceUsd = await fetchNestTokenPriceUsd(source);
    const availableValueUsd = Number.isFinite(availableAmount) && Number.isFinite(tokenPriceUsd)
      ? availableAmount * tokenPriceUsd
      : undefined;

    return {
      sourceName: source.name,
      symbol: source.rewardsSymbol || "NEST",
      availableAmount,
      availableValueUsd,
      tokenPriceUsd
    };
  } catch (error) {
    console.error(`[${source.name}] rewards failed: ${error.message}`);
    return null;
  }
}

async function fetchNestTokenPriceUsd(source) {
  if (Number.isFinite(source.rewardsPriceUsd)) return source.rewardsPriceUsd;
  const urls = source.rewardsPriceUrl
    ? [source.rewardsPriceUrl]
    : [
        "https://api.coingecko.com/api/v3/simple/price?ids=nest-2&vs_currencies=usd",
        "https://coins.llama.fi/prices/current/hyperevm:0x07c57E32a3C29D5659bda1d3EFC2E7BF004E3035"
      ];
  let lastError;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "hyperevm-pool-range-monitor/1.0"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const data = await response.json();
      const price = extractUsdPrice(data);
      if (Number.isFinite(price)) return price;
      throw new Error(`No USD price in ${url}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No NEST price source configured");
}

function extractUsdPrice(data) {
  const direct = readNumber(data, ["nest-2.usd", "usd", "priceUsd", "priceUSD"]);
  if (Number.isFinite(direct)) return direct;
  for (const coin of Object.values(data?.coins || {})) {
    const price = readNumber(coin, ["price", "usd", "priceUsd", "priceUSD"]);
    if (Number.isFinite(price)) return price;
  }
  return undefined;
}

function extractSubgraphPositions(data, sourceName) {
  if (!Array.isArray(data?.positions)) return extractPositions(data, sourceName);

  const nativePriceUsd = readNumber(data.bundles?.[0] || {}, ["ethPriceUSD", "nativePriceUSD"]);
  return data.positions.map((raw) => {
    const position = normalizePosition(raw, sourceName);
    if (!position) return null;

    const token0 = raw.token0 || raw.pool?.token0;
    const token1 = raw.token1 || raw.pool?.token1;
    const token0Usd = readSubgraphTokenUsd(token0, nativePriceUsd);
    const token1Usd = readSubgraphTokenUsd(token1, nativePriceUsd);
    const amount0 = readNumber(raw, ["depositedToken0"]);
    const amount1 = readNumber(raw, ["depositedToken1"]);
    const withdrawn0 = readNumber(raw, ["withdrawnToken0"]) || 0;
    const withdrawn1 = readNumber(raw, ["withdrawnToken1"]) || 0;
    const netAmount0 = Number.isFinite(amount0) ? Math.max(amount0 - withdrawn0, 0) : undefined;
    const netAmount1 = Number.isFinite(amount1) ? Math.max(amount1 - withdrawn1, 0) : undefined;
    const sizeUsd = Number.isFinite(token0Usd) && Number.isFinite(token1Usd) && Number.isFinite(netAmount0) && Number.isFinite(netAmount1)
      ? netAmount0 * token0Usd + netAmount1 * token1Usd
      : position.sizeUsd;
    const apr = Number.isFinite(position.apr) ? position.apr : estimatePoolApr(raw.pool || {});

    return {
      ...position,
      token0Symbol: readString(token0 || {}, ["symbol"]),
      token1Symbol: readString(token1 || {}, ["symbol"]),
      token0Amount: netAmount0,
      token1Amount: netAmount1,
      token0Usd,
      token1Usd,
      apr,
      sizeUsd,
      sizeUsdEstimated: Number.isFinite(sizeUsd) ? true : position.sizeUsdEstimated
    };
  }).filter(Boolean);
}

function readSubgraphTokenUsd(token, nativePriceUsd) {
  const derivedNative = readNumber(token || {}, ["derivedETH", "derivedNative"]);
  if (!Number.isFinite(derivedNative) || !Number.isFinite(nativePriceUsd)) return undefined;
  return derivedNative * nativePriceUsd;
}

function estimatePoolApr(pool) {
  const tvlUsd = readNumber(pool || {}, ["totalValueLockedUSD", "poolDayData.0.tvlUSD"]);
  if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return undefined;

  const dayData = Array.isArray(pool?.poolDayData) ? pool.poolDayData : [];
  const fees = dayData
    .map((day) => readNumber(day, ["feesUSD"]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (fees.length === 0) return undefined;

  const averageDailyFeesUsd = fees.reduce((sum, value) => sum + value, 0) / fees.length;
  return averageDailyFeesUsd * 365 / tvlUsd * 100;
}

function extractNestPositions(data, sourceName) {
  if (!Array.isArray(data)) return extractPositions(data, sourceName);

  return data
    .map((raw) => {
      const automaticPosition = extractNestAutomaticPosition(raw, sourceName);
      if (automaticPosition) return automaticPosition;

      const liquidity = readNumber(raw, ["v3.liquidity", "liquidity"]);
      if (Number.isFinite(liquidity) && liquidity <= 0) return null;

      const lowerPrice = readNumber(raw, ["v3.tickLower.price"]);
      const upperPrice = readNumber(raw, ["v3.tickUpper.price"]);
      const currentPrice = inferCurrentPrice(raw);
      if (!Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice) || !Number.isFinite(currentPrice)) return null;

      const tokenId = readString(raw, ["v3.tokenId"]);
      const poolAddress = readString(raw, ["poolAddress"]);
      const poolName = buildPairName(raw);
      const keyValue = tokenId || poolAddress || poolName;
      const token0Symbol = readString(raw, ["token0.basetoken.symbol", "token0.symbol"]);
      const token1Symbol = readString(raw, ["token1.basetoken.symbol", "token1.symbol"]);
      const token0Amount = readTokenAmount(raw, "depositedToken0", "token0.decimals");
      const token1Amount = readTokenAmount(raw, "depositedToken1", "token1.decimals");
      const token0Usd = readNumber(raw, ["token0.priceUSD", "token0.usdPrice", "token0PriceUSD"]);
      const token1Usd = readNumber(raw, ["token1.priceUSD", "token1.usdPrice", "token1PriceUSD"]);
      const fee0Amount = readTokenAmount(raw, "v3.claimable0", "token0.decimals");
      const fee1Amount = readTokenAmount(raw, "v3.claimable1", "token1.decimals");
      const fee0Usd = readTokenUsdValue(raw, "token0.priceUSD", fee0Amount);
      const fee1Usd = readTokenUsdValue(raw, "token1.priceUSD", fee1Amount);
      const unclaimedFeesUsd = sumFinite(fee0Usd, fee1Usd);

      return {
        key: `${sourceName}:${keyValue}`,
        sourceName,
        tokenId,
        poolAddress,
        poolName,
        lowerTick: readNumber(raw, ["v3.tickLower.tick"]),
        upperTick: readNumber(raw, ["v3.tickUpper.tick"]),
        currentTick: undefined,
        lowerPrice,
        upperPrice,
        currentPrice,
        apr: readNumber(raw, ["apr", "currentApr", "currentAPR", "aprPercent"]),
        sizeUsd: readNumber(raw, ["tvl", "valueUSD", "usdValue", "positionUsd", "totalValueUSD"]),
        sizeUsdEstimated: false,
        token0Symbol,
        token1Symbol,
        token0Amount,
        token1Amount,
        token0Usd,
        token1Usd,
        fee0Symbol: token0Symbol,
        fee1Symbol: token1Symbol,
        fee0Amount,
        fee1Amount,
        fee0Usd,
        fee1Usd,
        unclaimedFeesUsd,
        outOfRange: currentPrice < lowerPrice || currentPrice >= upperPrice,
        rawStatus: "unknown"
      };
    })
    .filter(Boolean);
}

function extractNestAutomaticPosition(raw, sourceName) {
  const external = raw.external;
  if (!external || !isNestAutomaticPosition(raw)) return null;

  const allowedSymbol = getNestAutomaticAllowedSymbol(raw);
  if (!isTrackedNestAutomaticAsset(allowedSymbol)) return null;

  const token0Symbol = readString(raw, ["token0.basetoken.symbol", "token0.symbol"]);
  const token1Symbol = readString(raw, ["token1.basetoken.symbol", "token1.symbol"]);
  const poolAddress = readString(raw, ["poolAddress"]);
  const vaultAddress = readString(external, ["vault"]);
  const pairName = buildPairName(raw);
  const label = `[${allowedSymbol}]`;

  return {
    key: `${sourceName}:automatic:${vaultAddress || poolAddress || `${pairName}:${allowedSymbol}`}`,
    sourceName,
    poolAddress,
    poolName: pairName ? `${pairName} (${label})` : label,
    lowerTick: undefined,
    upperTick: undefined,
    currentTick: undefined,
    lowerPrice: undefined,
    upperPrice: undefined,
    currentPrice: undefined,
    apr: readNumber(raw, ["apr", "currentApr", "currentAPR", "aprPercent"]),
    sizeUsd: readNumber(raw, ["tvl", "valueUSD", "usdValue", "positionUsd", "totalValueUSD"]),
    sizeUsdEstimated: false,
    token0Symbol,
    token1Symbol,
    token0Amount: readNumber(raw, ["token0Balance.amount"]),
    token1Amount: readNumber(raw, ["token1Balance.amount"]),
    token0Usd: readNumber(raw, ["token0.priceUSD", "token0.usdPrice", "token0PriceUSD"]),
    token1Usd: readNumber(raw, ["token1.priceUSD", "token1.usdPrice", "token1PriceUSD"]),
    outOfRange: false,
    rawStatus: "automatic",
    positionType: "automatic"
  };
}

function isNestAutomaticPosition(raw) {
  const external = raw.external;
  if (!external) return false;
  const type = readString(external, ["type"]) || readString(raw, ["type"]);
  const title = readString(external, ["title"]);
  return /ichi|automatic/i.test(type || "") || /automated|automatic/i.test(title || "");
}

function getNestAutomaticAllowedSymbol(raw) {
  const allowedToken = readString(raw, ["external.allowedToken"]);
  const token0Address = readString(raw, ["token0.tokenAddress", "token0.basetoken.address"]);
  const token1Address = readString(raw, ["token1.tokenAddress", "token1.basetoken.address"]);
  if (allowedToken && token0Address && allowedToken.toLowerCase() === token0Address.toLowerCase()) {
    return readString(raw, ["token0.basetoken.symbol", "token0.symbol"]);
  }
  if (allowedToken && token1Address && allowedToken.toLowerCase() === token1Address.toLowerCase()) {
    return readString(raw, ["token1.basetoken.symbol", "token1.symbol"]);
  }

  const title = readString(raw, ["external.title"]);
  const match = title?.match(/deposit\s+([A-Za-z0-9]+)/i);
  return match?.[1];
}

function isTrackedNestAutomaticAsset(symbol) {
  return ["UBTC", "WHYPE", "HYPE"].includes(String(symbol || "").toUpperCase());
}

function extractPositions(data, sourceName) {
  const objects = collectObjects(data);
  const positions = [];

  for (const object of objects) {
    const normalized = normalizePosition(object, sourceName);
    if (normalized) positions.push(normalized);
  }

  const unique = new Map();
  for (const position of positions) unique.set(position.key, position);
  return [...unique.values()];
}

function collectObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
  } else if (value && typeof value === "object") {
    output.push(value);
    for (const item of Object.values(value)) collectObjects(item, output);
  }
  return output;
}

function normalizePosition(raw, sourceName) {
  const lowerTick = readNumber(raw, ["v3.tickLower.tick", "tickLower.tickIdx", "tickLower", "lowerTick", "minTick", "tickMin", "leftTick"]);
  const upperTick = readNumber(raw, ["v3.tickUpper.tick", "tickUpper.tickIdx", "tickUpper", "upperTick", "maxTick", "tickMax", "rightTick"]);
  const currentTick = readNumber(raw, ["pool.tick", "currentTick", "poolTick", "tick", "activeTick"]);
  const lowerPrice = readNumber(raw, ["v3.tickLower.price", "tickLower.price", "lowerPrice", "minPrice"]);
  const upperPrice = readNumber(raw, ["v3.tickUpper.price", "tickUpper.price", "upperPrice", "maxPrice"]);
  const currentPrice = readNumber(raw, ["currentPrice", "poolPrice", "price"]) ?? inferCurrentPrice(raw);
  const explicitStatus = readExplicitStatus(raw);
  const apr = readNumber(raw, ["apr", "currentApr", "currentAPR", "aprPercent", "pool.apr"]);
  const sizeUsd = readNumber(raw, ["tvl", "valueUSD", "usdValue", "positionUsd", "positionValueUsd", "totalValueUSD", "amountUSD"]);

  const hasTickRange = Number.isFinite(lowerTick) && Number.isFinite(upperTick) && Number.isFinite(currentTick);
  const hasPriceRange = Number.isFinite(lowerPrice) && Number.isFinite(upperPrice) && Number.isFinite(currentPrice);
  const hasStatus = explicitStatus === "in-range" || explicitStatus === "out-of-range";

  if (!hasTickRange && !hasPriceRange && !hasStatus) return null;

  const liquidity = readNumber(raw, ["v3.liquidity", "liquidity", "liquidityRaw", "amount", "stakedLiquidity"]);
  if (Number.isFinite(liquidity) && liquidity <= 0) return null;

  const outOfRange = hasTickRange
    ? currentTick < lowerTick || currentTick >= upperTick
    : hasPriceRange
      ? currentPrice < lowerPrice || currentPrice >= upperPrice
      : explicitStatus === "out-of-range";
  const tokenId = readString(raw, ["v3.tokenId", "tokenId", "id", "positionId", "nftId"]);
  const poolAddress = readString(raw, ["pool.id", "poolAddress", "pool", "poolId", "pairAddress", "id"]);
  const poolName = buildPairName(raw) || readString(raw, ["poolName", "pairName", "name", "symbol"]);
  const key = `${sourceName}:${tokenId || poolAddress || poolName || JSON.stringify([lowerTick, upperTick, currentTick])}`;

  return {
    key,
    sourceName,
    tokenId,
    poolAddress,
    poolName,
    lowerTick,
    upperTick,
    currentTick,
    lowerPrice,
    upperPrice,
    currentPrice,
    apr,
    sizeUsd,
    outOfRange,
    rawStatus: explicitStatus
  };
}

function readExplicitStatus(raw) {
  for (const key of ["outOfRange", "isOutOfRange"]) {
    if (typeof raw[key] === "boolean") return raw[key] ? "out-of-range" : "in-range";
  }
  for (const key of ["inRange", "isInRange"]) {
    if (typeof raw[key] === "boolean") return raw[key] ? "in-range" : "out-of-range";
  }
  for (const key of ["status", "rangeStatus", "positionStatus"]) {
    const value = readString(raw, [key]);
    if (!value) continue;
    const normalized = value.toLowerCase().replace(/[_-]/g, " ");
    if (normalized.includes("out") && normalized.includes("range")) return "out-of-range";
    if (normalized.includes("in") && normalized.includes("range")) return "in-range";
  }
  return "unknown";
}

function enrichPositionUsdSizes(positions) {
  const pricesBySymbol = new Map();
  for (const position of positions) {
    if (position.token0Symbol && Number.isFinite(position.token0Usd)) pricesBySymbol.set(position.token0Symbol, position.token0Usd);
    if (position.token1Symbol && Number.isFinite(position.token1Usd)) pricesBySymbol.set(position.token1Symbol, position.token1Usd);
  }

  for (const position of positions) {
    if (Number.isFinite(position.sizeUsd)) continue;
    const token0Usd = pricesBySymbol.get(position.token0Symbol);
    const token1Usd = pricesBySymbol.get(position.token1Symbol);
    if (!Number.isFinite(token0Usd) || !Number.isFinite(token1Usd)) continue;
    if (!Number.isFinite(position.token0Amount) || !Number.isFinite(position.token1Amount)) continue;

    position.sizeUsd = position.token0Amount * token0Usd + position.token1Amount * token1Usd;
    position.sizeUsdEstimated = true;
  }
}

function formatHoldingsSummary(positions) {
  const totals = {
    USDC: 0,
    HYPE: 0,
    UBTC: 0
  };

  for (const position of positions) {
    addHoldingAmount(totals, position.token0Symbol, position.token0Amount);
    addHoldingAmount(totals, position.token1Symbol, position.token1Amount);
  }

  return [
    "Combined active LP holdings:",
    `USDC: ${formatTokenAmount(totals.USDC, 2)}`,
    `HYPE + WHYPE: ${formatTokenAmount(totals.HYPE, 4)}`,
    `UBTC / BTC: ${formatTokenAmount(totals.UBTC, 8)}`
  ].join("\n");
}

function addHoldingAmount(totals, symbol, amount) {
  if (!Number.isFinite(amount)) return;
  const normalized = normalizeHoldingSymbol(symbol);
  if (!normalized || !Object.hasOwn(totals, normalized)) return;
  totals[normalized] += amount;
}

function normalizeHoldingSymbol(symbol) {
  const normalized = String(symbol || "").toUpperCase();
  if (normalized === "USDC") return "USDC";
  if (normalized === "HYPE" || normalized === "WHYPE") return "HYPE";
  if (normalized === "UBTC" || normalized === "BTC" || normalized === "WBTC") return "UBTC";
  return "";
}

function formatTokenAmount(value, maximumFractionDigits) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value);
}

function formatHoldingsTelegramMessage(holdingsSummary, positions, nestRewards = []) {
  const outOfRangeCount = positions.filter((position) => position.outOfRange).length;
  const sections = [
    "📊 <b>LP Monitor Update</b>",
    "",
    formatHoldingsTelegramSection(holdingsSummary),
    "",
    formatPortfolioValueSection(positions),
    "",
    formatMarketPriceSection(positions),
    "",
    formatNestRewardsSection(nestRewards),
    "",
    formatPoolLines(positions)
  ];

  if (outOfRangeCount > 0) {
    sections.push("", `⚠️ <b>Out-of-range positions:</b> ${outOfRangeCount}`);
  }

  return sections.join("\n");
}

function formatTerminalMessage(message) {
  return message
    .replaceAll(/<\/?(?:b|code)>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function formatHoldingsTelegramSection(holdingsSummary) {
  const lines = holdingsSummary.split("\n");
  return [
    `💰 <b>${escapeHtml(lines[0])}</b>`,
    ...lines.slice(1).map((line) => `• ${escapeHtml(line)}`)
  ].join("\n");
}

function formatMarketPriceSection(positions) {
  const hypePrice = findTokenPriceUsd(positions, ["HYPE", "WHYPE"]);
  const btcPrice = findTokenPriceUsd(positions, ["BTC", "UBTC", "WBTC"]);

  return [
    "📈 <b>Current prices</b>",
    `• HYPE: <b>${Number.isFinite(hypePrice) ? escapeHtml(formatUsd(hypePrice)) : "n/a"}</b>`,
    `• BTC: <b>${Number.isFinite(btcPrice) ? escapeHtml(formatUsd(btcPrice)) : "n/a"}</b>`
  ].join("\n");
}

function findTokenPriceUsd(positions, symbols) {
  const normalizedSymbols = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const prices = [];

  for (const position of positions) {
    if (normalizedSymbols.has(String(position.token0Symbol || "").toUpperCase()) && Number.isFinite(position.token0Usd)) {
      prices.push(position.token0Usd);
    }
    if (normalizedSymbols.has(String(position.token1Symbol || "").toUpperCase()) && Number.isFinite(position.token1Usd)) {
      prices.push(position.token1Usd);
    }
  }

  if (prices.length === 0) return undefined;
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

function formatPortfolioValueSection(positions) {
  const sizedPositions = positions.filter((position) => Number.isFinite(position.sizeUsd) && position.sizeUsd > 0);
  const totalValueUsd = sizedPositions.reduce((sum, position) => sum + position.sizeUsd, 0);
  const weightedAprNumerator = sizedPositions.reduce((sum, position) => {
    if (!Number.isFinite(position.apr)) return sum;
    return sum + position.sizeUsd * position.apr;
  }, 0);
  const totalApy = totalValueUsd > 0 ? weightedAprNumerator / totalValueUsd : undefined;
  const hasEstimatedSize = sizedPositions.some((position) => position.sizeUsdEstimated);

  return [
    `💵 <b>Total pools value:</b> ${escapeHtml(formatUsd(totalValueUsd))}${hasEstimatedSize ? " est." : ""}`,
    `📈 <b>Weighted APY:</b> ${Number.isFinite(totalApy) ? escapeHtml(formatPercent(totalApy)) : "n/a"}`
  ].join("\n");
}

function formatNestRewardsSection(nestRewards) {
  const validRewards = nestRewards.filter((reward) => Number.isFinite(reward.availableAmount));
  if (validRewards.length === 0) return "🪺 <b>Available Nest rewards:</b> n/a";

  const totals = new Map();
  for (const reward of validRewards) {
    const symbol = reward.symbol || "NEST";
    const previous = totals.get(symbol) || {
      availableAmount: 0,
      availableValueUsd: 0,
      hasAvailableUsd: false
    };
    previous.availableAmount += reward.availableAmount;
    if (Number.isFinite(reward.availableValueUsd)) {
      previous.availableValueUsd += reward.availableValueUsd;
      previous.hasAvailableUsd = true;
    }
    totals.set(symbol, previous);
  }

  const lines = [];
  for (const [symbol, total] of totals.entries()) {
    lines.push(`🪺 <b>Available Nest rewards:</b> <b>${formatRewardAmount(total.availableAmount, true, symbol)}</b>${formatRewardUsd(total.availableValueUsd, total.hasAvailableUsd)}`);
  }
  return lines.join("\n");
}

function formatRewardAmount(amount, hasAmount, symbol) {
  if (!hasAmount) return `n/a ${escapeHtml(symbol)}`;
  return `${escapeHtml(formatTokenAmount(amount, 4))} ${escapeHtml(symbol)}`;
}

function formatRewardUsd(valueUsd, hasUsd) {
  return hasUsd ? ` / <b>${escapeHtml(formatUsd(valueUsd))}</b>` : " / <b>$ n/a</b>";
}

function formatPoolLines(positions) {
  if (positions.length === 0) return "🏊 <b>Pools:</b> none";
  const lines = positions.map((position) => {
    const status = position.positionType === "automatic"
      ? "🟣 <b>AUTOMATIC</b>"
      : position.outOfRange ? "🔴 <b>CLOSED</b>" : "🟢 <b>OPEN</b>";
    const poolName = escapeHtml(position.poolName || position.poolAddress || "unknown");
    const sourceName = escapeHtml(position.sourceName || "unknown");
    const size = Number.isFinite(position.sizeUsd) ? formatUsd(position.sizeUsd) + (position.sizeUsdEstimated ? " est." : "") : "n/a";
    const apr = Number.isFinite(position.apr) ? formatPercent(position.apr) : "n/a";
    return `<b>${sourceName}</b>: ${status} <b>${poolName}</b> · Size: <b>${escapeHtml(size)}</b> · APR: <b>${escapeHtml(apr)}</b>`;
  });
  return ["🏊 <b>Pools</b>", ...lines].join("\n");
}

function diffState(state, positions) {
  state.positions ||= {};
  const alerts = [];
  const now = new Date().toISOString();

  for (const position of positions) {
    const previous = state.positions[position.key];
    const wasOut = previous?.outOfRange === true;

    if (position.outOfRange) {
      alerts.push({ type: wasOut ? "out-of-range" : "new-out-of-range", position });
    }

    state.positions[position.key] = {
      outOfRange: position.outOfRange,
      updatedAt: now,
      sourceName: position.sourceName,
      poolName: position.poolName,
      tokenId: position.tokenId,
      poolAddress: position.poolAddress,
      lowerTick: position.lowerTick,
      upperTick: position.upperTick,
      currentTick: position.currentTick,
      sizeUsd: position.sizeUsd
    };
  }

  return alerts;
}

function formatTelegramMessage(alert, holdingsSummary) {
  const p = alert.position;
  const heading = alert.type === "new-out-of-range" ? "🚨 <b>NEW POOL OUT OF RANGE</b>" : "⚠️ <b>POOL OUT OF RANGE</b>";
  const lines = [
    heading,
    `<b>Source:</b> ${escapeHtml(p.sourceName)}`,
    `<b>Pool:</b> ${escapeHtml(p.poolName || p.poolAddress || "unknown")}`,
    p.tokenId ? `<b>Position:</b> ${escapeHtml(p.tokenId)}` : null,
    Number.isFinite(p.currentTick) ? `<b>Tick:</b> ${p.currentTick} (${p.lowerTick} - ${p.upperTick})` : null,
    Number.isFinite(p.currentPrice) ? `<b>Price:</b> ${formatNumber(p.currentPrice)} (${formatNumber(p.lowerPrice)} - ${formatNumber(p.upperPrice)})` : null,
    Number.isFinite(p.sizeUsd) ? `<b>Size:</b> ${escapeHtml(formatUsd(p.sizeUsd))}${p.sizeUsdEstimated ? " est." : ""}` : null,
    Number.isFinite(p.apr) ? `<b>APR:</b> ${escapeHtml(formatPercent(p.apr))}` : null,
    p.poolAddress ? `<b>Pool address:</b> <code>${escapeHtml(p.poolAddress)}</code>` : null,
    "",
    formatHoldingsTelegramSection(holdingsSummary)
  ].filter((line) => line !== null);
  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  const maxAttempts = 4;
  const configuredTimeoutSeconds = Number(process.env.TELEGRAM_TIMEOUT_SECONDS || 30);
  const timeoutMs = Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
    ? configuredTimeoutSeconds * 1000
    : 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (response.ok) return;

      const responseBody = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Telegram send failed: HTTP ${response.status} ${responseBody}`);
      }

      const retryAfterMs = getTelegramRetryAfterMs(response, responseBody);
      const delayMs = retryAfterMs ?? 1_000 * 2 ** (attempt - 1);
      console.warn(`[telegram] HTTP ${response.status}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    } catch (error) {
      const isHttpError = error instanceof Error && error.message.startsWith("Telegram send failed: HTTP");
      if (isHttpError || attempt === maxAttempts) throw error;

      const delayMs = 1_000 * 2 ** (attempt - 1);
      console.warn(`[telegram] ${error.message}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
}

function getTelegramRetryAfterMs(response, responseBody) {
  const retryAfterHeader = response.headers.get("retry-after");
  const headerSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return headerSeconds * 1000;

  try {
    const data = JSON.parse(responseBody);
    const seconds = Number(data?.parameters?.retry_after);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawTokenAmountToNumber(rawAmount, decimals = 18) {
  const text = String(rawAmount || "").trim();
  if (!text) return undefined;
  if (text.includes(".")) {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }

  const normalizedDecimals = Number(decimals);
  if (!Number.isInteger(normalizedDecimals) || normalizedDecimals < 0) return undefined;
  if (text.length <= normalizedDecimals) {
    const padded = text.padStart(normalizedDecimals + 1, "0");
    const value = Number(`${padded.slice(0, -normalizedDecimals)}.${padded.slice(-normalizedDecimals)}`);
    return Number.isFinite(value) ? value : undefined;
  }

  const whole = text.slice(0, -normalizedDecimals);
  const fraction = text.slice(-normalizedDecimals).replace(/0+$/, "");
  const value = Number(fraction ? `${whole}.${fraction}` : whole);
  return Number.isFinite(value) ? value : undefined;
}

function readTokenAmount(raw, amountPath, decimalsPath) {
  const rawAmount = readNumber(raw, [amountPath]);
  const decimals = readNumber(raw, [decimalsPath]);
  if (!Number.isFinite(rawAmount)) return undefined;
  if (!Number.isFinite(decimals)) return rawAmount;
  return rawAmount / 10 ** decimals;
}

function readTokenUsdValue(raw, pricePath, amount) {
  const price = readNumber(raw, [pricePath]);
  if (!Number.isFinite(price) || !Number.isFinite(amount)) return undefined;
  return price * amount;
}

function sumFinite(...values) {
  let hasValue = false;
  const total = values.reduce((sum, value) => {
    if (!Number.isFinite(value)) return sum;
    hasValue = true;
    return sum + value;
  }, 0);
  return hasValue ? total : undefined;
}

function readNumber(raw, keys) {
  for (const key of keys) {
    const value = key.includes(".") ? readPath(raw, key) : readValue(raw, key);
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function readString(raw, keys) {
  for (const key of keys) {
    const value = key.includes(".") ? readPath(raw, key) : readValue(raw, key);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return "";
}

function readValue(raw, key) {
  if (Object.hasOwn(raw, key)) return raw[key];
  for (const value of Object.values(raw)) {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function readPath(raw, pathName) {
  let value = raw;
  for (const part of pathName.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function inferCurrentPrice(raw) {
  const token0Price = readNumber(raw, ["token0.priceUSD", "token0.usdPrice", "token0PriceUSD"]);
  const token1Price = readNumber(raw, ["token1.priceUSD", "token1.usdPrice", "token1PriceUSD"]);
  if (!Number.isFinite(token0Price) || !Number.isFinite(token1Price) || token1Price === 0) return undefined;
  return token0Price / token1Price;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : "unknown";
}

function formatPercent(value) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2
  }).format(value);
}

function buildPairName(raw) {
  const token0 = readString(raw, ["pool.token0.symbol", "token0.basetoken.symbol", "token0.symbol", "token0Symbol", "token0", "baseSymbol"]);
  const token1 = readString(raw, ["pool.token1.symbol", "token1.basetoken.symbol", "token1.symbol", "token1Symbol", "token1", "quoteSymbol"]);
  return token0 && token1 ? `${token0}/${token1}` : "";
}

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing config file: ${filePath}. Copy config.example.json to config.json first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeState(filePath, state) {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseBool(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
