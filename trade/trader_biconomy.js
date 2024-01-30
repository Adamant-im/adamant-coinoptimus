const BiconomyAPI = require('./api/biconomy_api');
const utils = require('../helpers/utils');

/**
 * API endpoints:
 * https://www.biconomy.com/api
 * https://market.biconomy.vip/api
 */
const apiServer = 'https://market.biconomy.vip/api';
const exchangeName = 'Biconomy';

const orderSideMap = {
  1: 'sell',
  2: 'buy',
};

const orderTypeMap = {
  1: 'limit',
  2: 'market',
};

module.exports = (
    apiKey,
    secretKey,
    pwd,
    log,
    publicOnly = false,
    loadMarket = true,
) => {
  const biconomyApiClient = BiconomyAPI();

  biconomyApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
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
      biconomyApiClient.markets().then((markets) => {
        try {
          const result = {};

          for (const market of markets) {
            const pairNames = formatPairName(market.symbol);

            result[pairNames.pairPlain] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: pairNames.pairPlain,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals: +market.baseAssetPrecision,
              coin2Decimals: +market.quoteAssetPrecision,
              coin1Precision: utils.getPrecision(+market.baseAssetPrecision),
              coin2Precision: utils.getPrecision(+market.quoteAssetPrecision),
              coin1MinAmount: null,
              coin1MaxAmount: null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: null, // in coin1
              status: market.status === 'trading' ? 'ONLINE' : 'OFFLINE', // 'ONLINE', 'OFFLINE'
            };
          }

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

  return {
    getMarkets,

    /**
     * Getter for stored markets info
     * @return {Object}
     */
    get markets() {
      return module.exports.exchangeMarkets;
    },

    marketInfo(pair) {
      return getMarkets(pair);
    },

    /**
     * Features available on Biconomy exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: false,
        placeMarketOrder: false, // While market orders allowed, buy-orders fail with 'Internal Server Error'
        getDepositAddress: false,
        getTradingFees: false,
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: true,
        getFundHistory: false,
        getFundHistoryImplemented: false,
        allowAmountForMarketBuy: true,
        amountForMarketOrderNecessary: true,
        accountTypes: false, // Biconomy doesn't supports main, trade, margin accounts
        withdrawAccountType: '', // Withdraw funds from single account
        withdrawalSuccessNote: false, // No additional action needed after a withdrawal by API
        supportTransferBetweenAccounts: false,
        supportCoinNetworks: false,
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
        balances = await biconomyApiClient.getBalances();
        balances = balances.result;
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        for (const code in balances) {
          const crypto = balances[code];
          result.push({
            code: code.toUpperCase(),
            free: +crypto.available,
            freezed: +crypto.freeze + +crypto.other_freeze,
            total: +crypto.available + +crypto.freeze + +crypto.other_freeze,
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
     * Get one page of account open orders
     * @param {String} pair In classic format as BTC/USDT
     * @param {Number} [limit=100]
     * @param {Number} [offset=0]
     * @returns {Promise<[]|undefined>}
     */
    async getOpenOrdersPage(pair, limit = 100, offset = 0) {
      const paramString = `pair: ${pair}, offset: ${offset}, limit: ${limit}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await biconomyApiClient.getOrders(coinPair.pairPlain, limit, offset);
        orders = orders.result.records;
      } catch (error) {
        log.warn(`API request getOpenOrdersPage(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        for (const order of orders) {
          let orderStatus;
          if (order.amount === order.left) {
            orderStatus = 'new';
          } else if (order.left === '0') {
            orderStatus = 'filled';
          } else {
            orderStatus = 'part_filled';
          }

          result.push({
            orderId: order.id.toString(),
            symbol: formatPairName(order.market).pairReadable, // In readable format as BTC/USDT
            symbolPlain: order.market,
            price: +order.price,
            side: orderSideMap[order.side], // 'buy' or 'sell'
            type: orderTypeMap[order.type], // 'limit' or 'market'
            timestamp: Math.floor(order.ctime * 1000), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            amount: +order.amount,
            amountExecuted: +order.amount - +order.left,
            amountLeft: +order.left,
            status: orderStatus,
          });
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getOpenOrdersPage(${paramString}) request results: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * List of all account open orders
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<[]|undefined>}
     */
    async getOpenOrders(pair) {
      let allOrders = [];
      let ordersInfo;
      let offset = 0;
      const limit = 100;

      do {
        ordersInfo = await this.getOpenOrdersPage(pair, limit, offset);
        if (!ordersInfo) return undefined;

        allOrders = allOrders.concat(ordersInfo);

        offset += limit;
      } while (ordersInfo.length === limit);

      return allOrders;
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {String} orderId Example: '32868'
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let response;
      let trades; // We don't request trades on orders not to make more requests
      let fillStatus;

      try {
        response = await biconomyApiClient.getFinishedOrder(coinPair.pairPlain, orderId);
        fillStatus = 'finished';

        if (!response?.result?.id) {
          response = await biconomyApiClient.getPendingOrder(coinPair.pairPlain, orderId);
          fillStatus = 'pending';
        }
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (response?.result?.id) {
          let orderStatus;

          if (fillStatus === 'finished') {
            if (response.result.amount === response.result.deal_stock) {
              orderStatus = 'filled';
            } else {
              orderStatus = 'cancelled';
            }
          } else {
            if (response.result.amount === response.result.left) {
              orderStatus = 'new';
            } else {
              orderStatus = 'part_filled';
            }
          }

          const result = {
            orderId: response.result.id.toString(),
            tradesCount: trades?.result?.records?.length,
            price: +response.result.price, // limit price, NaN for market orders
            side: orderSideMap[response.result.side], // 'buy' or 'sell'
            type: orderTypeMap[response.result.type], // 'limit' or 'market'
            amount: +response.result.amount, // In coin1
            volume: +response.result.price * +response.result.amount, // In coin2 ~
            pairPlain: coinPair.pairPlain,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: +response.result.deal_fee,
            amountExecuted: +response.result.deal_stock, // In coin1
            volumeExecuted: +response.result.deal_money, // In coin2
            timestamp: Math.floor(response.result.ctime * 1000), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            updateTimestamp: Math.floor((response.result.mtime ?? response.result.ftime) * 1000),
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = response?.biconomyErrorInfo || trades?.biconomyErrorInfo || 'No details';
          log.log(`Unable to get order ${orderId} details: ${JSON.stringify(errorMessage)}. Returning unknown order status.`);

          return {
            orderId,
            status: 'unknown', // Order doesn't exist or Wrong orderId
          };
        }
      } catch (error) {
        log.warn(`Error while processing getOrderDetails(${paramString}) request: ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel an order
     * @param {String} orderId Example: '32868'
     * @param {String} side Not used for Biconomy
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await biconomyApiClient.cancelOrder(coinPair.pairPlain, orderId);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order?.result?.id) {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = order?.biconomyErrorInfo ?? 'No details';
          log.log(`Unable to cancel order ${orderId} on ${pair} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelOrder(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel all orders on a specific pair
     * @param {String} pair In classic format as BTC/USD
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let ordersToCancel;

      const marketInfo = this.marketInfo(pair);
      if (!marketInfo) {
        log.warn(`Unable to cancel orders on pair: ${pair}. Pair doesn't exist`);
        return false;
      }

      try {
        ordersToCancel = await this.getOpenOrders(pair);
      } catch (error) {
        log.warn(`API request cancelAllOrders-getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const ordersToCancelCount = ordersToCancel.length;
        let cancelledCount = 0;

        let response;

        if (ordersToCancelCount === 1) {
          response = await this.cancelOrder(ordersToCancel[0].orderId, undefined, pair);

          cancelledCount = response ? 1 : 0;
        } else if (ordersToCancelCount > 1) {
          while (ordersToCancel.length) {
            // The number of orders cancelled in batches each time does not exceed 10
            const currentOrders = ordersToCancel.splice(0, 10);

            try {
              response = await biconomyApiClient.cancelAllOrders(currentOrders, coinPair.pairPlain);
            } catch (error) {
              log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
              return undefined;
            }

            if (response.result?.length) {
              cancelledCount += response.result.filter((order) => order.order_id).length;
            }
          }
        }

        if (ordersToCancelCount === 0) {
          log.log(`Cancelling all ${coinPair.pairReadable} orders: No open orders.`);
          return true;
        } else if (cancelledCount === ordersToCancelCount) {
          log.log(`Cancelled all ${cancelledCount} orders on ${coinPair.pairReadable} pair…`);
          return true;
        } else {
          log.warn(`Cancelled ${cancelledCount} of ${ordersToCancelCount} orders on ${coinPair.pairReadable} pair…`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelAllOrders-1(${paramString}) request: ${error}`);
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
        ticker = await biconomyApiClient.ticker();
        ticker = ticker.ticker.find((el) => el.symbol === coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (ticker.sell) {
          return {
            ask: +ticker.sell,
            bid: +ticker.buy,
            last: +ticker.last,
            volume: +ticker.vol,
            volumeInCoin2: +ticker.vol * +ticker.last,
            high: +ticker.high,
            low: +ticker.low,
          };
        }
      } catch (error) {
        log.warn(`Error while processing getRates(${paramString}) request result: ${JSON.stringify(ticker)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Places an order
     * Biconomy supports both limit and market orders
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

      if (coin1Amount) {
        coin1Amount = (+coin1Amount).toFixed(marketInfo.coin1Decimals);
      }
      if (coin2Amount) {
        coin2Amount = (+coin2Amount).toFixed(marketInfo.coin2Decimals);
      }
      if (price) {
        price = (+price).toFixed(marketInfo.coin2Decimals);
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
        response = await biconomyApiClient.addOrder(marketInfo.pairPlain, coin1Amount, price, side, orderType);

        errorMessage = response?.biconomyErrorInfo;
        orderId = response?.result?.id;
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
        book = await biconomyApiClient.orderBook(coinPair.pairPlain);
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
     * Get history of trades
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await biconomyApiClient.getTradesHistory(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        for (const trade of trades) {
          result.push({
            coin1Amount: +trade.amount, // amount in coin1
            price: +trade.price, // trade price
            coin2Amount: +trade.amount * +trade.price, // quote in coin2
            date: +trade.timestamp, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.side.toLowerCase(), // 'buy' or 'sell'
            tradeId: null,
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
  };
};

/**
 * Returns pair in Biconomy format like 'BTC_USDT'
 * @param pair Pair in any format
 * @returns {Object|Boolean} pairReadable, pairPlain, coin1, coin2
*/
function formatPairName(pair) {
  if (pair.indexOf('/') > -1) {
    pair = pair.replace('/', '_').toUpperCase();
  } else if (pair.indexOf('-') !== -1) {
    pair = pair.replace('-', '_').toUpperCase();
  }

  const [coin1, coin2] = pair.split('_');

  return {
    coin1: coin1.toUpperCase(),
    coin2: coin2.toUpperCase(),
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: pair,
  };
}
