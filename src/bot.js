import dotenv from "dotenv";
import cron from "node-schedule";
import cronstrue from "cronstrue";
import colors from "colors";
import http from "http";
import { trades } from "../trades.js";
import { BinanceAPI } from "./services/binance-api.js";
import { MongoDb } from "./services/mongodb.js";
import child_process from "child_process";

/**
 * Load .env file
 */
dotenv.config();

/**
 * Simple HTTP server (so Heroku and other free SaaS will not bother on killing the app on free plans)
 * Can always use something like Kaffeine to keep it alive
 */
const PORT = Number(process.env.PORT) || 3500;
const requestListener = function (req, res) {
  res.writeHead(200);
  res.end("Hello, Traders!");
};
const server = http.createServer(requestListener);
server.listen(PORT);

// Dates integration
const datetime = new Date();
console.log(datetime.getMonth());
/**
 * Binance Integration
 */
const TRADES = JSON.parse(process.env.TRADES || null) || trades || [];
const BINANCE_SECRET = process.env.BINANCE_SECRET || null;
const BINANCE_KEY = process.env.BINANCE_KEY || null;
const BINANCE_TESTNET = process.env.BINANCE_TESTNET === "true" ? true : false;
const binance = new BinanceAPI(BINANCE_TESTNET, BINANCE_KEY, BINANCE_SECRET);

/**
 * MongoDb Integration
 */
const MONGODB_URI = process.env.MONGODB_URI || null;
const mongoDb = new MongoDb(MONGODB_URI);

/**
 * Actually place the order
 * @param {object} trade
 */
async function placeOrder(trade) {
  const { asset, currency, quantity, quoteOrderQty } = trade;
  const pair = asset + currency;
  const response = await binance.marketBuy(pair, quantity, quoteOrderQty);

  if (response.orderId) {
    const successText =
      `Successfully purchased: ${response.executedQty} ${asset} @ ${
        response.fills[0].price
      } ${currency}. Spent: ${response.cummulativeQuoteQty} ${currency}.\n`;

    const data = `${JSON.stringify(response)}\n`;

    console.log(colors.green(successText), colors.grey(data));

    const { exec } = child_process;

    exec(
      `notify-send -u critical -i ~/Documents/github/binance-dca-bot/btcIcon.png 'BTC DCA TO RICHES'  "${successText}"`,
      (err, stdout, stderr) => {
        if (err) {
          exec(
            `notify-send -u critical "Something went wrong" "Please check your DCA bot @ placeOrder"`,
          );
          return;
        }
      },
    );

    console.log(response);
    console.log("\n");

    await mongoDb.saveOrder(response);

    const details = binance.getOrderDetails(asset, currency, response);
    console.log(
      `✅ *Buy order executed (${pair})*\n\n` +
        `_Order ID:_ ${details.orderId}\n` +
        `_Date:_ ${details.transactionDateTime}\n` +
        `_Quantity:_ ${details.quantity} ${details.asset}\n` +
        `_Total:_ ${details.totalCost} ${details.currency}\n` +
        `_Average Value:_ ${details.averageAssetValue} ${details.currency}/${details.asset}\n` +
        `_Fees:_ ${details.commissions} ${details.commissionAsset}\n\n` +
        `${details.fills.join("\n")}`,
    );

    setTimeout(function () {
      // placeWithdrawal()
      console.log("widthdrawal ran");
    }, 50000);
  } else {
    const errorText = response.msg ||
      `Unexpected error placing buy order for ${pair}`;
    console.error(colors.red(errorText));
  }
}

/**
 * Get human-readable details on the trades to perform
 */
function getBuyDetails(trades) {
  return trades.map((c) => {
    if (c.quantity) {
      return `${c.quantity} ${c.asset} with ${c.currency} ${
        c.schedule ? cronstrue.toString(c.schedule) : "immediately."
      }`;
    } else {
      return `${c.quoteOrderQty} ${c.currency} of ${c.asset} ${
        c.schedule ? cronstrue.toString(c.schedule) : "immediately."
      }`;
    }
  }).join("\n");
}

/**
 * Check if .env variables or config parameters are valids
 */
function checkForParameters() {
  if (!BINANCE_KEY || !BINANCE_SECRET) {
    console.log(
      colors.red(
        "No Binance API key, please update environment variables, .env file or trades.js file.",
      ),
    );
    return false;
  }

  if (!TRADES || TRADES.length === 0) {
    console.log(
      colors.red(
        "No trades to perform, please update environment variables, .env file or trades.js file.",
      ),
    );
    return false;
  }

  return true;
}

/**
 * Check for connectivity with Binance servers by retrieving account information via API
 */
async function checkForBinanceConnectivity() {
  const accountInfo = await binance.getAccountInfo();

  if (accountInfo.msg) {
    console.error(accountInfo);
    throw new Error(accountInfo.msg);
  }

  if (!accountInfo.canTrade) {
    console.log(
      colors.red(
        "Check your binance API key settings, it appears that trades are not enabled.",
      ),
    );
    return false;
  }

  return true;
}

/**
 * Loop through all the assets defined to buy in the config and schedule the cron jobs
 */
async function runBot() {
  console.log(
    colors.magenta("Starting Binance DCA Bot"),
    colors.blue(`[${new Date().toLocaleString()}]`),
  );

  if (!checkForParameters() || !await checkForBinanceConnectivity()) {
    return;
  }

  for (const trade of TRADES) {
    const { schedule, asset, currency, quantity, quoteOrderQty } = trade;

    if ((!quantity && !quoteOrderQty) || !asset || !currency) {
      console.log(
        colors.red(
          "Invalid trade settings, skip this trade, please check environment variables, .env file or trades.js file",
        ),
      );
      continue;
    }

    if (quantity && quoteOrderQty) {
      throw new Error(
        `Error: You can not have both quantity and quoteOrderQty options at the same time.`,
      );
    }

    if (quantity) {
      console.log(
        colors.yellow(
          `CRON set up to buy ${quantity} ${asset} with ${currency} ${
            schedule ? cronstrue.toString(schedule) : "immediately."
          }`,
        ),
      );
    } else {
      console.log(
        colors.yellow(
          `CRON set up to buy ${quoteOrderQty} ${currency} of ${asset} ${
            schedule ? cronstrue.toString(schedule) : "immediately."
          }`,
        ),
      );
    }

    // If a schedule is not defined, the asset will be bought immediately
    // otherwise a cronjob is setup to place the order on a schedule
    if (!schedule) {
      await placeOrder(trade);
    } else {
      cron.scheduleJob(schedule, async () => await placeOrder(trade));
    }
  }
}

async function placeWithdrawal() {
  const accountInfo = await binance.getAccountInfo();

  const btc = accountInfo.balances.filter((obj) => {
    if (obj.asset == "BTC" && obj.free > 0) {
      return obj.free;
    } else {
      return [{ free: 0 }];
    }
  });

  const btcAmount = btc[0].free;

  const widthdraw = await binance.widthdraw(btcAmount);

  const { exec } = child_process;

  exec(
    `notify-send -i ~/Documents/github/binance-dca-bot/btcIcon.png 'BTC DCA TO RICHES'  "${widthdraw.msg}"`,
    (err, stdout, stderr) => {
      if (err) {
        exec(
          `notify-send -u critical "Something went wrong" "Please check your DCA bot"`,
        );
        return;
      }
    },
  );
}

await runBot();
