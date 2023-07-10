const crypto = require('crypto');
const axios = require('axios');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://bittrex.github.io/api/v3
 */

// Error codes: https://bittrex.github.io/api/v3#topic-Error-Codes
const httpErrorCodeDescriptions = {
  400: 'The request was malformed, often due to a missing or invalid parameter',
  401: 'The request failed to authenticate',
  403: 'The provided api key is not authorized to perform the requested operation',
  404: 'The requested resource does not exist',
  409: 'The request parameters were valid but the request failed due to an operational error',
  429: 'Too many requests hit the API too quickly',
  501: 'The service requested has not yet been implemented',
  503: 'The request parameters were valid but the request failed because the resource is temporarily unavailable',
};

module.exports = function() {
  let WEB_BASE = 'https://api.bittrex.com/v3';
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
    const success = httpCode === 200 || httpCode === 201 && !data?.code; // Bittrex doesn't return any special status code on success

    const error = {
      code: data?.code ?? data?.error?.code ?? 'No error code',
      detail: data?.error?.detail ?? 'No error detail',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const bittrexErrorInfo = `[${error.code}] ${trimAny(error.detail, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${bittrexErrorInfo}` : String(responseOrError);

        if (typeof data === 'object') {
          data.bittrexErrorInfo = bittrexErrorInfo;
        }

        if (httpCode === 400 || httpCode === 409 || httpCode === 404) {
          log.log(`Bittrex processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);

          resolve(data);
        } else {
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
   * Makes a request to private (auth) endpoint
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    const bodyString = getParamsString(data);
    const stringifiedData = JSON.stringify(data);

    const urlWithQuery = bodyString === '' ? url : `${url}?${bodyString}`;
    const timestamp = Date.now();

    const hashPayload = type === 'post' ? stringifiedData : '';
    const hash = getHash(hashPayload);

    const signPayload = type === 'post' ?
      [timestamp, url, type.toUpperCase(), hash].join('') :
      [timestamp, urlWithQuery, type.toUpperCase(), hash].join('');
    const sign = getSignature(config.secret_key, signPayload);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': config.apiKey,
          'Api-Timestamp': timestamp,
          'Api-Content-Hash': hash,
          'Api-Signature': sign,
        },
      };

      if (type === 'post') {
        httpOptions.data = stringifiedData;
      } else {
        httpOptions.params = data;
      }

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, url))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, url));
    });
  }

  /**
   * Makes a request to public endpoint
   * @param {String} type Request type: get, post, delete
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
   * Get a hash for a Bittrex request
   * @param {String} payload Data to hash
   * @returns {String}
   */
  function getHash(payload) {
    return crypto
        .createHash('sha512')
        .update(payload)
        .digest('hex');
  }

  /**
   * Get a signature for a Bittrex request
   * @param {String} secret API secret key
   * @param {String} payload Data to sign
   * @returns {String}
   */
  function getSignature(secret, payload) {
    return crypto
        .createHmac('sha512', secret)
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
     * List account balances across available currencies. Returns a Balance entry for each currency for which there is either a balance or an address
     * https://bittrex.github.io/api/v3#operation--balances-get
     * @return {Promise<Array>}
     */
    getBalances() {
      return protectedRequest('get', '/balances', {});
    },

    /**
     * List open orders
     * https://bittrex.github.io/api/v3#operation--orders-open-get
     * @param {String} symbol In Bittrex format as ETH-USDT
     * @return {Promise<Array>}
     */
    getOrders(symbol) {
      const params = {
        marketSymbol: symbol,
      };

      return protectedRequest('get', '/orders/open', params);
    },

    /**
     * Retrieve information on a specific order
     * https://bittrex.github.io/api/v3#operation--orders--orderId--get
     * Retrieve executions for a specific order. Results are sorted in inverse order of execution time, and are limited to the first 1000.
     * https://bittrex.github.io/api/v3#operation--orders--orderId--executions-get
     * @param {String} orderId Example: '7c99eb7f-1bfd-4c2a-a989-cf320e803396'
     * @returns {Promise<Object>}
     */
    async getOrder(orderId) {
      const order = await protectedRequest('get', `/orders/${orderId}`, {});
      const executions = await protectedRequest('get', `/orders/${orderId}/executions`, {});

      return { ...order, executions };
    },

    /**
     * Create a new order
     * https://bittrex.github.io/api/v3#operation--orders-post
     * @param {String} symbol In Bittrex format as ETH-USDT
     * @param {String} amount Base coin amount
     * @param {String} quote Quote coin amount
     * @param {String} price Order price
     * @param {String} side BUY or SELL
     * @param {String} type MARKET or LIMIT
     * @param {Boolean} useAwards Option to use Bittrex credits for the order
     * @return {Promise<Object>}
     */
    addOrder(symbol, amount, quote, price, side, type, useAwards) {
      const data = {
        marketSymbol: symbol,
        direction: side.toUpperCase(),
        timeInForce: type === 'limit' ? 'GOOD_TIL_CANCELLED' : 'IMMEDIATE_OR_CANCEL',
      };

      if (useAwards) data.useAwards = true;

      if (type === 'limit') {
        data.limit = price;
        data.type = type.toUpperCase();
        data.quantity = amount;
      } else {
        if (quote) {
          data.type = 'CEILING_MARKET';
          data.ceiling = quote;
        } else {
          data.type = 'MARKET';
          data.quantity = amount;
        }
      }

      return protectedRequest('post', '/orders', data);
    },

    /**
     * Cancel an order
     * https://bittrex.github.io/api/v3#operation--orders--orderId--delete
     * @param {String} orderId Example: '7c99eb7f-1bfd-4c2a-a989-cf320e803396'
     * @return {Promise<Object>}
     */
    cancelOrder(orderId) {
      return protectedRequest('delete', `/orders/${orderId}`, {});
    },

    /**
     * Bulk cancel all open orders limited for a specific market
     * https://bittrex.github.io/api/v3#operation--orders-open-delete
     * @param {String} symbol
     * @return {Promise<Array>}
     */
    cancelAllOrders(symbol) {
      const data = {
        marketSymbol: symbol,
      };

      return protectedRequest('delete', '/orders/open', data);
    },

    /**
     * Retrieve summary of the last 24 hours of activity and ticker for a specific market
     * Combine two requests
     * https://bittrex.github.io/api/v3#operation--markets--marketSymbol--ticker-get
     * https://bittrex.github.io/api/v3#operation--markets--marketSymbol--ticker-get
     * @param {String} symbol In Bittrex format as ETH-USDT
     * @return {Promise<Object>}
     */
    async ticker(symbol) {
      const marketTicker = await publicRequest('get', `/markets/${symbol}/ticker`, {});
      const marketSummary = await publicRequest('get', `/markets/${symbol}/summary`, {});

      const tickerInfo = { ...marketSummary, marketTicker };

      if (tickerInfo.bittrexErrorInfo) {
        throw tickerInfo.bittrexErrorInfo;
      } else {
        return tickerInfo;
      }
    },

    /**
     * Retrieve the order book for a specific market
     * https://bittrex.github.io/api/v3#operation--markets--marketSymbol--orderbook-get
     * @param {String} symbol In Bittrex format as ETH-USDT
     * @return {Promise<Object>}
     */
    orderBook(symbol) {
      const params = {
        depth: 500, // Maximum depth of order book to return (optional, allowed values are [1, 25, 500], default is 25)
      };

      return publicRequest('get', `/markets/${symbol}/orderbook`, params);
    },

    /**
     * Retrieve the recent trades for a specific market. Doesn't have limit parameter (limit is 100). 'limit', 'depth', 'count' doesn't work.
     * https://bittrex.github.io/api/v3#operation--markets--marketSymbol--trades-get
     * @param {String} symbol In Bittrex format as ETH-USDT
     * @return {Promise<Array>}
     */
    getTradesHistory(symbol) {
      return publicRequest('get', `/markets/${symbol}/trades`, {});
    },

    /**
     * List markets
     * https://bittrex.github.io/api/v3#tag-Markets
     * @return {Promise<Array>}
    */
    markets() {
      return publicRequest('get', '/markets', {});
    },

    /**
     * List currencies
     * https://bittrex.github.io/api/v3#tag-Currencies
     * @return {Promise<Array>}
    */
    currencies() {
      return publicRequest('get', '/currencies', {});
    },

    /**
     * List deposit addresses that have been requested or provisioned
     * https://bittrex.github.io/api/v3#operation--addresses-get
     * @param {String} coin As ETH
     * @return {Promise<Object>}
     */
    getDepositAddress(coin) {
      return protectedRequest('get', `/addresses/${coin}`, {});
    },

    /**
     * Request provisioning of a deposit address for a currency for which no address has been requested or provisioned
     * https://bittrex.github.io/api/v3#operation--addresses-post
     * @param {String} coin As ETH
     * @return {Promise<Object>}
     */
    createDepositAddress(coin) {
      const data = {
        currencySymbol: coin,
      };

      return protectedRequest('post', '/addresses', data);
    },

    /**
     * Get trading fees for account
     * @param {String} marketSymbol if not set, get info for all trade pairs
     * @return {Promise<Array|Object>}
     */
    getFees(marketSymbol) {
      return marketSymbol ?
          protectedRequest('get', `/account/fees/trading/${marketSymbol}`, {}) :
          protectedRequest('get', '/account/fees/trading', {});
    },

    /**
     * Get 30-days trading volume for account
     * https://bittrex.github.io/api/v3#operation--account-volume-get
     * @return {Promise<Object>}
     */
    getVolume() {
      return protectedRequest('get', '/account/volume', {});
    },

    /**
     * List closed deposits. StartDate and EndDate filters apply to the CompletedAt field.
     * Pagination and the sort order of the results are in inverse order of the CompletedAt field.
     * https://bittrex.github.io/api/v3#operation--deposits-closed-get
     * @param {String} coin As ETH
     * @param {Number} limit Default: 200. Min: 1. Max: 200.
     * @return {Promise<Array>}
     */
    getDepositHistory(coin, limit = 200) {
      const data = {
        // status: 'COMPLETED', // COMPLETED, ORPHANED, INVALIDATED (optional)
        pageSize: limit,
        currencySymbol: coin,
      };

      return protectedRequest('get', '/deposits/closed', data);
    },

  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
