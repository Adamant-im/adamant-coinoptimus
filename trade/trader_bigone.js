const BigoneAPI = require('./api/bigone_api');
const utils = require('../helpers/utils');
const _networks = require('./../helpers/networks');
const config = require('./../modules/config/reader');

/**
 * API endpoints:
 * https://big.one/api/v3
 */
const apiServer = 'https://big.one/api/v3';
const exchangeName = 'BigONE';

const orderSideMap = {
  BID: 'buy',
  ASK: 'sell',
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
  const bigoneApiClient = BigoneAPI();

  bigoneApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
  }

  /**
   * Get info on all markets and store in module.exports.exchangeMarkets
   * It's an internal function, not called outside of this module
   * @param {string} [pair] In classic format as BTC/USDT. If markets are already cached, get info for the pair.
   * @returns {Promise<unknown>|*}
   */
  function getMarkets(pair) {
    const paramString = `pair: ${pair}`;

    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair ? formatPairName(pair).pairPlain : pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      bigoneApiClient.markets().then((markets) => {
        try {
          const result = {};

          markets = markets.data;

          for (const market of markets) {
            const pairNames = formatPairName(market.name);

            result[pairNames.pairPlain] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: pairNames.pairPlain,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals: +market.base_scale,
              coin2Decimals: +market.quote_scale,
              coin1Precision: utils.getPrecision(+market.base_scale),
              coin2Precision: utils.getPrecision(+market.quote_scale),
              coin1MinAmount: null,
              coin1MaxAmount: null,
              coin2MinAmount: +market.min_quote_value,
              coin2MaxAmount: +market.max_quote_value,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: null, // in coin1
              status: undefined,
              pairId: market.id,
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

    /**
     * Get market info for a pair
     * @param {String} pair In classic format as BTC/USD
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      return getMarkets(pair);
    },

    /**
     * Features available on BigONE exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: false,
        placeMarketOrder: true,
        getDepositAddress: true,
        getTradingFees: true,
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: false,
        getFundHistory: true,
        getFundHistoryImplemented: false,
        allowAmountForMarketBuy: false,
        amountForMarketOrderNecessary: false,
        accountTypes: false, // Though BigONE supports funding & spot accounts, it's not implemented in the bot API
        withdrawAccountType: '', // Withdraw funds from single account
        withdrawalSuccessNote: false, // No additional action needed after a withdrawal by API
        supportTransferBetweenAccounts: false, // Though BigONE supports transferring between account types, it's not implemented in the bot API
        supportCoinNetworks: false, // While BigONE doesn't provide currencies and a network list, the gateway_name param can be used when withdrawal
      };
    },

    /**
     * Get user balances
     * @param {boolean} [nonzero=true] Return only non-zero balances
     * @returns {Promise<Array|undefined>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let balances;

      try {
        balances = await bigoneApiClient.getBalances();
        balances = balances.data;
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        for (const crypto of balances) {
          result.push({
            code: crypto.asset_symbol.toUpperCase(),
            free: +crypto.balance - +crypto.locked_balance,
            freezed: +crypto.locked_balance,
            total: +crypto.balance,
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
     * @param {string} pair In classic format as BTC/USDT
     * @param {number} [limit=200]
     * @param {string} [page_token]
     * @returns {Promise<Object|undefined>}
     */
    async getOpenOrdersPage(pair, limit = 200, page_token) {
      const paramString = `pair: ${pair}, limit: ${limit}, page_token: ${page_token}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bigoneApiClient.getOrders(coinPair.pairPlain, limit, page_token);
      } catch (error) {
        log.warn(`API request getOpenOrdersPage(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        for (const order of orders.data) {
          let orderStatus;
          if (+order.filled_amount === 0) {
            orderStatus = 'new';
          } else if (order.filled_amount === order.amount) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'part_filled';
          }

          result.push({
            orderId: order.id.toString(),
            symbolPlain: order.asset_pair_name,
            symbol: module.exports.exchangeMarkets[order.asset_pair_name]?.pairReadable, // In readable format as BTC/USDT
            price: +order.price,
            side: orderSideMap[order.side], // 'buy' or 'sell'
            type: order.type.toLowerCase(), // 'limit' or 'market'
            timestamp: new Date(order.created_at).getTime(), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            amount: +order.amount,
            amountExecuted: +order.filled_amount,
            amountLeft: +order.amount - +order.filled_amount,
            status: orderStatus,
          });
        }

        return { result, page_token: orders.page_token };
      } catch (error) {
        log.warn(`Error while processing getOpenOrdersPage(${paramString}) request results: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * List of all account open orders
     * @param {string} pair In classic format as BTC/USDT
     * @returns {Promise<Array|undefined>}
     */
    async getOpenOrders(pair) {
      let allOrders = [];
      let ordersInfo;
      let page_token;
      const limit = 200;

      do {
        ordersInfo = await this.getOpenOrdersPage(pair, limit, page_token);
        if (!ordersInfo) return undefined;
        allOrders = allOrders.concat(ordersInfo.result);
        page_token = ordersInfo.page_token;
      } while (page_token.length);

      return allOrders;
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {string} orderId Example: '41994282348'
     * @param {string} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await bigoneApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order?.data?.id) {
          order = order.data;

          let orderStatus;

          if (order.state === 'PENDING' || order.state === 'OPENING') {
            orderStatus = +order.filled_amount === 0 ? 'new' : 'part_filled';
          } else if (order.state === 'FILLED') {
            orderStatus = 'filled';
          } else {
            orderStatus = 'cancelled';
          }

          let amount;

          if (order.type.toLowerCase().includes('limit')) {
            amount = {
              amount: +order.amount,
              volume: +order.amount * +order.price,
              amountExecuted: +order.filled_amount,
              volumeExecuted: +order.filled_amount * +order.price,
            };
          } else {
            if (orderSideMap[order.side] === 'buy') {
              amount = {
                amount: +order.amount / +order.avg_deal_price,
                volume: +order.amount,
                amountExecuted: +order.filled_amount / +order.avg_deal_price,
                volumeExecuted: +order.filled_amount,
              };
            } else {
              amount = {
                amount: +order.amount,
                volume: +order.amount * +order.avg_deal_price,
                amountExecuted: +order.filled_amount,
                volumeExecuted: +order.filled_amount * +order.avg_deal_price,
              };
            }
          }

          const result = {
            orderId: order.id.toString(),
            tradesCount: undefined, // Bigone doesn't provide trades info
            price: +order.price, // filled price for market orders
            side: orderSideMap[order.side], // 'buy' or 'sell'
            type: order.type.toLowerCase(), // 'limit' or 'market'
            pairPlain: coinPair.pairPlain,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: undefined, // BigONE doesn't provide fee info
            timestamp: new Date(order.created_at).getTime(), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            updateTimestamp: new Date(order.updated_at).getTime(), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            status: orderStatus,
            ...amount,
          };

          return result;
        } else {
          const errorMessage = order.bigoneErrorInfo ?? 'No details.';
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
     * @param {string} orderId Example: '41994282348'
     * @param {string} side Not used for BigONE
     * @param {string} pair Not used for BigONE. In classic format as BTC/USDT
     * @returns {Promise<boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;

      let order;

      try {
        order = await bigoneApiClient.cancelOrder(orderId);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order?.data?.state === 'CANCELLED') {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = order?.bigoneErrorInfo ?? 'No details';
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
     * @returns {Promise<boolean|undefined>}
     */
    async cancelAllOrders(pair, side) {
      const paramString = `pair: ${pair}, side: ${side}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bigoneApiClient.cancelAllOrders(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (orders?.data?.failed?.length === 0) {
          log.log(`Cancelling ${orders.data.cancelled.length} orders on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = orders?.bigoneErrorInfo ?? 'No details';
          log.log(`Unable to cancel orders on ${pair} pair: ${errorMessage}.`);
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
        ticker = await bigoneApiClient.ticker(coinPair.pairPlain);
        ticker = ticker.data;
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        return {
          ask: +ticker.ask.price,
          bid: +ticker.bid.price,
          last: +ticker.close,
          volume: +ticker.volume,
          volumeInCoin2: +ticker.volume * +ticker.close,
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
     * BigONE supports both limit and market orders
     * @param {string} side 'buy' or 'sell'
     * @param {string} pair In classic format like BTC/USDT
     * @param {number} price Order price
     * @param {number} coin1Amount Base coin amount. Provide either coin1Amount or coin2Amount.
     * @param {number} limit 1 if order is limit (default), 0 in case of market order
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
        response = await bigoneApiClient.addOrder(marketInfo.pairPlain, coin1Amount, coin2Amount, price, side, orderType);

        errorMessage = response?.bigoneErrorInfo;
        orderId = response?.data?.id;
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
        book = await bigoneApiClient.orderBook(coinPair.pairPlain);
        book = book.data;
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
            amount: +crypto.quantity,
            price: +crypto.price,
            count: +crypto.order_count,
            type: 'ask-sell-right',
          });
        }
        result.asks.sort((a, b) => {
          return parseFloat(a.price) - parseFloat(b.price);
        });

        for (const crypto of book.bids) {
          result.bids.push({
            amount: +crypto.quantity,
            price: +crypto.price,
            count: +crypto.order_count,
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
     * @param {string} pair In classic format as BTC/USDT
     * @returns {Promise<boolean|undefined>}
     */
    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await bigoneApiClient.getTradesHistory(coinPair.pairPlain);
        trades = trades.data;
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
            date: new Date(trade.created_at).getTime(), // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.taker_side === 'BID' ? 'buy' : 'sell', // 'buy' or 'sell'
            tradeId: trade.id.toString(),
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
     * @param {string} coin As BTC
     * @returns {Promise<Array|undefined>}
     */
    async getDepositAddress(coin) {
      const paramString = `coin: ${coin}`;

      let data;

      try {
        data = await bigoneApiClient.getDepositAddress(coin);
      } catch (error) {
        log.warn(`API request getDepositAddress(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (!data.bigoneErrorInfo) {
          return data.data.map(({ chain, value, memo }) => {
            return {
              network: formatNetworkName(chain),
              address: value,
              memo,
            };
          });
        } else {
          const errorMessage = data?.bigoneErrorInfo || 'No details';
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
     * @param [coinOrPair] e.g., 'BTC' or 'BTC/USDT'.
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

      const symbols = [];
      if (coin) {
        for (const pair of Object.values(module.exports.exchangeMarkets)) {
          if (pair.coin1 === coin) {
            symbols.push(pair.pairPlain);
          }
        }

        if (!symbols.length) {
          return [];
        }
      }

      try {
        const result = [];

        let data;

        if (coinPair) {
          try {
            data = await bigoneApiClient.getFees(coinPair.pairPlain);
          } catch (error) {
            log.warn(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
            return undefined;
          }
        } else {
          const symbolsString = symbols.join(',');

          try {
            data = await bigoneApiClient.getFees(symbolsString);
          } catch (error) {
            log.warn(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
            return undefined;
          }
        }

        try {
          for (const pair of data.data) {
            result.push({
              pair: formatPairName(pair.asset_pair_name).pairReadable,
              makerRate: +pair.maker_fee_rate,
              takerRate: +pair.taker_fee_rate,
            });
          }
        } catch (error) {
          log.warn(`Error while processing getFees(${paramString}) request result: ${JSON.stringify(data)}. ${error}`);
          return undefined;
        }

        return result;
      } catch (error) {
        log.warn(`Error while executing getFees(${paramString}) request . ${error}`);
        return undefined;
      }
    },
  };
};

/**
 * Returns network name in classic format
 * Keys in networksNameMap should be in upper case even if exchanger format in lower case
 * @param {string} network
 * @returns {string}
 */
function formatNetworkName(network) {
  const networksNameMap = {
    Bitcoin: _networks['BTC'].code,
    Ethereum: _networks['ERC20'].code,
    BinanceSmartChain: _networks['BEP20'].code,
    EthereumClassic: _networks['ETC'].code,
    EOS: _networks['EOS'].code,
    Tron: _networks['TRC20'].code,
    Solana: _networks['SOL'].code,
    Polkadot: _networks['DOT'].code,
    Polygon: _networks['MATIC'].code,
    Algorand: _networks['ALGO'].code,
    Stellar: _networks['XLM'].code,
    AvaxChain: _networks['AVAX-C-CHAIN'].code,
  };

  return networksNameMap[network] || network;
}

/**
 * Returns pair in BigONE format like 'BTC-USDT'
 * @param pair Pair in any format
 * @returns {Object|boolean} pairReadable, pairPlain, coin1, coin2
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
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: pair,
  };
}
