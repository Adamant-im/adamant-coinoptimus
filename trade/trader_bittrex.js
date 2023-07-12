const BittrexApi = require('./api/bittrex_api');
const utils = require('../helpers/utils');

/**
 * API endpoints:
 * https://api.bittrex.com/v3
 */
const apiServer = 'https://api.bittrex.com/v3';
const exchangeName = 'Bittrex';

const BITTREX_CREDITS_VALID_MS = 60 * 1000;
const BITTREX_CREDITS_MIN_TO_USE = 5000; // "Note that the order will fail if you do not have sufficient Bittrex Credits available"

module.exports = (
    apiKey,
    secretKey,
    pwd,
    log,
    publicOnly = false,
    loadMarket = true,
) => {
  const bittrexApiClient = BittrexApi();
  const bittrexCreditsCached = { timestamp: 0, available: 0 };

  bittrexApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
    getCurrencies();
  }

  /**
   * Get info on all markets and store in module.exports.exchangeMarkets
   * It's an internal function, not called outside of this module
   * @param {String} pair In classic format as BTC/USDT. If markets are already cached, get info for the pair.
   * @returns {Promise<unknown>|*}
   */
  function getMarkets(pair) {
    const paramString = `pair: ${pair}`;

    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair ? formatPairName(pair).pairPlain : pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      bittrexApiClient.markets().then((markets) => {
        try {
          const result = {};

          markets.forEach((market) => {
            const pairNames = formatPairName(market.symbol);
            result[pairNames.pairPlain] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: market.symbol,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals: 8, // decimals for base coin are not provided by api
              coin2Decimals: +market.precision, // market.precision = decimals on Bittrex
              coin1Precision: utils.getPrecision(8),
              coin2Precision: utils.getPrecision(+market.precision),
              coin1MinAmount: +market.minTradeSize,
              coin1MaxAmount: null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: +market.minTradeSize, // in coin1
              status: market.status, // 'ONLINE', 'OFFLINE'
            };
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
   * @param {String} coin
   * @param {Boolean} forceUpdate Update currencies to refresh parameters
   * @returns {Promise<unknown>|*}
   */
  function getCurrencies(coin, forceUpdate = false) {
    if (module.exports.gettingCurrencies) return;
    if (module.exports.exchangeCurrencies && !forceUpdate) return module.exports.exchangeCurrencies[coin];

    module.exports.gettingCurrencies = true;

    return new Promise((resolve) => {
      bittrexApiClient.currencies().then((currencies) => {
        try {
          const result = {};

          currencies.forEach((currency) => {
            result[currency.symbol] = {
              symbol: currency.symbol,
              name: currency.name,
              status: currency.status, // 'ONLINE', 'OFFLINE'
              comment: currency.notice, // Like 'Deposits and withdrawals are temporarily offline.'
              confirmations: +currency.minConfirmations, // for deposit
              withdrawalFee: +currency.txFee,
              logoUrl: currency.logoUrl,
              exchangeAddress: currency.baseAddress,
              decimals: undefined, // decimals is not provided by api
              precision: undefined,
              networks: undefined,
              defaultNetwork: 'ERC20',
            };
          });

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

    /**
     * Features available on Bittrex exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: true,
        placeMarketOrder: true,
        getDepositAddress: true,
        getTradingFees: true,
        getAccountTradeVolume: true,
        createDepositAddressWithWebsiteOnly: false,
        getFundHistory: true,
        getFundHistoryImplemented: true,
        allowAmountForMarketBuy: true,
        amountForMarketOrderNecessary: false,
        accountTypes: false, // Bittrex doesn't supports main, trade, margin accounts
      };
    },

    async getBittrexCredits() {
      if (Date.now() - bittrexCreditsCached.timestamp > BITTREX_CREDITS_VALID_MS) {
        await this.getBalances();
      }
      return bittrexCreditsCached.available;
    },

    /**
     * Get user balances
     * @param {Boolean} nonzero Return only non-zero balances
     * @returns {Promise<Array|undefined>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let balances;

      try {
        balances = await bittrexApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        balances.forEach((crypto) => {
          result.push({
            code: crypto.currencySymbol.toUpperCase(),
            free: +crypto.available,
            freezed: +crypto.total - +crypto.available,
            total: +crypto.total,
          });
        });

        const bittrexCredits = result.filter((crypto) => crypto.code === 'BTXCRD')?.[0]?.free || 0;
        if (bittrexCredits) {
          bittrexCreditsCached.timestamp = Date.now();
          bittrexCreditsCached.available = bittrexCredits;
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
     * @returns {Promise<Array|undefined>}
     */
    async getOpenOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bittrexApiClient.getOrders(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        orders.forEach((order) => {
          let orderStatus;
          if (+order.fillQuantity === 0) {
            orderStatus = 'new';
          } else if (+order.fillQuantity === +order.quantity) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'part_filled';
          }
          // status: OPEN, CLOSED

          result.push({
            orderId: order.id.toString(),
            symbol: this.marketInfo(order.marketSymbol)?.pairReadable,
            symbolPlain: order.marketSymbol,
            price: +order.limit, // limit price
            ceiling: +order.ceiling, // ceiling (included for ceiling orders and excluded for non-ceiling orders)
            // Amount paid for buy orders or amount received for sell orders in quote currency (e.g. USD on the BTC/USD market).
            // Average fill price is proceeds / quantityFilled. Total quote currency paid for a buy order is proceeds + commission.
            // For a sell order the quote currency received is proceeds - commission
            proceeds: +order.proceeds,
            side: order.direction.toLowerCase(), // 'buy' or 'sell'
            type: order.type.toLowerCase(), // LIMIT, MARKET, CEILING_LIMIT, CEILING_MARKET. As we receive only open orders, all are 'LIMIT'
            timestamp: new Date(order.createdAt).getTime(), // timestamp (UTC) of order creation like '2022-06-13T17:09:52.19Z'
            amount: +order.quantity,
            amountExecuted: +order.fillQuantity, // quantity filled in base currency
            amountLeft: +order.quantity - +order.fillQuantity,
            fee: +order.commission, // commission paid on the order in quote currency
            status: orderStatus,
          });
        });

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
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await bittrexApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.id) {
          let orderStatus;
          if (order.status === 'OPEN' && +order.fillQuantity === 0) {
            orderStatus = 'new';
          } else if (order.status === 'OPEN' && +order.fillQuantity !== +order.quantity) {
            orderStatus = 'part_filled';
          } else if (order.status === 'CLOSED' && (+order.fillQuantity === +order.quantity || order.type.includes('MARKET'))) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'cancelled';
          }
          // status: OPEN, CLOSED

          const result = {
            orderId: order.id.toString(),
            tradesCount: order.executions?.length,
            price: +order.limit, // limit price, NaN for market orders
            side: order.direction.toLowerCase(), // 'buy' or 'sell'
            type: order.type.toLowerCase(), // LIMIT, MARKET, CEILING_LIMIT, CEILING_MARKET. As we receive only open orders, all are 'LIMIT'
            amount: +order.quantity, // In coin1
            volume: order.type === 'MARKET' ? +order.proceeds : +order.limit * +order.quantity, // In coin2
            pairPlain: coinPair.pairPlain,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: +order.commission,
            amountExecuted: +order.fillQuantity, // In coin1
            volumeExecuted: +order.proceeds, // In coin2
            timestamp: new Date(order.createdAt).getTime(), // timestamp (UTC) of order creation like '2022-06-13T17:09:52.19Z'
            updateTimestamp: new Date(order.updatedAt).getTime(), // timestamp (UTC) of order update like '2022-06-13T17:09:52.19Z'
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order || 'No details.';
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
     * @param {String} orderId Example: '7c99eb7f-1bfd-4c2a-a989-cf320e803396'
     * @param {String} side Not used for Bittrex
     * @param {String} pair Not used for Bittrex. In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;

      let order;

      try {
        order = await bittrexApiClient.cancelOrder(orderId);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.status?.toLowerCase() === 'closed') {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = order?.bittrexErrorInfo || 'No details';
          log.log(`Unable to cancel order ${orderId} on ${pair} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelOrder(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
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
        orders = await bittrexApiClient.cancelAllOrders(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const ordersCount = orders.length;
        const cancelledCount = orders.filter((order) => order.statusCode === 'SUCCESS').length;

        if (ordersCount === cancelledCount) {
          log.log(`Cancelled all ${ordersCount} orders on ${coinPair.pairReadable} pair…`);
          return true;
        } else {
          log.warn(`Cancelled ${cancelledCount} of ${ordersCount} orders on ${coinPair.pairReadable} pair…`);
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
        ticker = await bittrexApiClient.ticker(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        return {
          ask: +ticker.marketTicker.askRate,
          bid: +ticker.marketTicker.bidRate,
          last: +ticker.marketTicker.lastTradeRate,
          volume: +ticker.volume,
          volumeInCoin2: +ticker.quoteVolume,
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
     * Bittrex supports both limit and market orders
     * @param {String} side 'buy' or 'sell'
     * @param {String} pair In classic format like BTC/USD
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

      if (coin1Amount) {
        coin1Amount = (+coin1Amount).toFixed(this.marketInfo(pair).coin1Decimals);
      }
      if (coin2Amount) {
        coin2Amount = (+coin2Amount).toFixed(this.marketInfo(pair).coin2Decimals);
      }
      if (price) {
        price = (+price).toFixed(this.marketInfo(pair).coin2Decimals);
      }

      if (coin1Amount < marketInfo.coin1MinAmount) {
        message = `Unable to place an order on ${exchangeName} exchange. Order amount ${coin1Amount} ${marketInfo.coin1} is less minimum ${marketInfo.coin1MinAmount} ${marketInfo.coin1} on ${pair} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      if (coin2Amount && coin2Amount < marketInfo.coin2MinAmount) { // coin2Amount may be null
        message = `Unable to place an order on ${exchangeName} exchange. Order volume ${coin2Amount} ${marketInfo.coin2} is less minimum ${marketInfo.coin2MinAmount} ${marketInfo.coin2} on ${pair} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      const bittrexCredits = await this.getBittrexCredits();
      const useAwards = bittrexCredits > BITTREX_CREDITS_MIN_TO_USE;

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
        // eslint-disable-next-line max-len
        response = await bittrexApiClient.addOrder(marketInfo.pairPlain, coin1Amount, coin2Amount, price, side, orderType, useAwards);

        errorMessage = response?.bittrexErrorInfo;
        orderId = response?.id;
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
        book = await bittrexApiClient.orderBook(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = {
          bids: [],
          asks: [],
        };

        book.ask.forEach((crypto) => {
          result.asks.push({
            amount: +crypto.quantity,
            price: +crypto.rate,
            count: 1,
            type: 'ask-sell-right',
          });
        });
        result.asks.sort((a, b) => {
          return parseFloat(a.price) - parseFloat(b.price);
        });

        book.bid.forEach((crypto) => {
          result.bids.push({
            amount: +crypto.quantity,
            price: +crypto.rate,
            count: 1,
            type: 'bid-buy-left',
          });
        });
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
     * Get history of trades
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await bittrexApiClient.getTradesHistory(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        trades.forEach((trade) => {
          result.push({
            coin1Amount: +trade.quantity, // amount in coin1
            price: +trade.rate, // trade price
            coin2Amount: +trade.quantity * +trade.rate, // quote in coin2
            // trade.executedAt is like '2022-01-02T15:00:46.28Z'
            date: new Date(trade.executedAt).getTime(), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.takerSide?.toLowerCase(), // 'buy' or 'sell'
            tradeId: trade.id?.toString(),
          });
        });

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
     * @param {String} coin As BTC
     * @returns {Promise<Array|undefined>}
     */
    async getDepositAddress(coin) {
      const paramString = `coin: ${coin}`;

      let data;

      try {
        data = await bittrexApiClient.getDepositAddress(coin);
      } catch (error) {
        log.warn(`API request getDepositAddress(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (!data.bittrexErrorInfo) {
          return [{ network: null, address: data.cryptoAddress }];
        } else if (data.code === 'NOT_FOUND') {
          // if address is not found, try to create it
          data = await bittrexApiClient.createDepositAddress(coin);
          log.log(`Unable to get deposit address for ${coin} on Bittrex. Will try to create it.`);

          await new Promise((resolve) => setTimeout(() => resolve(), 2000)); // waiting for creation on the bittrex side

          data = await bittrexApiClient.getDepositAddress(coin);

          return [{ network: null, address: data.cryptoAddress }];
        } else {
          const errorMessage = data?.bittrexErrorInfo || 'No details';
          log.log(`Unable to get deposit address for ${coin}: ${errorMessage}.`);
          return undefined;
        }
      } catch (error) {
        log.warn(`Error while processing getDepositAddress(${paramString}) request results: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get trading fees for account
     * @param coinOrPair e.g., 'ETH' or 'ETH/USDT'. If not set, get info for all trade pairs
     * @return {Promise<Array|undefined>}
     */
    async getFees(coinOrPair) {
      const paramString = `coinOrPair: ${coinOrPair}`;

      let coinPair;
      let coin;
      if (coinOrPair?.includes('/')) {
        coinPair = formatPairName(coinOrPair);
      } else {
        coin = coinOrPair?.toUpperCase();
      }

      let data;

      try {
        data = await bittrexApiClient.getFees();
      } catch (error) {
        log.warn(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];
        data.forEach((pair) => {
          result.push({
            pair: pair.marketSymbol,
            makerRate: +pair.makerRate,
            takerRate: +pair.takerRate,
          });
        });

        if (coinPair) {
          result = result.filter((pair) => pair.pair === coinPair.pairPlain);
        } else if (coin) {
          result = result.filter((pair) => pair.pair.includes(coin + '-'));
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getFees(${paramString}) request result: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get 30-days trading volume for account
     * @return {Object|undefined}
     */
    async getVolume() {
      let data;

      try {
        data = await bittrexApiClient.getVolume();
      } catch (error) {
        log.warn(`API request getVolume() of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        return {
          updated: data.updated,
          volume30days: +data.volume30days,
          volumeUnit: 'USD',
        };
      } catch (error) {
        log.warn(`Error while processing getVolume() request result: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },
  };
};

/**
 * Returns pair in Bittrex format like 'BTC-USDT'
 * @param pair Pair in any format
 * @returns {Object|Boolean} pair, pairReadable, pairPlain, coin1, coin2
*/
function formatPairName(pair) {
  if (pair.indexOf('/') > -1) {
    pair = pair.replace('/', '-').toUpperCase();
  } else if (pair.indexOf('_') !== -1) {
    pair = pair.replace('_', '-').toUpperCase();
  }
  const [coin1, coin2] = pair.split('-');
  return {
    coin1: coin1.toUpperCase(),
    coin2: coin2.toUpperCase(),
    pair: `${coin1}${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: pair,
  };
}
