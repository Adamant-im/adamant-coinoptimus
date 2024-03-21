const axios = require('axios');
const crypto = require('crypto');
const {
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://github.com/BiconomyOfficial/apidocs
 */

/**
 * Error codes: https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#rest-api
 * isTemporary means that we consider the request is temporary failed and we'll repeat it later with success possibility
 */
const errorCodeDescriptions = {
  0: {
    description: 'Success',
  },
  1: {
    description: 'Invalid parameter',
  },
  2: {
    description: 'Internal error',
    isTemporary: true,
  },
  3: {
    description: 'Service unavailable',
    isTemporary: true,
  },
  4: {
    description: 'Method Not Found',
  },
  5: {
    description: 'Service timeout',
    isTemporary: true,
  },
  10: {
    description: 'Insufficient amount',
  },
  11: {
    description: 'Number of transactions is too small',
  },
  12: {
    description: 'Insufficient depth',
  },
  10005: {
    description: 'Record Not Found',
  },
  10022: {
    description: 'Failed real-name authentication',
  },
  10051: {
    description: 'User forbids trading',
  },
  10056: {
    description: 'Less than minimum amount',
  },
  10059: {
    description: 'The asset has not been opened for trading yet',
  },
  10060: {
    description: 'This trading pair has not yet opened trading',
  },
  10062: {
    description: 'Inaccurate amount accuracy',
  },
};

// No error code descriptions from Biconomy
const httpErrorCodeDescriptions = {
  4: { // 4XX
    description: 'Wrong request content, behavior, format',
    isTemporary: false,
  },
  429: {
    description: 'Warning access frequency exceeding the limit',
    isTemporary: true,
  },
  5: { // 5XX
    description: 'Problems on the Biconomy service side',
    isTemporary: true,
  },
  504: {
    description: 'API server has submitted a request to the business core but failed to get a response',
    isTemporary: false,
  },
};

module.exports = function() {
  let WEB_BASE = 'https://market.biconomy.vip/api';
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
   * @param {String} queryString
   * @param {String} url
   */
  const handleResponse = (responseOrError, resolve, reject, queryString, url) => {
    const httpCode = responseOrError?.status ?? responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText ?? responseOrError?.response?.statusText;

    const data = responseOrError?.data ?? responseOrError?.response?.data;
    const success = httpCode === 200 && !data.code;

    const biconomyError = errorCodeDescriptions[data?.code];
    const error = {
      code: data?.code ?? 'No error code',
      message: data?.message ?? biconomyError?.description ?? 'No error message',
    };

    const httpCodeInfo = httpErrorCodeDescriptions[httpCode] ?? httpErrorCodeDescriptions[httpCode?.toString()[0]];

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const biconomyErrorInfo = `[${error.code}] ${error.message || 'No error message'}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${biconomyErrorInfo}` : String(responseOrError);

        if (typeof data === 'object') {
          data.biconomyErrorInfo = biconomyErrorInfo;
        }

        if (httpCode && !httpCodeInfo?.isTemporary && !biconomyError?.isTemporary) {
          log.log(`Biconomy processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);

          resolve(data);
        } else {
          log.warn(`Request to ${url} with data ${reqParameters} failed. Details: ${errorMessage}. Rejecting…`);

          reject(errorMessage);
        }
      }
    } catch (error) {
      log.warn(`Error while processing response of request to ${url} with data ${reqParameters}: ${error}. Data object I've got: ${JSON.stringify(data)}.`);
      reject(`Unable to process data: ${JSON.stringify(data)}. ${error}`);
    }
  };

  /**
   * Makes a request to private (auth) endpoint
   * @param {String} type Request type: get, post,
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    const bodyString = getParamsString(data);

    data.api_key = config.apiKey;

    const sortedData = Object.keys(data)
        .sort()
        .reduce((accumulator, key) => {
          accumulator[key] = data[key];
          return accumulator;
        }, {});

    sortedData.secret_key = config.secret_key;

    const sortedDataString = getParamsString(sortedData);

    const hash = getHash(sortedDataString).toUpperCase();

    const params = { ...data, api_key: config.apiKey, sign: hash };
    const sortedParams = Object.keys(params)
        .sort()
        .reduce((accumulator, key) => {
          accumulator[key] = params[key];
          return accumulator;
        }, {});
    const sortedParamsString = getParamsString(sortedParams);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-SITE-ID': 127,
        },
        data: sortedParamsString,
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, url))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, url));
    });
  }

  /**
   * Makes a request to public endpoint
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} params Request params
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
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-SITE-ID': 127,
        },
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, queryString, url))
          .catch((error) => handleResponse(error, resolve, reject, queryString, url));
    });
  }

  /**
   * Get a hash for a Biconomy request
   * @param {String} payload Data to hash
   * @returns {String}
   */
  function getHash(payload) {
    return crypto
        .createHash('md5')
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
     * Get User Assets
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#get-user-assets
     * @return {Promise<{}>}
     */
    getBalances() {
      return protectedRequest('post', '/v1/private/user', {});
    },

    /**
     * Query Unfilled Orders
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#Query-unfilled-orders
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} [limit=100] Max: 100
     * @param {Number} [offset=0]
     * @return {Promise<[]>}
     */
    getOrders(symbol, limit = 100, offset = 0) {
      const params = {
        market: symbol,
        limit,
        offset,
      };

      return protectedRequest('post', '/v1/private/order/pending', params);
    },

    /**
     * Query Details Of An Unfilled Order
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#query-details-of-an-unfilled-order
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} orderId Example: 32868
     * @returns {Promise<Object>}
     */
    getPendingOrder(symbol, orderId) {
      const data = {
        market: symbol,
        order_id: orderId,
      };

      return protectedRequest('post', '/v1/private/order/pending/detail', data);
    },

    /**
     * Query Details of a Completed Order
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#query-details-of-an-unfilled-order-1
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} orderId Example: 32868
     * @returns {Promise<Object>}
     */
    getFinishedOrder(symbol, orderId) {
      const data = {
        market: symbol,
        order_id: orderId,
      };

      return protectedRequest('post', '/v1/private/order/finished/detail', data);
    },

    /**
     * Limit Trading / Market Trading
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#Limit-Trading
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#market-trading
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {String} amount Base coin amount
     * @param {String} price Order price
     * @param {String} side buy or sell
     * @param {String} type market or limit
     * @return {Promise<Object>}
     */
    addOrder(symbol, amount, price, side, type) {
      const sideMap = {
        sell: 1,
        buy: 2,
      };

      const data = {
        market: symbol,
        side: sideMap[side],
        amount,
      };

      if (type === 'limit') {
        data.price = price;

        return protectedRequest('post', '/v1/private/trade/limit', data);
      } else {
        return protectedRequest('post', '/v1/private/trade/market', data);
      }
    },

    /**
     * Cancel an Order
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#Cancel-an-Order
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} orderId Example: 32868
     * @return {Promise<Object>}
     */
    cancelOrder(symbol, orderId) {
      const data = {
        market: symbol,
        order_id: orderId,
      };

      return protectedRequest('post', '/v1/private/trade/cancel', data);
    },

    /**
     * Bulk Cancel Order
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#bulk-cancel-order
     * @param {Array<Object>} orders Order to cancel
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @return {Promise<Object>}
     */
    cancelAllOrders(orders, symbol) {
      const orders_json = orders.map((order) => {
        return { market: symbol, order_id: +order.orderId };
      });

      const data = {
        orders_json: JSON.stringify(orders_json),
      };

      return protectedRequest('post', '/v1/private/trade/cancel_batch', data);
    },

    /**
     * Get Exchange Market Data
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#Get-Exchange-Market-Data
     * @return {Promise<Object>}
     */
    ticker() {
      return publicRequest('get', '/v1/tickers', {});
    },

    /**
     * Get Depth Information
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#get-depth-information
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} [limit=100] Min: 1, Max: 100
     * @return {Promise<Object>}
     */
    orderBook(symbol, limit = 100) {
      const params = {
        symbol,
        size: limit,
      };

      return publicRequest('get', '/v1/depth', params);
    },

    /**
     * Get Recent Trades
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#get-recent-trades
     * @param {String} symbol In Biconomy format as BTC_USDT
     * @param {Number} [limit=100] Min: 1, Max: 100
     * @return {Promise<[]>}
     */
    getTradesHistory(symbol, limit = 100) {
      const params = {
        symbol,
        size: limit,
      };

      return publicRequest('get', '/v1/trades', params);
    },

    /**
     * Get Pair Info
     * https://github.com/BiconomyOfficial/apidocs?tab=readme-ov-file#Get-Pair-Info
     * @return {Promise<[]>}
    */
    markets() {
      return publicRequest('get', '/v1/exchangeInfo', {});
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
