const DigifinexApi = require('./api/digifinex_api');
const utils = require('../helpers/utils');
const _networks = require('./../helpers/networks');
const config = require('./../modules/config/reader');

/**
 * API endpoints:
 * https://openapi.digifinex.com/v3
 */
const apiServer = 'https://openapi.digifinex.com/v3';
const exchangeName = 'DigiFinex';

// When a new market starts, DigiFinex doesn't provide info about it
// This workaround allows using hardcoded info
const hardCodedPairInfo = {
  ADM_USDT: {
    pairReadable: 'ADM/USDT',
    pairPlain: 'ADM_USDT',
    coin1: 'ADM',
    coin2: 'USDT',
    coin1Decimals: 4,
    coin2Decimals: 6,
    coin1Precision: 0.0001,
    coin2Precision: 0.000001,
    coin1MinAmount: 20,
    coin1MaxAmount: null,
    coin2MinAmount: 1,
    coin2MaxAmount: null,
    minTrade: 1,
    status: 'ONLINE',
  },
};

module.exports = (
    apiKey,
    secretKey,
    pwd,
    log,
    publicOnly = false,
    loadMarket = true,
    useSocket = false,
    useSocketPull = false,
    accountNo = 0,
    coin1 = config.coin1,
    coin2 = config.coin2,
) => {
  const digifinexApiClient = DigifinexApi();

  digifinexApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
    getCurrencies();
  }

  /**
   * Get info on all markets and store in module.exports.exchangeMarkets
   * It's an internal function, not called outside of this module
   * @param {String} [pair] In classic format as BTC/USDT. If markets are already cached, get info for the pair.
   * @returns {Promise<unknown>|*}
   */
  function getMarkets(pair) {
    const paramString = `pair: ${pair}`;

    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair ? formatPairName(pair).pairPlain : pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      digifinexApiClient.markets().then((data ) => {
        try {
          const result = {};
          const markets = data.symbol_list;

          for (const market of markets) {
            const pairNames = formatPairName(market.symbol);
            result[pairNames.pairPlain] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: market.symbol,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals: +market.amount_precision,
              coin2Decimals: +market.price_precision,
              coin1Precision: utils.getPrecision(+market.amount_precision),
              coin2Precision: utils.getPrecision(+market.price_precision),
              coin1MinAmount: +market.minimum_amount,
              coin1MaxAmount: null,
              coin2MinAmount: +market.minimum_value,
              coin2MaxAmount: null,
              minTrade: +market.minimum_amount, // in coin1
              status: market.status === 'TRADING' ? 'ONLINE' : 'OFFLINE',
            };
          }

          Object.values(hardCodedPairInfo).forEach((hardCodedPair) => {
            result[hardCodedPair.pairPlain] ??= hardCodedPair;
          });

          if (Object.keys(result).length > 0) {
            module.exports.exchangeMarkets = result;
            log.log(`Received info about ${Object.keys(result).length} markets on ${exchangeName} exchange.`);
          }

          resolve(result);
        } catch (error) {
          log.warn(`Error while processing getMarkets(${paramString}) request: ${error}`);
          resolve(undefined);
        }
      }).catch((error) => {
        log.warn(`API request getMarkets() of ${utils.getModuleName(module.id)} module failed. ${error}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingMarkets = false;
      });
    });
  }

  /**
   * Get info on all currencies
   * @param {String} [coin]
   * @param {Boolean} [forceUpdate=false] Update currencies to refresh parameters
   * @returns {Promise<unknown>|*}
   */
  function getCurrencies(coin, forceUpdate = false) {
    if (module.exports.gettingCurrencies) return;
    if (module.exports.exchangeCurrencies && !forceUpdate) return module.exports.exchangeCurrencies[coin];

    module.exports.gettingCurrencies = true;

    return new Promise((resolve) => {
      digifinexApiClient.currencies().then((data) => {
        try {
          const result = {};
          const currencies = data.data;

          for (const currency of currencies) {
            const symbol = currency.currency;

            result[symbol] ??= {
              symbol,
              name: symbol,
              comment: undefined,
              confirmations: undefined,
              withdrawalFee: undefined,
              minWithdrawal: undefined,
              maxWithdrawal: undefined,
              logoUrl: undefined, // logo url is not provided by api
              exchangeAddress: undefined,
              decimals: undefined,
              precision: undefined,
              minSize: undefined,
              networks: {},
              defaultNetwork: undefined,
            };

            // Currency status is ONLINE if deposits are enabled on any of its networks
            result[symbol].status = result[symbol].status === 'ONLINE' || currency.deposit_status ? 'ONLINE' : 'OFFLINE';

            if (currency.chain) {
              result[symbol].networks[formatNetworkName(currency.chain)] = {
                chainName: currency.chain,
                status: currency.deposit_status && currency.withdraw_status ? 'ONLINE' : 'OFFLINE', // 'ONLINE', 'OFFLINE'
                depositStatus: currency.deposit_status ? 'ONLINE' : 'OFFLINE',
                withdrawalStatus: currency.withdraw_status ? 'ONLINE' : 'OFFLINE',
                minWithdrawal: +currency.min_withdraw_amount,
                withdrawalFee: +currency.min_withdraw_fee,
                withdrawalFeeRate: +currency.withdraw_fee_rate,
                withdrawalFeeCurrency: currency.withdraw_fee_currency,
                confirmations: undefined,
              };
            }
          }

          if (Object.keys(result).length > 0) {
            module.exports.exchangeCurrencies = result;
            log.log(`${forceUpdate ? 'Updated' : 'Received'} info about ${Object.keys(result).length} currencies on ${exchangeName} exchange.`);
          }

          module.exports.gettingCurrencies = false;
          resolve(result);
        } catch (error) {
          log.warn(`Error while processing getCurrencies() request: ${error}`);
          resolve(undefined);
        }
      }).catch((error) => {
        log.warn(`API request getCurrencies() of ${utils.getModuleName(module.id)} module failed. ${error}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingCurrencies = false;
      });
    });
  }

  return {
    getMarkets,
    getCurrencies,

    /**
     * Getter for stored markets info
     * @return {Object}
     */
    get markets() {
      return module.exports.exchangeMarkets;
    },

    /**
     * Getter for stored currencies info
     * @return {Object}
     */
    get currencies() {
      return module.exports.exchangeCurrencies;
    },

    marketInfo(pair) {
      return getMarkets(pair);
    },

    currencyInfo(coin) {
      return getCurrencies(coin);
    },

    features() {
      return {
        getMarkets: true,
        getCurrencies: true,
        placeMarketOrder: true, // Only BTC/USDT pair and few others supported for market orders
        getDepositAddress: true,
        getTradingFees: false,
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: true,
        getFundHistory: true,
        getFundHistoryImplemented: false,
        allowAmountForMarketBuy: false,
        amountForMarketOrderNecessary: false,
      };
    },

    /**
     * Get user balances
     * @param {Boolean} [nonzero=true] Return only non-zero balances
     * @returns {Promise<[]|undefined>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let balances;

      try {
        balances = await digifinexApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];
        balances = balances.list;

        for (const crypto of balances) {
          result.push({
            code: crypto.currency.toUpperCase(),
            free: +crypto.free,
            freezed: +crypto.total - +crypto.free,
            total: +crypto.total,
          });
        }

        if (nonzero) {
          result = result.filter((crypto) => crypto.free || crypto.freezed);
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getBalances(${paramString}) request results: ${JSON.stringify(balances)}. ${error}`);
        return undefined;
      }
    },

    /**
     * List of all account open orders
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<[]|undefined>}
     */
    async getOpenOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await digifinexApiClient.getOrders(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        orders = orders.data;

        for (const order of orders) {
          let orderStatus;
          if (order.status === 0) {
            orderStatus = 'new';
          } else if (order.status === 1) {
            orderStatus = 'part_filled';
          } else {
            orderStatus = 'filled';
          }

          let [side, type] = order.type.split('_'); // 'buy' -> buy, undefined; 'buy_market' -> buy, market
          if (!type) {
            type = 'limit';
          }

          result.push({
            orderId: order.order_id?.toString(),
            symbol: this.marketInfo(order.symbol)?.pairReadable,
            symbolPlain: order.symbol,
            price: +order.price,
            side, // 'buy' or 'sell'
            type, // 'limit' or 'market'
            timestamp: order.created_date * 1000,
            amount: +order.amount,
            amountExecuted: order.executed_amount,
            amountLeft: order.amount - order.executed_amount,
            status: orderStatus,
          });
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getOpenOrders(${paramString}) request results: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {String} orderId Example: '7c99eb7f-1bfd-4c2a-a989-cf320e803396'
     * @param {String} pair In classic format as BTC/USDT. For logging only.
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await digifinexApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.data) {
          order = order.data;

          let orderStatus;
          if (order.status === 0) {
            orderStatus = 'new';
          } else if (order.status === 1) {
            orderStatus = 'part_filled';
          } else if (order.status === 2) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'cancelled'; // 3 for cancelled with none executed, 4 for cancelled with partially executed
          }

          let [side, type] = order.type.split('_'); // 'buy' -> buy, undefined; 'buy_market' -> buy, market
          if (!type) {
            type = 'limit';
          }

          const result = {
            orderId: order.order_id.toString(),
            tradesCount: order.detail.length,
            price: +order.price || +order.avg_price,
            side, // 'buy' or 'sell'
            type, // 'limit' or 'market'
            /**
             * In coin1
             * Limit orders: always have amount
             * Market orders: no amount for buy orders, always have executed amount
             */
            amount: +order.amount || +order.executed_amount,
            /**
             * In coin2
             * Limit orders: no cash_amount
             * Market orders: no cash_amount
             */
            volume: +order.cash_amount || +order.amount * (+order.avg_price || +order.price), // ~
            pairPlain: coinPair.pairPlain, // order.symbol
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: undefined, // Digifinex doesn't provide fee
            amountExecuted: +order.executed_amount, // In coin1
            volumeExecuted: +order.executed_amount * (+order.avg_price || +order.price), // In coin2 ~
            timestamp: +order.created_date * 1000,
            updateTimestamp: +order.finished_date * 1000 || +order.created_date * 1000,
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order.digifinexErrorInfo ?? 'No details.';
          log.log(`Unable to get order ${orderId} details: ${JSON.stringify(errorMessage)}. Returning unknown order status.`);

          return {
            orderId,
            status: 'unknown', // Order doesn't exist or Wrong orderId
          };
        }
      } catch (error) {
        log.warn(`Error while processing getOrderDetails(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel an order
     * @param {String} orderId Example: '6b58ccadbc81ec4d02ef7b8cb716b5f8'
     * @param {String} side Not used for Digifinex
     * @param {String} pair Not used for Digifinex, for logging only. In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}`;

      let data;

      try {
        data = await digifinexApiClient.cancelOrder(orderId);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (data.success?.length) {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = data?.digifinexErrorInfo ?? 'No details';
          log.log(`Unable to cancel order ${orderId} on ${pair} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelOrder(${paramString}) request results: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel all order on specific pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await digifinexApiClient.getOrders(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request cancelAllOrders-getOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      let ordersToCancel;

      try {
        ordersToCancel = orders.data.map((order) => order.order_id);

        if (!ordersToCancel.length) {
          log.log(`Cancelling all orders on ${coinPair.pairReadable} pair: No open orders.`);
          return true;
        }
      } catch (error) {
        log.warn(`Error while processing cancelAllOrders-getOrders(${paramString}) request result: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }

      let data;

      try {
        data = await digifinexApiClient.cancelAllOrders(ordersToCancel);
      } catch (error) {
        log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (data.success.length === ordersToCancel.length) {
          log.log(`Cancelled all ${data.success.length} orders on ${coinPair.pairReadable} pair…`);
          return true;
        } else {
          log.warn(`Cancelled ${data.success.length} of ${ordersToCancel.length} orders on ${coinPair.pairReadable} pair…`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelAllOrders(${paramString}) request result: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get info on trade pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getRates(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let ticker;

      try {
        ticker = await digifinexApiClient.ticker(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        ticker = ticker.ticker[0];

        return {
          ask: +ticker.sell,
          bid: +ticker.buy,
          last: +ticker.last,
          volume: +ticker.vol,
          volumeInCoin2: +ticker.base_vol,
          high: +ticker.high,
          low: +ticker.low,
        };
      } catch (error) {
        log.warn(`Error while processing getRates(${paramString}) request result: ${JSON.stringify(ticker)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Places an order
     * DigiFinex supports both limit and market orders. Market orders are available for several trading pair only.
     * @param {String} side 'buy' or 'sell'
     * @param {String} pair In classic format like BTC/USDT
     * @param {Number} price Order price
     * @param {Number} coin1Amount Base coin amount. Provide either coin1Amount or coin2Amount.
     * @param {Number} limit 1 if order is limit (default), 0 in case of market order
     * @param {Number} coin2Amount Quote coin amount. Provide either coin1Amount or coin2Amount.
     * @returns {Promise<Object>|undefined}
     */
    async placeOrder(side, pair, price, coin1Amount, limit = 1, coin2Amount) {
      const paramString = `side: ${side}, pair: ${pair}, price: ${price}, coin1Amount: ${coin1Amount}, limit: ${limit}, coin2Amount: ${coin2Amount}`;

      const marketInfo = this.marketInfo(pair);

      let message;

      if (!marketInfo) {
        message = `Unable to place an order on ${exchangeName} exchange. I don't have info about market ${pair}.`;
        log.warn(message);
        return {
          message,
        };
      }

      // for Limit orders, calculate coin1Amount if only coin2Amount is provided
      if (!coin1Amount && coin2Amount && price) {
        coin1Amount = coin2Amount / price;
      }

      // for Limit orders, calculate coin2Amount if only coin1Amount is provided
      let coin2AmountCalculated;
      if (!coin2Amount && coin1Amount && price) {
        coin2AmountCalculated = coin1Amount * price;
      }

      // Round coin1Amount, coin2Amount and price to a certain number of decimal places, and check if they are correct.
      // Note: any value may be small, e.g., 0.000000033. In this case, its number representation will be 3.3e-8.
      // That's why we store values as strings. If an exchange doesn't support string type for values, cast them to numbers.

      if (coin1Amount) {
        coin1Amount = (+coin1Amount).toFixed(marketInfo.coin1Decimals);
        if (!+coin1Amount) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin1Decimals} decimal places, the order amount is wrong: ${coin1Amount}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (coin2Amount) {
        coin2Amount = (+coin2Amount).toFixed(marketInfo.coin2Decimals);
        if (!+coin2Amount) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin2Decimals} decimal places, the order volume is wrong: ${coin2Amount}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (price) {
        price = (+price).toFixed(marketInfo.coin2Decimals);
        if (!+price) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin2Decimals} decimal places, the order price is wrong: ${price}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (+coin1Amount < marketInfo.coin1MinAmount) {
        message = `Unable to place an order on ${exchangeName} exchange. Order amount ${coin1Amount} ${marketInfo.coin1} is less minimum ${marketInfo.coin1MinAmount} ${marketInfo.coin1} on ${marketInfo.pairReadable} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      if (coin2Amount && +coin2Amount < marketInfo.coin2MinAmount) { // coin2Amount may be null or undefined
        message = `Unable to place an order on ${exchangeName} exchange. Order volume ${coin2Amount} ${marketInfo.coin2} is less minimum ${marketInfo.coin2MinAmount} ${marketInfo.coin2} on ${pair} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      let orderType;
      let output = '';

      if (limit) {
        orderType = 'limit';
        if (coin2Amount) {
          output = `${side} ${coin1Amount} ${marketInfo.coin1} for ${coin2Amount} ${marketInfo.coin2} at ${price} ${marketInfo.coin2}.`;
        } else {
          output = `${side} ${coin1Amount} ${marketInfo.coin1} for ~${coin2AmountCalculated.toFixed(marketInfo.coin2Decimals)} ${marketInfo.coin2} at ${price} ${marketInfo.coin2}.`;
        }
      } else {
        orderType = 'market';
        if (coin2Amount) {
          output = `${side} ${marketInfo.coin1} for ${coin2Amount} ${marketInfo.coin2} at Market Price on ${pair} pair.`;
        } else {
          output = `${side} ${coin1Amount} ${marketInfo.coin1} at Market Price on ${pair} pair.`;
        }
      }

      const order = {};
      let response;
      let orderId;
      let errorMessage;

      try {
        response = await digifinexApiClient.addOrder(marketInfo.pairPlain, coin1Amount, coin2Amount, price, side);

        errorMessage = response?.digifinexErrorInfo;
        orderId = response?.order_id;
      } catch (error) {
        message = `API request addOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}.`;
        log.warn(message);
        order.orderId = false;
        order.message = message;

        return order;
      }

      if (orderId) {
        message = `Order placed to ${output} Order Id: ${orderId}.`;
        log.info(message);
        order.orderId = orderId;
        order.message = message;
      } else {
        const details = errorMessage ? ` Details: ${utils.trimAny(errorMessage, ' .')}.` : ' { No details }.';
        message = `Unable to place order to ${output}${details} Check parameters and balances.`;
        log.warn(message);
        order.orderId = false;
        order.message = message;
      }

      return order;
    },

    /**
     * Get orderbook on a specific pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderBook(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let book;

      try {
        book = await digifinexApiClient.orderBook(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = {
          bids: [],
          asks: [],
        };

        for (const crypto of book.asks) {
          result.asks.push({
            amount: +crypto[1],
            price: +crypto[0],
            count: 1,
            type: 'ask-sell-right',
          });
        }
        result.asks.sort((a, b) => {
          return parseFloat(a.price) - parseFloat(b.price);
        });

        for (const crypto of book.bids) {
          result.bids.push({
            amount: +crypto[1],
            price: +crypto[0],
            count: 1,
            type: 'bid-buy-left',
          });
        }
        result.bids.sort((a, b) => {
          return parseFloat(b.price) - parseFloat(a.price);
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getOrderBook(${paramString}) request result: ${JSON.stringify(book)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get trades history
     * @param {String} pair
     * @param {Number} limit
     * @returns {Promise<unknown>}
     */
    async getTradesHistory(pair, limit) {
      const paramString = `pair: ${pair}, limit: ${limit}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await digifinexApiClient.getTradesHistory(coinPair.pairPlain, limit);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        trades = trades.data;

        for (const trade of trades) {
          result.push({
            coin1Amount: +trade.amount, // amount in coin1
            price: +trade.price, // trade price
            coin2Amount: +trade.amount * +trade.price, // quote in coin2
            date: +trade.date * 1000, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.type?.toLowerCase(), // 'buy' or 'sell'
            tradeId: trade.id?.toString(),
          });
        }

        // We need ascending sort order
        result.sort((a, b) => {
          return parseFloat(a.date) - parseFloat(b.date);
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getTradesHistory(${paramString}) request result: ${JSON.stringify(trades)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get deposit address for a coin
     * No response for not created deposit address
     * No API endpoint for creating deposit address
     * @param {String} coin As BTC
     * @returns {Promise<Array|undefined>}
     */
    async getDepositAddress(coin) {
      const paramString = `coin: ${coin}`;

      let data;

      try {
        data = await digifinexApiClient.getDepositAddress(coin);
      } catch (error) {
        log.warn(`API request getDepositAddress(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const addresses = data.data;

        if (addresses?.length) {
          return addresses.map(({ chain, address }) => ({ network: formatNetworkName(chain), address }));
        } else {
          const errorMessage = data?.digifinexErrorInfo ?? 'No details';
          log.log(`Unable to get deposit address for ${coin}: ${errorMessage}.`);

          if (data.code !== 200) {
            return {
              message: errorMessage,
            };
          }

          return undefined;
        }
      } catch (error) {
        log.warn(`Error while processing getDepositAddress(${paramString}) request results: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },
  };
};

/**
 * Returns network name in classic format
 * Keys in networksNameMap should be in upper case even if exchanger format in lower case
 * @param {String} network
 * @returns {String}
 */
function formatNetworkName(network) {
  let formattedNetworkName = network;

  Object.values(_networks).forEach((n) => {
    if (network.includes(n.code) || network.includes(n.name) || network.includes(n.altcode)) {
      formattedNetworkName = n.code;
    }
  });

  return formattedNetworkName;
}

/**
 *
 * Returns pair in Digifinex format like 'BTC_USDT' and classic/readable like 'BTC/USDT'
 * @param pair Pair in any format
 * @returns {Object} pair, pairReadable, pairPlain, coin1, coin2
 */
function formatPairName(pair) {
  if (pair.indexOf('-') > -1) {
    pair = pair.replace('-', '_').toUpperCase();
  } else {
    pair = pair.replace('/', '_').toUpperCase();
  }
  const [coin1, coin2] = pair.split('_');
  return {
    coin1: coin1.toUpperCase(),
    coin2: coin2.toUpperCase(),
    pair: `${coin1}${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: pair,
  };
}