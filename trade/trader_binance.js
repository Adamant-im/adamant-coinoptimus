const BinanceApi = require('./api/binance_api');
const utils = require('../helpers/utils');

/**
 * API endpoints:
 * https://api.binance.com
 * https://api1.binance.com
 * https://api2.binance.com
 * https://api3.binance.com
 * https://api4.binance.com
 * All endpoints are equal in functionality.
 * Performance may vary between the base endpoints and can be freely switched between them to find which one works best for one's setup.
 * Data is returned in ascending order. Oldest first, newest last.
 * All time and timestamp related fields are in milliseconds.
*/
const apiServer = 'https://api.binance.com';
const exchangeName = 'Binance';

const DEFAULT_MAX_NUM_ORDERS = 200;

module.exports = (apiKey, secretKey, pwd, log, publicOnly = false, loadMarket = true) => {
  const binanceApiClient = BinanceApi();

  binanceApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
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
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      binanceApiClient.markets().then((data) => {
        try {
          const result = {};

          const markets = data.symbols;

          markets.forEach((market) => {
            const filterByType = (type) => (
              market.filters?.filter((filter) => filter.filterType?.toUpperCase() === type)[0]
            );

            const priceFilter = filterByType('PRICE_FILTER');
            const lotFilter = filterByType('LOT_SIZE');
            const notionalFilter = filterByType('MIN_NOTIONAL');
            const maxOrdersFilter = filterByType('MAX_NUM_ORDERS');

            const pairReadable = `${market.baseAsset}/${market.quoteAsset}`;

            result[pairReadable] = {
              pairReadable, // LTC/BTC
              pairPlain: market.symbol, // LTCBTC
              coin1: market.baseAsset,
              coin2: market.quoteAsset,
              coin1Decimals: utils.getDecimalsFromPrecision(+lotFilter?.stepSize) ?? market.baseAssetPrecision,
              coin2Decimals: utils.getDecimalsFromPrecision(+priceFilter?.tickSize) ?? market.quoteAssetPrecision,
              coin1Precision: +lotFilter?.stepSize || utils.getPrecision(market.baseAssetPrecision),
              coin2Precision: +priceFilter?.tickSize || utils.getPrecision(market.quoteAssetPrecision),
              coin1MinAmount: +lotFilter?.minQty || null,
              coin1MaxAmount: +lotFilter?.maxQty || null,
              coin2MinAmount: +notionalFilter?.minNotional || null,
              coin2MaxAmount: null,
              coin2MinPrice: +priceFilter?.minPrice || null,
              coin2MaxPrice: +priceFilter?.maxPrice || null,
              minTrade: +notionalFilter?.minNotional || null, // in coin2,
              statusPlain: market.status, // PRE_TRADING, TRADING, POST_TRADING, END_OF_DAY, HALT, AUCTION_MATCH, BREAK
              status: market.status === 'TRADING' && market.isSpotTradingAllowed ? 'ONLINE' : 'OFFLINE', // 'ONLINE' for active
              orderTypes: market.orderTypes, // like 'LIMIT', 'LIMIT_MAKER', 'MARKET', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'
              quoteOrderQtyMarketAllowed: market.quoteOrderQtyMarketAllowed,
              maxNumOrders: +maxOrdersFilter?.maxNumOrders || null,
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
        log.warn(`API request getMarkets(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingMarkets = false;
      });
    });
  }

  return {
    /**
     * Getter for stored markets info
     * @returns {Object}
     */
    get markets() {
      return module.exports.exchangeMarkets;
    },

    /**
     * Get info for a specific market
     * @param pair In readable format as BTC/USDT or in Binance format as BTCUSDT
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      if (pair?.includes('/')) {
        return getMarkets(pair);
      }

      for (const market of Object.values(module.exports.exchangeMarkets)) {
        if (market.pairPlain?.toUpperCase() === pair?.toUpperCase()) {
          return market;
        }
      }
    },

    /**
     * Features available on Binance exchange
     * @returns {Object}
     */
    features(pair) {
      return {
        getMarkets: true,
        placeMarketOrder: true,
        getDepositAddress: true,
        getTradingFees: true,
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: false,
        getFundHistory: true,
        getFundHistoryImplemented: false,
        allowAmountForMarketBuy: true,
        amountForMarketOrderNecessary: pair ? !this.marketInfo(pair)?.quoteOrderQtyMarketAllowed : false,
        orderNumberLimit: pair ? this.marketInfo(pair)?.maxNumOrders : DEFAULT_MAX_NUM_ORDERS,
      };
    },

    /**
     * Get user balances
     * @param {Boolean} nonzero Return only non-zero balances. By default, Binance return zero assets as well.
     * @returns {Promise<unknown>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let data;

      try {
        data = await binanceApiClient.getBalances();
      } catch (error) {
        return log.warn(
            `API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`
        );
      }

      try {
        let result = data.balances.map((crypto) => ({
          code: crypto.asset,
          free: +crypto.free,
          freezed: +crypto.locked,
          total: +crypto.free + +crypto.locked,
        }));

        if (nonzero) {
          result = result.filter((crypto) => crypto.free || crypto.freezed);
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getBalances(${paramString}) request: ${error}`);
      }
    },

    /**
     * List of all account open orders
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<*[]|undefined>}
     */
    async getOpenOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let data;

      try {
        data = await binanceApiClient.getOrders(coinPair.pair);
      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const openOrders = data;
        const result = [];

        // Possible order.status
        // NEW, PARTIALLY_FILLED, FILLED, CANCELED, PENDING_CANCEL (unused), REJECTED, EXPIRED, EXPIRED_IN_MATCH

        openOrders.forEach((order) => {
          let orderStatus;
          if (order.status === 'NEW') {
            orderStatus = 'new';
          } else if (order.status === 'PARTIALLY_FILLED') {
            orderStatus = 'part_filled';
          } else {
            orderStatus = 'filled';
          }

          result.push({
            orderId: order.orderId?.toString(),
            symbol: this.marketInfo(order.symbol)?.pairReadable, // ETC/USDT
            symbolPlain: order.symbol, // ETCUSDT
            price: +order.price,
            side: order.side.toLowerCase(), // 'buy' or 'sell'
            type: order.type.toLowerCase(), // 'limit' or 'market'
            timestamp: order.time,
            amount: +order.origQty,
            amountExecuted: +order.executedQty,
            amountLeft: +order.origQty - +order.executedQty,
            status: orderStatus,
          });
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getOpenOrders(${paramString}) request results: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {String} orderId Example: '3065308830'
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<unknown>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await binanceApiClient.getOrder(orderId, coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order && !order.binanceErrorInfo) {
          // Possible order.status
          // NEW, PARTIALLY_FILLED, FILLED, CANCELED, PENDING_CANCEL (unused), REJECTED, EXPIRED, EXPIRED_IN_MATCH

          let orderStatus;
          if (order.status === 'NEW') {
            orderStatus = 'new';
          } else if (order.status === 'PARTIALLY_FILLED') {
            orderStatus = 'part_filled';
          } else if (['CANCELED', 'PENDING_CANCEL', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(order.status)) {
            orderStatus = 'cancelled';
          } else {
            orderStatus = 'filled';
          }

          const result = {
            orderId: order.orderId?.toString(),
            tradesCount: undefined, // Binance doesn't provide trades
            price: +order.price,
            side: order.side.toLowerCase(), // 'buy' or 'sell'
            type: order.type.toLowerCase(), // 'limit' or 'market'
            amount: +order.origQty,
            volume: +order.origQty * +order.price,
            pairPlain: coinPair.pairPlain,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: undefined, // Binance doesn't provide fee info
            amountExecuted: +order.executedQty, // In coin1
            volumeExecuted: +order.cummulativeQuoteQty * +order.executedQty, // In coin2 // ?
            timestamp: order.time,
            updateTimestamp: order.updateTime,
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order?.binanceErrorInfo || 'No details';
          log.log(`Unable to get order ${orderId} details: ${errorMessage}.`);

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
     * @param {String} orderId Example: '3065308830'
     * @param {String} side Not used for Binance
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<unknown>}
     */
    cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      return new Promise((resolve, reject) => {
        binanceApiClient.cancelOrder(orderId, coinPair.pairPlain).then((data) => {
          if (data.status === 'CANCELED' && !data.binanceErrorInfo) {
            log.log(`Cancelling order ${orderId} on ${coinPair.pairReadable} pair…`);
            resolve(true);
          } else {
            const errorMessage = data?.binanceErrorInfo || 'No details';
            log.log(`Unable to cancel ${orderId} on ${coinPair.pairReadable}: ${errorMessage}.`);
            resolve(false);
          }
        }).catch((error) => {
          log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Cancel all order on specific pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<unknown>}
     */
    cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      return new Promise((resolve, reject) => {
        binanceApiClient.cancelAllOrders(coinPair.pairPlain).then((data) => {
          if (data && !data.binanceErrorInfo) {
            log.log(`Cancelling all orders on ${coinPair.pairReadable} pair…`);
            resolve(true);
          } else {
            const errorMessage = data?.binanceErrorInfo || 'No details'; // In case of 0 open orders: [-2011] Unknown order sent
            log.log(`Unable to cancel all orders on ${coinPair.pairReadable}: ${errorMessage}.`);
            resolve(false);
          }
        }).catch((error) => {
          log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Get info on trade pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<unknown>}
     */
    getRates(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      return new Promise((resolve, reject) => {
        binanceApiClient.ticker(coinPair.pairPlain).then((data) => {
          try {
            const ticker = data;

            resolve({
              ask: +ticker.askPrice,
              bid: +ticker.bidPrice,
              volume: +ticker.volume,
              volumeInCoin2: +ticker.quoteVolume,
              high: +ticker.highPrice,
              low: +ticker.lowPrice,
              last: +ticker.lastPrice,
            });
          } catch (error) {
            log.warn(`Error while processing getRates(${paramString}) request: ${error}`);
            resolve(undefined);
          }
        }).catch((error) => {
          log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Places an order
     * Binance supports both limit and market orders
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
        coin1Amount = +(+coin1Amount).toFixed(marketInfo.coin1Decimals);
      }
      if (coin2Amount) {
        coin2Amount = +(+coin2Amount).toFixed(marketInfo.coin2Decimals);
      }
      if (price) {
        price = +(+price).toFixed(marketInfo.coin2Decimals);
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
      let output;

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
        response = await binanceApiClient.addOrder(marketInfo.pairPlain, coin1Amount, coin2Amount, price, side, orderType);

        errorMessage = response?.binanceErrorInfo;
        orderId = response?.orderId;
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
     * @returns {Promise<unknown>}
     */
    getOrderBook(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      return new Promise((resolve) => {
        binanceApiClient.orderBook(coinPair.pairPlain).then((book) => {
          try {
            const result = {
              bids: [],
              asks: [],
            };

            book.asks.forEach((crypto) => {
              result.asks.push({
                amount: +crypto[1],
                price: +crypto[0],
                count: 1,
                type: 'ask-sell-right',
              });
            });
            result.asks.sort((a, b) => {
              return parseFloat(a.price) - parseFloat(b.price);
            });

            book.bids.forEach((crypto) => {
              result.bids.push({
                amount: +crypto[1],
                price: +crypto[0],
                count: 1,
                type: 'bid-buy-left',
              });
            });
            result.bids.sort((a, b) => {
              return parseFloat(b.price) - parseFloat(a.price);
            });

            resolve(result);
          } catch (error) {
            log.warn(`Error while processing orderBook(${paramString}) request: ${error}`);
            resolve(undefined);
          }
        }).catch((error) => {
          log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Get history of trades
     * @param {String} pair In classic format as BTC/USDT
     * @param {Number} limit Number of records to return
     * @returns {Promise<unknown>}
     */
    async getTradesHistory(pair, limit) {
      const paramString = `pair: ${pair}, limit: ${limit}`;
      const coinPair = formatPairName(pair);

      return new Promise((resolve) => {
        binanceApiClient.getTradesHistory(coinPair.pairPlain, limit).then((trades) => {
          try {
            const result = trades.map((trade) => ({
              coin1Amount: +trade.qty, // amount in coin1
              price: +trade.price, // trade price
              coin2Amount: +trade.quoteQty, // quote in coin2
              date: trade.time, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
              type: trade.isBuyerMaker ? 'buy' : 'sell', // 'buy' or 'sell'
              tradeId: trade.id?.toString(),
            }));

            // We need ascending sort order
            result.sort((a, b) => {
              return parseFloat(a.date) - parseFloat(b.date);
            });

            resolve(result);
          } catch (error) {
            log.warn(`Error while processing getTradesHistory(${paramString}) request: ${error}`);
            resolve(undefined);
          }
        }).catch((error) => {
          log.log(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}.`);
          resolve(undefined);
        });
      });
    },

    /**
     * Get deposit address for a coin
     * @param {String} coin As BTC
     * @returns {Promise<unknown>}
     */
    async getDepositAddress(coin) {
      const paramString = `coin: ${coin}`;

      let data;

      try {
        data = await binanceApiClient.getCurrencies();
      } catch (error) {
        log.warn(`API request getDepositAddress(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const coinDepositInformation = data.find((info) => info.coin.toLowerCase() === coin.toLowerCase());
        const networks = coinDepositInformation.networkList;

        const depositAddresses = [];

        await Promise.all(networks.map(async (network) => {
          const data = await binanceApiClient.getDepositAddress(coin, network.network);

          if (data?.address) {
            depositAddresses.push({ network: network.name, address: data.address });
          }
        }));

        return depositAddresses;
      } catch (error) {
        log.warn(`Error while processing getDepositAddress(${paramString}) request results: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get trading fees for account
     * @param coinOrPair BTC or BTC/USDT. If not set, get info for all trade pairs.
     */
    async getFees(coinOrPair) {
      const paramString = `coinOrPair: ${coinOrPair}`;

      let coinPair; let coin;
      if (coinOrPair?.includes('/')) {
        coinPair = formatPairName(coinOrPair);
      } else {
        coin = coinOrPair?.toUpperCase();
      }

      return new Promise((resolve) => {
        binanceApiClient.getFees(coinPair?.pairPlain).then((data) => {
          try {
            let result = [];

            data.forEach((pair) => {
              const asset = this.marketInfo(pair.symbol);

              if (asset) {
                result.push({
                  pair: asset.pairReadable,
                  makerRate: +pair.makerCommission,
                  takerRate: +pair.takerCommission,
                });
              }
            });

            if (coin) {
              result = result.filter((pair) => pair.pair.includes(coin + '/'));
            }

            resolve(result);
          } catch (error) {
            log.warn(`Error while processing getFees(${paramString}) request: ${error}`);
            resolve(undefined);
          }
        }).catch((error) => {
          log.log(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}.`);
          resolve(undefined);
        });
      });
    },
  };
};

/**
 * Returns pair in Binance format like ETHUSDT
 * @param pair Pair in any format
 * @returns {Object}
 */
function formatPairName(pair) {
  pair = pair?.toUpperCase();

  if (pair.indexOf('-') > -1) {
    pair = pair.replace('-', '_').toUpperCase();
  } else {
    pair = pair.replace('/', '_').toUpperCase();
  }

  const [coin1, coin2] = pair.split('_');

  return {
    coin1,
    coin2,
    pair: `${coin1}${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: `${coin1}${coin2}`,
  };
}
