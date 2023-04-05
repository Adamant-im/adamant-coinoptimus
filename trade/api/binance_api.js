const crypto = require('crypto');
const axios = require('axios');
const utils = require('../../helpers/utils');

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
    'apiKey': '',
    'secret_key': '',
    'tradePwd': '',
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
  const handleResponse = (responseOrError, resolve, reject, bodyString, queryString, url) => {
    const httpCode = responseOrError?.status || responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText || responseOrError?.response?.statusText;

    const binanceData = responseOrError?.data || responseOrError?.response?.data;

    const binanceStatus = httpCode === 200 && !binanceData?.code ? true : false; // Binance doesn't return any special status on success
    const binanceErrorCode = binanceData?.code || 'No error code';
    const binanceErrorMessage = binanceData?.msg || 'No error message';

    const binanceErrorInfo = `[${binanceErrorCode}] ${utils.trimAny(binanceErrorMessage, ' .')}`;

    const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${binanceErrorInfo}` : String(responseOrError);
    const reqParameters = queryString || bodyString || '{ No parameters }';

    try {
      if (binanceStatus) {
        resolve(binanceData);
      } else if (binanceErrorCode <= -1100 && binanceErrorCode >= -2013) {
        binanceData.binanceErrorInfo = binanceErrorInfo;
        log.log(`Binance processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);
        resolve(binanceData);
      } else if (binanceData && httpCode >= 400 && httpCode <= 409) {
        binanceData.binanceErrorInfo = binanceErrorInfo;
        log.log(`Binance processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Unexpected error code: ${binanceErrorCode}. Resolving…`);
        resolve(binanceData);
      } else if (httpCode === 429) {
        log.warn(`Request to ${url} with data ${reqParameters} failed. Rate limit exceeded, details: ${errorMessage}. Rejecting…`);
        reject(errorMessage);
      } else if (httpCode === 418) {
        log.warn(`Request to ${url} with data ${reqParameters} failed. IP has been blocked because of rate limit exceeded, details: ${errorMessage}. Rejecting…`);
        reject(errorMessage);
      } else if (httpCode >= 500) {
        log.warn(`Request to ${url} with data ${reqParameters} failed. Server error, details: ${errorMessage}. Rejecting…`);
        reject(errorMessage);
      } else {
        log.warn(`Request to ${url} with data ${reqParameters} failed. Unknown error: ${errorMessage}. Rejecting…`);
        reject(errorMessage);
      }
    } catch (e) {
      log.warn(`Error while processing response of request to ${url} with data ${reqParameters}: ${e}. Data object I've got: ${JSON.stringify(binanceData)}.`);
      reject(`Unable to process data: ${JSON.stringify(binanceData)}. ${e}`);
    }
  };

  /**
   * Creates an url params string as: key1=value1&key2=value2
   * @param {Object} data Request params
   * @returns {String}
   */
  function getParamsString(data) {
    const params = [];

    for (const key in data) {
      const v = data[key];
      params.push(key + '=' + v);
    }

    return params.join('&');
  }

  /**
   * Creates a full url with params as https://data.azbit.com/api/endpoint?key1=value1&key2=value2
   * @param {Object} data Request params
   * @returns {String}
   */
  function getUrlWithParams(url, data) {
    const queryString = getParamsString(data);

    if (queryString) {
      url = url + '?' + queryString;
    }

    return url;
  }

  /**
   * Makes a request to public endpoint
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function publicRequest(path, data, type = 'get') {
    let url = `${WEB_BASE}${path}`;
    const urlBase = url;

    const queryString = getParamsString(data);
    url = getUrlWithParams(url, data);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url: url,
        method: type,
        timeout: 10000,
      };
      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, undefined, queryString, urlBase))
          .catch((error) => handleResponse(error, resolve, reject, undefined, queryString, urlBase));
    });
  }

  /**
   * Makes a request to private (auth) endpoint
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @param {String} method Request type: get, post, delete
   * @returns {*}
   */
  function protectedRequest(path, data, type) {
    let url = `${WEB_BASE}${path}`;
    const urlBase = url;

    data.timestamp = Date.now();
    data.signature = getSignature(config.secret_key, getParamsString(data));

    const bodyString = getParamsString(data);

    if (type !== 'post') {
      url = getUrlWithParams(url, data);
    }

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url: url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-MBX-APIKEY': config.apiKey,
        },
        data: type === 'get' || type === 'delete' ? undefined : bodyString,
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, undefined, urlBase))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, undefined, urlBase));
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
    setConfig: function(apiServer, apiKey, secretKey, tradePwd, logger, publicOnly = false) {
      if (apiServer) {
        WEB_BASE = apiServer;
      }

      if (logger) {
        log = logger;
      }

      if (!publicOnly) {
        config = {
          'apiKey': apiKey,
          'secret_key': secretKey,
          'tradePwd': tradePwd,
        };
      }
    },

    /**
     * Get account information
     * https://binance-docs.github.io/apidocs/spot/en/#account-information-user_data
     * @returns {Object} { balances[], permissions[], accountType, canTrade, canWithdraw, canDeposit, brokered, requireSelfTradePrevention, updateTime,
     *   makerCommission, takerCommission, buyerCommission, sellerCommission, commissionRates{} }
     */
    getBalances: function() {
      return protectedRequest('/api/v3/account', {}, 'get');
    },

    /**
     * Query account active orders
     * https://binance-docs.github.io/apidocs/spot/en/#current-open-orders-user_data
     * @param {String} symbol In Binance format as ETHUSDT. Optional. Warn: request weight is 40 when the symbol is omitted.
     * @return {Object}
     */
    getOrders: function(symbol) {
      const data = {};

      if (symbol) {
        data.symbol = symbol;
      }

      return protectedRequest('/api/v3/openOrders', data, 'get');
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
    addOrder: function(symbol, amount, quoteAmount, price, side, type) {
      const data = {
        symbol,
        side: side.toUpperCase(),
        type: type.toUpperCase(),
      };

      if (type === 'limit') {
        data.price = price;
        data.quantity = amount;
        data.timeInForce = 'GTC';
      } else {
        if (amount) {
          data.quantity = amount;
        } else {
          data.quoteOrderQty = quoteAmount;
        }
      }

      return protectedRequest('/api/v3/order', data, 'post');
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
    getOrder: function(orderId, symbol) {
      const data = {
        orderId: +orderId,
        symbol,
      };

      return protectedRequest('/api/v3/order', data, 'get');
    },

    /**
     * Cancel an order
     * https://binance-docs.github.io/apidocs/spot/en/#cancel-order-trade
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} orderId Example: '3065308830'
     * @returns {Object} { "status": "CANCELED", ... }
     */
    cancelOrder: function(orderId, symbol) {
      return protectedRequest(`/api/v3/order`, {
        orderId: +orderId,
        symbol,
      }, 'delete');
    },

    /**
     * Cancel all orders
     * https://binance-docs.github.io/apidocs/spot/en/#cancel-all-open-orders-on-a-symbol-trade
     * @param {String} symbol In Binance format as ETHUSDT
     * @returns {Object} [{ "status": "CANCELED", ... }]
     */
    cancelAllOrders: function(symbol) {
      return protectedRequest('/api/v3/openOrders', { symbol }, 'delete');
    },

    /**
     * Get trade details for a ticker (market rates)
     * https://binance-docs.github.io/apidocs/spot/en/#24hr-ticker-price-change-statistics
     * @param {String} symbol In Binance format as ETHUSDT. Optional. Warn: request weight is 40 when the symbol is omitted.
     * @returns {Object}
     */
    ticker: function(symbol) {
      const data = {};

      if (symbol) {
        data.symbol = symbol;
      }

      return publicRequest('/api/v3/ticker/24hr', data, 'get');
    },

    /**
     * Get market depth
     * https://binance-docs.github.io/apidocs/spot/en/#order-book
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} limit Default 100; max 5000. If limit > 5000, then the response will truncate to 5000. With limit 1-100, request weight is 1.
     * @returns {Object}
     */
    orderBook: function(symbol, limit = 100) {
      return publicRequest(`/api/v3/depth`, {
        symbol,
        limit,
      }, 'get');
    },

    /**
     * Get trades history
     * https://binance-docs.github.io/apidocs/spot/en/#recent-trades-list
     * @param {String} symbol In Binance format as ETHUSDT
     * @param {Number} limit Default 500, max is 1000
     * @returns {Object} Last trades
     */
    getTradesHistory: function(symbol, limit = 500) {
      return publicRequest(`/api/v3/trades`, {
        limit,
        symbol,
      }, 'get');
    },

    /**
     * Get info on all markets
     * Optional params: symbol, symbols, permissions
     * https://binance-docs.github.io/apidocs/spot/en/#exchange-information
     * @returns {Object} { symbols[], timezone, serverTime, rateLimits[], exchangeFilters[] }
    */
    markets: function() {
      return publicRequest('/api/v3/exchangeInfo', {}, 'get');
    },

    /**
     * Fetch deposit address with network
     * https://binance-docs.github.io/apidocs/spot/en/#deposit-address-supporting-network-user_data
     * @param {String} coin As BTC
     * @param {String | undefined} network If network is not send, return with default network of the coin
     * @returns {Object}
     */
    getDepositAddress: function(coin, network) {
      const data = {
        coin,
      };

      if (network) {
        data.network = network;
      }

      return protectedRequest('/sapi/v1/capital/deposit/address', data, 'get');
    },

    /**
     * Get information of coins (available for deposit and withdraw) for user
     * https://binance-docs.github.io/apidocs/spot/en/#all-coins-39-information-user_data
     * @returns {Promise<Array>}
     */
    getCurrencies() {
      return protectedRequest('/sapi/v1/capital/config/getall', {}, 'get');
    },

    /**
     * Get fees for trading pairs
     * https://binance-docs.github.io/apidocs/spot/en/#trade-fee-user_data
     * @param symbol In Binance format as ETHUSDT. Optional.
     * @returns {Promise<Object>}
     */
    getFees(symbol) {
      const data = {};

      if (symbol) {
        data.symbol = symbol;
      }

      return protectedRequest(`/sapi/v1/asset/tradeFee`, data, 'get');
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
