const TapbitAPI = require('./api/tapbit_api');
const config = require('./../modules/config/reader');
const utils = require('../helpers/utils');
const _networks = require('./../helpers/networks');

/**
 * API endpoints:
 * https://openapi.tapbit.com/spot
 */
const apiServer = 'https://openapi.tapbit.com/spot';
const exchangeName = 'Tapbit';

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
  const tapbitApiClient = TapbitAPI();

  tapbitApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

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
      tapbitApiClient.markets().then((markets) => {
        try {
          const result = {};

          for (const market of markets) {
            const pairNames = formatPairName(market.trade_pair_name);

            result[pairNames.pairPlain] = {
              pairReadable: market.trade_pair_name,
              pairPlain: market.trade_pair_name,
              coin1: market.base_asset,
              coin2: market.quote_asset,
              coin1Decimals: +market.amount_precision,
              coin2Decimals: +market.price_precision,
              coin1Precision: utils.getPrecision(+market.amount_precision),
              coin2Precision: utils.getPrecision(+market.price_precision),
              coin1MinAmount: +market.min_amount,
              coin1MaxAmount: null,
              coin2MinAmount: +market.min_notional,
              coin2MaxAmount: null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: +market.min_amount, // in coin1
              status: undefined, // 'ONLINE', 'OFFLINE'
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
      tapbitApiClient.currencies().then((currencies) => {
        try {
          const result = {};

          for (const currency of currencies) {
            const networks = {};

            for (const network of currency.chains) {
              const networkName = formatNetworkName(network.chain);

              networks[networkName] = {
                chainName: network.chain,
                status: network.is_deposit_enabled || network.is_withdraw_enabled ? 'ONLINE' : 'OFFLINE',
                depositStatus: network.is_deposit_enabled ? 'ONLINE' : 'OFFLINE',
                withdrawalStatus: network.is_withdraw_enabled ? 'ONLINE' : 'OFFLINE',
                confirmations: +network.deposit_min_confirm,
                withdrawalFee: +network.fee,
                decimals: +network.precision,
                precision: utils.getPrecision(+network.precision),
                minWithdrawal: +network.withdraw_limit_min,
              };
            }

            result[currency.currency] = {
              symbol: currency.currency,
              name: currency.full_name,
              status: Object.values(networks).find((network) => network.status === 'ONLINE') ? 'ONLINE' : 'OFFLINE', // 'ONLINE', 'OFFLINE'
              comment: undefined,
              type: undefined, // 'fiat'
              exchangeAddress: undefined,
              confirmations: undefined, // specific for each network
              decimals: undefined, // specific for each network
              precision: undefined, // specific for each network
              networks,
              defaultNetwork: undefined,
            };
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

    /**
     * Features available on Tapbit exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: true,
        placeMarketOrder: false,
        getDepositAddress: false,
        getTradingFees: false, // Available in markets endpoint
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: false,
        getFundHistory: false,
        getFundHistoryImplemented: false,
        allowAmountForMarketBuy: null,
        amountForMarketOrderNecessary: null,
        accountTypes: false, // Tapbit doesn't supports main, trade, margin accounts
        withdrawAccountType: '', // Withdraw funds from single account
        withdrawalSuccessNote: false, // No additional action needed after a withdrawal by API
        supportTransferBetweenAccounts: false,
        supportCoinNetworks: true,
        orderNumberLimit: config.exchange_restrictions?.orderNumberLimit || 100, // While Tapbit doesn't restrict order number, if its > 100, two getOpenOrdersPage() in sequence regularly fail
      };
    },

    /**
     * Get user balances
     * @param {Boolean} [nonzero=true] Return only non-zero balances
     * @returns {Promise<Array|undefined>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let balances;

      try {
        balances = await tapbitApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        for (const crypto of balances) {
          result.push({
            code: crypto.asset.toUpperCase(),
            free: +crypto.available,
            freezed: +crypto.frozen_balance,
            total: +crypto.total_balance,
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
     * @param {String} [nextOrderId]
     * @returns {Promise<[]|undefined>}
     */
    async getOpenOrdersPage(pair, nextOrderId) {
      const paramString = `pair: ${pair}, nextOrderId: ${nextOrderId}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await tapbitApiClient.getOrders(coinPair.pairPlain, nextOrderId);
      } catch (error) {
        log.warn(`API request getOpenOrdersPage(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        for (const order of orders) {
          // order.status: open, complete -> Filled, cancelled, partially cancelled (note: actually, capitalized)
          let orderStatus;
          if (order.filled_quantity === '0') {
            orderStatus = 'new';
          } else if (order.filled_quantity === order.quantity) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'part_filled';
          }

          result.push({
            orderId: order.order_id.toString(),
            symbol: order.trade_pair_name,
            price: +order.price,
            side: order.direction, // 'buy' or 'sell'
            type: order.order_type, // 'limit' or 'market'
            timestamp: +order.order_time, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            amount: +order.quantity,
            amountExecuted: +order.filled_quantity,
            amountLeft: +order.quantity - +order.filled_quantity,
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
      const paramString = `pair: ${pair}`;

      let allOrders = [];
      let ordersInfo;
      let nextOrderId;

      try {
        do {
          ordersInfo = await this.getOpenOrdersPage(pair, nextOrderId);
          if (!ordersInfo) return undefined;

          allOrders = allOrders.concat(ordersInfo);

          // Get the last order Id-1, take the next page of data
          if (ordersInfo.length) {
            nextOrderId = (BigInt(+ordersInfo[ordersInfo.length - 1].orderId) - 1n).toString();
          }
        } while (ordersInfo.length);

        return allOrders;
      } catch (error) {
        log.warn(`Error while processing getOpenOrders(${paramString}): ${error}`);
        return undefined;
      }
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {String} orderId Example: '2257824251095171072'
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;

      let order;

      try {
        order = await tapbitApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.order_id) {
          // order.status: open, complete -> Filled, cancelled, partially cancelled (note: actually, capitalized)
          let orderStatus;
          if (order.status === 'Filled') {
            orderStatus = 'filled';
          } else if (order.status === 'Cancelled') {
            orderStatus = 'cancelled';
          } else if (order.status === 'Open') {
            if (order.filled_quantity === '0') {
              orderStatus = 'new';
            } else {
              orderStatus = 'part_filled';
            }
          }

          const result = {
            orderId: order.order_id.toString(),
            tradesCount: undefined, // Tapbit doesn't provide trades info
            price: +order.price, // Order price, not the filled price
            side: order.direction.toLowerCase(), // 'buy' or 'sell'
            type: order.order_type.toLowerCase(), // 'limit'
            amount: +order.quantity, // In coin1
            volume: +order.amount, // In coin2, calculated based on Order price, not on the filled price
            pairPlain: order.trade_pair_name,
            pairReadable: order.trade_pair_name,
            totalFeeInCoin2: +order.fee,
            amountExecuted: +order.filled_quantity, // In coin1
            volumeExecuted: +order.filled_amount, // In coin2
            timestamp: +order.order_time, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            updateTimestamp: undefined, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order.tapbitErrorInfo ?? 'No details.';
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
     * @param {String} orderId Example: '2257616624297820160'
     * @param {String} side Not used for Tapbit
     * @param {String} pair Not used for Tapbit. In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;

      let order;

      try {
        order = await tapbitApiClient.cancelOrder(orderId);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.order_id) {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = order?.tapbitErrorInfo ?? 'No details';
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
     * @param side Cancel buy or sell orders. Cancel both if not set.
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelAllOrders(pair, side) {
      const paramString = `pair: ${pair}, side: ${side}`;
      const coinPair = formatPairName(pair);

      let ordersToCancel;

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

        if (ordersToCancelCount === 0) {
          log.log(`Cancelling all ${coinPair.pairReadable} orders: No open orders.`);
          return true;
        } else if (ordersToCancel.length === 1) {
          response = await this.cancelOrder(ordersToCancel[0].orderId, undefined, pair);

          cancelledCount += response ? 1 : 0;
        } else {
          const currentOrders = ordersToCancel.map((order) => order.orderId);

          try {
            response = await tapbitApiClient.cancelAllOrders(currentOrders);
          } catch (error) {
            log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
            return undefined;
          }

          try {
            if (response.length) {
              cancelledCount += response.length;
            }
          } catch (error) {
            log.warn(`Error while processing cancelAllOrders-2(${paramString}) request: ${error}`);
            return undefined;
          }
        }

        if (cancelledCount === ordersToCancelCount) {
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
        ticker = await tapbitApiClient.ticker(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (ticker.lowest_ask && ticker.highest_bid) {
          return {
            ask: +ticker.lowest_ask,
            bid: +ticker.highest_bid,
            last: +ticker.last_price,
            volume: +ticker.volume24h,
            volumeInCoin2: +ticker.amount24h,
            high: +ticker.highest_price_24h,
            low: +ticker.lowest_price_24h,
          };
        }
      } catch (error) {
        log.warn(`Error while processing getRates(${paramString}) request result: ${JSON.stringify(ticker)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Places an order
     * Tapbit supports only limit orders
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

      let output = '';

      if (coin2Amount) {
        output = `${side} ${coin1Amount} ${marketInfo.coin1} for ${coin2Amount} ${marketInfo.coin2} at ${price} ${marketInfo.coin2}.`;
      } else {
        output = `${side} ${coin1Amount} ${marketInfo.coin1} for ~${coin2AmountCalculated.toFixed(marketInfo.coin2Decimals)} ${marketInfo.coin2} at ${price} ${marketInfo.coin2}.`;
      }

      const order = {};
      let response;
      let orderId;
      let errorMessage;

      try {
        response = await tapbitApiClient.addOrder(marketInfo.pairPlain, coin1Amount, price, side);

        errorMessage = response?.tapbitErrorInfo;
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
        book = await tapbitApiClient.orderBook(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (book.asks.length || book.bids.length) {
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
        }
      } catch (error) {
        log.warn(`Error while processing getOrderBook(${paramString}) request result: ${JSON.stringify(book)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get history of trades
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<[]|undefined>}
     */
    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await tapbitApiClient.getTradesHistory(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (trades.length) {
          const result = [];

          for (const trade of trades) {
            result.push({
              coin1Amount: +trade[2], // amount in coin1
              price: +trade[1], // trade price
              coin2Amount: +trade[2] * +trade[1], // quote in coin2
              date: +trade[4], // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
              type: trade[3].toLowerCase(), // 'buy' or 'sell'
              tradeId: null,
            });
          }

          // We need ascending sort order
          result.sort((a, b) => {
            return parseFloat(a.date) - parseFloat(b.date);
          });

          return result;
        }
      } catch (error) {
        log.warn(`Error while processing getTradesHistory(${paramString}) request result: ${JSON.stringify(trades)}. ${error}`);
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
  const networksNameMap = {
    'Ethereum(ERC20)': _networks['ERC20'].code,
    'BNB Smart Chain(BEP20)': _networks['BEP20'].code,
    'Tron(TRC20)': _networks['TRC20'].code,
    Polygon: _networks['MATIC'].code,
    'Arbitrum One': _networks['ARBITRUM'].code,
    Bitcoin: _networks['BTC'].code,
    Solana: _networks['SOL'].code,
    Optimism: _networks['OPTIMISM'].code,
    'AVAX C-Chain': _networks['AVAX-C-CHAIN'].code,
    Polkadot: _networks['DOT'].code,
    'OKC Token': _networks['OKT'].code,
    EOS: _networks['EOS'].code,
    Tezos: _networks['XTZ'].code,
    'Ethereum Classic': _networks['ETC'].code,
    Flow: _networks['FLOW'].code,
    'Stellar Network': _networks['XLM'].code,
    'Chiliz Chain(CAP20)': _networks['CAP20'].code,
    'Ordinals(BRC20)': _networks['BRC20'].code,
  };

  return networksNameMap[network] || network;
}

/**
 * Returns pair in Tapbit format like 'BTC/USDT'
 * @param pair Pair in any format
 * @returns {Object|Boolean} pairReadable, pairPlain, coin1, coin2
*/
function formatPairName(pair) {
  if (pair.indexOf('_') > -1) {
    pair = pair.replace('/', '/').toUpperCase();
  } else if (pair.indexOf('-') !== -1) {
    pair = pair.replace('-', '/').toUpperCase();
  }
  const [coin1, coin2] = pair.split('/');
  return {
    coin1: coin1.toUpperCase(),
    coin2: coin2.toUpperCase(),
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: pair.toUpperCase(),
  };
}
