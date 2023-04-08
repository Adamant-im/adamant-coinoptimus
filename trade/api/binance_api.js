const crypto = require('crypto');
const axios = require('axios');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://binance-docs.github.io/apidocs/spot/en/#introduction
 * Swagger: https://binance.github.io/binance-api-swagger/
 */

/**
 * HTTP 4XX return codes are used for malformed requests; the issue is on the sender's side.
 * HTTP 403 return code is used when the WAF Limit (Web Application Firewall) has been violated.
 * HTTP 409 return code is used when a cancelReplace order partially succeeds. (e.g. if the cancellation of the order fails but the new order placement succeeds.)
 * HTTP 429 return code is used when breaking a request rate limit.
 * HTTP 418 return code is used when an IP has been auto-banned for continuing to send requests after receiving 429 codes.
 * HTTP 5XX return codes are used for internal errors; the issue is on Binance's side. It is important to NOT treat this as a failure operation; the execution status is UNKNOWN and could have been a success.
 * Error codes: https://binance-docs.github.io/apidocs/spot/en/#error-codes
 * -1000 UNKNOWN and less.
 */

module.exports = function() {
  let WEB_BASE = 'https://api.binance.com'; // Default, may be changed on init
  let config = {
    apiKey: '',
    secret_key: '',
    tradePwd: '',
  };
  let log = {};

  /**
   * Handles response from API
   * @param {Object} responseOrError
   * @param resolve
   * @param reject
   * @param {String} bodyString
   * @param {String} queryString
   * @param {String} url
   */
  const handleResponse = (responseOrError, resolve, reject, queryString, url) => {
    const httpCode = responseOrError?.status ?? responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText ?? responseOrError?.response?.statusText;

    const data = responseOrError?.data ?? responseOrError?.response?.data;
    const success = httpCode === 200 && !data?.code; // Binance doesn't return any special status code on success

    const error = {
      code: data?.code || 'No error code',
      message: data?.msg || 'No error message',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const binanceErrorInfo = `[${error.code}] ${trimAny(error.message, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${binanceErrorInfo}` : String(responseOrError);

        data.binanceErrorInfo = binanceErrorInfo;

        if (httpCode >= 400 && httpCode <= 409) {
          const unexpectedErrorCode = data && (error.code >= -1100 || error.code <= -2013) ?
            ` Unexpected error code: ${error.code}.` : '';

          log.log(`Binance processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}.${unexpectedErrorCode} Resolving…`);

          resolve(data);
        } else {
          const httpErrorCodeDescriptions = {
            429: 'Rate limit exceeded',
            418: 'IP has been blocked because of rate limit exceeded',
            500: 'Internal server error',
          };

          const errorDescription = httpErrorCodeDescriptions[httpCode] ?? 'Unknown error';

          log.warn(`Request to ${url} with data ${reqParameters} failed. ${errorDescription}, details: ${errorMessage}. Rejecting…`);

          reject(errorMessage);
        }
      }
    } catch (error) {
      log.warn(`Error while processing response of request to ${url} with data ${reqParameters}: ${error}. Data object I've got: ${JSON.stringify(data)}.`);
      reject(`Unable to process data: ${JSON.stringify(data)}. ${error}`);
    }
  };

  /**
   * Makes a request to public endpoint
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function publicRequest(type, path, params) {
    const url = `${WEB_BASE}${path}`;

    const queryString = getParamsString(params);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        params,
        method: type,
        timeout: 10000,
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, queryString, url))
          .catch((error) => handleResponse(error, resolve, reject, queryString, url));
    });
  }

  /**
   * Makes a request to private (auth) endpoint
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @param {String} method Request type: get, post, delete
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    data.timestamp = Date.now();
    data.signature = getSignature(config.secret_key, getParamsString(data));

    const bodyString = getParamsString(data);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'X-MBX-APIKEY': config.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      };

      if (type === 'post') {
        httpOptions.data = bodyString;
      } else {
        httpOptions.params = data;
      }

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, url))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, url));
    });
  }

  /**
   * Get a signature for a Binance request
   * @param {String} secret API secret key
   * @param {String} payload Data to sign
   * @returns {String}
   */
  function getSignature(secret, payload) {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
  }

  const EXCHANGE_API = {
    setConfig(apiServer, apiKey, secretKey, tradePwd, logger, publicOnly = false) {
      if (apiServer) {
        WEB_BASE = apiServer;
      }

      if (logger) {
        log = logger;
      }

      if (!publicOnly) {
        config = {
          apiKey,
          tradePwd,
          secret_key: secretKey,
        };
      }
    },

    /**
     * Get account information
     * https://binance-docs.github.io/apidocs/spot/en/#account-information-user_data
     * @returns {Object} { balances[], permissions[], accountType, canTrade, canWithdraw, canDeposit, brokered, requireSelfTradePrevention, updateTime,
     *   makerCommission, takerCommission, buyerCommission, sellerCommission, commissionRates{} }
     */
    getBalances() {
      return protectedRequest('get', '/api/v3/account', {});
    },

    /**
     * Query account active orders
     * https://binance-docs.github.io/apidocs/spot/en/#current-open-orders-user_data
     * @param {String} symbol In Binance format as ETHUSDT. Optional. Warn: request weight is 40 when the symbol is omitted.
     * @return {Object}
     */
    getOrders(symbol) {
      return protectedRequest('get', '/api/v3/openOrders', { symbol });
    },

    /**
     * Places an order
     * https://binance-docs.github.io/apidocs/spot/en/#new-order-trade
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {String} amount Base coin amount
     * @param {String} quoteAmount Quote coin amount
     * @param {String} price Order price
     * @param {String} side BUY or SELL
     * @param {String} type MARKET or LIMIT (yet more additional types)
     * MARKET orders using the quantity field specifies the amount of the base asset the user wants to buy or sell
     * at the market price. E.g. MARKET order on BTCUSDT will specify how much BTC the user is buying or selling.
     * MARKET orders using quoteOrderQty specifies the amount the user wants to spend (when buying) or receive (when selling)
     * the quote asset; the correct quantity will be determined based on the market liquidity and quoteOrderQty.
     * E.g. Using the symbol BTCUSDT:
     * BUY side, the order will buy as many BTC as quoteOrderQty USDT can.
     * SELL side, the order will sell as much BTC needed to receive quoteOrderQty USDT.
     * @returns {Object}
     */
    addOrder(symbol, amount, quoteAmount, price, side, type) {
      const data = {
        symbol,
        side: side.toUpperCase(),
        type: type.toUpperCase(),
      };

      if (type === 'limit') {
        data.price = price;
        data.quantity = amount;
        data.timeInForce = 'GTC';
      } else if (amount) {
        data.quantity = amount;
      } else {
        data.quoteOrderQty = quoteAmount;
      }

      return protectedRequest('post', '/api/v3/order', data);
    },

    /**
     * Get order status
     * https://binance-docs.github.io/apidocs/spot/en/#query-order-user_data
     * @param {String} orderId Example: '3065308830'
     * @param {String} symbol In Binance format as ETHUSDT
     * @returns {Object} 200, { orderId, status, ... }
     * Order doesn't exist: 400, { code: -2013, msg: 'Order does not exist.' }
     * Wrong orderId (not a Number): 400, { code: -1100, msg: 'Illegal characters found in parameter 'orderId'; legal range is '^[0-9]{1,20}$'.' }
     * No deals: { orderId, status: 'NEW', ... }
     * Cancelled order: { orderId, status: 'CANCELED', ... }
     */
    getOrder(orderId, symbol) {
      return protectedRequest('get', '/api/v3/order', {
        symbol,
        orderId: +orderId,
      });
    },

    /**
     * Cancel an order
     * https://binance-docs.github.io/apidocs/spot/en/#cancel-order-trade
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} orderId Example: '3065308830'
     * @returns {Object} { "status": "CANCELED", ... }
     */
    cancelOrder(orderId, symbol) {
      return protectedRequest('delete', '/api/v3/order', {
        symbol,
        orderId: +orderId,
      });
    },

    /**
     * Cancel all orders
     * https://binance-docs.github.io/apidocs/spot/en/#cancel-all-open-orders-on-a-symbol-trade
     * @param {String} symbol In Binance format as ETHUSDT
     * @returns {Object} [{ "status": "CANCELED", ... }]
     */
    cancelAllOrders(symbol) {
      return protectedRequest('delete', '/api/v3/openOrders', { symbol });
    },

    /**
     * Get trade details for a ticker (market rates)
     * https://binance-docs.github.io/apidocs/spot/en/#24hr-ticker-price-change-statistics
     * @param {String} symbol In Binance format as ETHUSDT. Optional. Warn: request weight is 40 when the symbol is omitted.
     * @returns {Object}
     */
    ticker(symbol) {
      return publicRequest('get', '/api/v3/ticker/24hr', { symbol });
    },

    /**
     * Get market depth
     * https://binance-docs.github.io/apidocs/spot/en/#order-book
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} limit Default 100; max 5000. If limit > 5000, then the response will truncate to 5000. With limit 1-100, request weight is 1.
     * @returns {Object}
     */
    orderBook(symbol, limit = 100) {
      return publicRequest('get', '/api/v3/depth', {
        symbol,
        limit,
      });
    },

    /**
     * Get trades history
     * https://binance-docs.github.io/apidocs/spot/en/#recent-trades-list
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} limit Default 500, max is 1000
     * @returns {Object} Last trades
     */
    getTradesHistory(symbol, limit = 500) {
      return publicRequest('get', '/api/v3/trades', {
        symbol,
        limit,
      });
    },

    /**
     * Get info on all markets
     * Optional params: symbol, symbols, permissions
     * https://binance-docs.github.io/apidocs/spot/en/#exchange-information
     * @returns {Object} { symbols[], timezone, serverTime, rateLimits[], exchangeFilters[] }
    */
    markets() {
      return publicRequest('get', '/api/v3/exchangeInfo', {});
    },

    /**
     * Fetch deposit address with network
     * https://binance-docs.github.io/apidocs/spot/en/#deposit-address-supporting-network-user_data
     * @param {String} coin As BTC
     * @param {String | undefined} network If network is not send, return with default network of the coin
     * @returns {Object}
     */
    getDepositAddress(coin, network) {
      return protectedRequest('get', '/sapi/v1/capital/deposit/address', {
        coin,
        network,
      });
    },

    /**
     * Get information of coins (available for deposit and withdraw) for user
     * https://binance-docs.github.io/apidocs/spot/en/#all-coins-39-information-user_data
     * @returns {Promise<Array>}
     */
    getCurrencies() {
      return protectedRequest('get', '/sapi/v1/capital/config/getall', {});
    },

    /**
     * Get fees for trading pairs
     * https://binance-docs.github.io/apidocs/spot/en/#trade-fee-user_data
     * @param symbol In Binance format as ETHUSDT. Optional.
     * @returns {Promise<Object>}
     */
    getFees(symbol) {
      return protectedRequest('get', '/sapi/v1/asset/tradeFee', { symbol });
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
