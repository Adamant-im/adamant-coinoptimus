const axios = require('axios');
const crypto = require('crypto');

const {
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://tapbit.com/openapi-docs/spot
 */

// Error codes: https://www.tapbit.com/openapi-docs/spot/spot_errorcode/
const httpErrorCodeDescriptions = {
  4: { // 4XX
    description: 'Wrong request content, behavior, format',
  },
  429: {
    description: 'Warning access frequency exceeding the limit',
    isTemporary: true,
  },
  5: { // 5XX
    description: 'Problems on the Tapbit service side',
    isTemporary: true,
  },
  504: {
    description: 'API server has submitted a request to the business core but failed to get a response',
  },
};

/**
 * Error codes:
 * isTemporary means that we consider the request is temporary failed and we'll repeat it later with success possibility
 */
const errorCodeDescriptions = {
  // Our experience
  10008: {
    description: 'Request timestamp expired',
    isTemporary: true,
  },
  10010: {
    description: 'API authentication failed',
    isTemporary: true,
  },
  10012: {
    description: 'Invalid authorization',
    isTemporary: true,
  },
  // Provided by Tapbit
  11000: {
    description: 'Parameter value is empty',
  },
  11001: {
    description: 'Invalid Parameter value',
  },
  11002: {
    description: 'The parameter value exceeds the maximum limit',
  },
  11003: {
    description: 'Third-party interface does not return data temporarily',
    isTemporary: true,
  },
  11004: {
    description: 'Invalid price precision',
  },
  11005: {
    description: 'Invalid quantity precision',
  },
  11006: {
    description: 'Unknow Exception',
  },
  11007: {
    description: 'coin pair does not match assets',
  },
  11008: {
    description: 'User ID not obtained',
  },
  11009: {
    description: 'User\'s Site value was not obtained',
  },
  11010: {
    description: 'The Bank value to which the user belongs was not obtained',
  },
  11011: {
    description: 'The asset operation is not supported temporarily',
    isTemporary: true,
  },
  11012: {
    description: 'This user operation is not supported temporarily',
    isTemporary: true,
  },
  11013: {
    description: 'Only limit order types are supported',
  },
  11014: {
    description: 'Order does not exist',
  },
  // On 429, TapBit returns 200 and '429' as internal error code. Example: '200 OK, [429] Too Many Requests'.
  // Here we consider only 429 and 504 codes, skipping 4XX and 5XX masks.
  ...httpErrorCodeDescriptions,
};

module.exports = function() {
  let WEB_BASE = 'https://openapi.tapbit.com/spot';
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

    const tapbitErrorInfo = errorCodeDescriptions[data?.code];
    const httpCodeInfo = httpErrorCodeDescriptions[httpCode] ?? httpErrorCodeDescriptions[httpCode?.toString()[0]];

    const success = httpCode === 200 && data?.code === 200;

    const error = {
      code: data?.code ?? 'No error code',
      message: data?.message ?? tapbitErrorInfo?.description ?? 'No error message',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data.data);
      } else {
        const tapbitErrorInfoString = `[${error.code}] ${error.message || 'No error message'}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${tapbitErrorInfoString}` : String(responseOrError);

        if (typeof data === 'object') {
          data.tapbitErrorInfo = tapbitErrorInfoString;
        }

        if (httpCode && !httpCodeInfo?.isTemporary && !tapbitErrorInfo?.isTemporary) {
          log.log(`Tapbit processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);

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
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    const bodyString = getParamsString(data);
    const formattedBodyString = type === 'get' && bodyString.length ? `?${bodyString}` : '';
    const stringifiedData = JSON.stringify(data);

    const timestamp = Date.now() / 1000;

    const signPayload = `${timestamp}${type.toUpperCase()}${path}${formattedBodyString}${type === 'post' ? stringifiedData : ''}`;
    const sign = getSignature(config.secret_key, signPayload);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'ACCESS-KEY': config.apiKey,
          'ACCESS-SIGN': sign,
          'ACCESS-TIMESTAMP': timestamp,
        },
        data: type === 'post' ? data : undefined,
        params: type === 'get' ? data : undefined,
        paramsSerializer: getParamsString,
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
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, queryString, url))
          .catch((error) => handleResponse(error, resolve, reject, queryString, url));
    });
  }

  /**
   * Get a signature for a Tapbit request
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
     * Spot Account Information
     * https://www.tapbit.com/openapi-docs/spot/private/account_info
     * @return {Promise<[]>}
     */
    getBalances() {
      return protectedRequest('get', '/api/v1/spot/account/list', {});
    },

    /**
     * Get open order list
     * https://www.tapbit.com/openapi-docs/spot/private/open_order_list/
     * @param {String} symbol In Tapbit format as BTC/USDT
     * @param {String} [nextOrderId] Order ID, which is used in pagination. The default value is empty. The latest 20 pieces of data are returned and displayed in reverse order by order ID. Get the last order Id-1, take the next page of data.
     * @return {Promise<[]>}
     */
    getOrders(symbol, nextOrderId) {
      const params = {
        instrument_id: symbol,
        next_order_id: nextOrderId,
      };

      return protectedRequest('get', '/api/v1/spot/open_order_list', params);
    },

    /**
     * Get specified order information
     * https://www.tapbit.com/openapi-docs/spot/private/order_info/
     * @param {String} orderId Example: '2257824251095171072'
     * @returns {Promise<Object>}
     */
    getOrder(orderId) {
      const params = {
        order_id: orderId,
      };

      return protectedRequest('get', '/api/v1/spot/order_info', params);
    },

    /**
     * Place Order
     * https://www.tapbit.com/openapi-docs/spot/private/order/
     * @param {String} symbol In Tapbit format as BTC/USDT
     * @param {String} amount Base coin amount
     * @param {String} price Order price
     * @param {String} side buy or sell
     * @return {Promise<Object>}
     */
    addOrder(symbol, amount, price, side) {
      const data = {
        instrument_id: symbol,
        direction: side === 'buy' ? 1 : 2,
        price,
        quantity: amount,
      };

      return protectedRequest('post', '/api/v1/spot/order', data);
    },

    /**
     * Cancel specified order
     * https://www.tapbit.com/openapi-docs/spot/private/cancel_order/
     * @param {String} orderId Example: '2257616624297820160'
     * @return {Promise<Object>}
     */
    cancelOrder(orderId) {
      const data = {
        order_id: orderId,
      };

      return protectedRequest('post', '/api/v1/spot/cancel_order', data);
    },

    /**
     * Batch cancel orders
     * https://www.tapbit.com/openapi-docs/spot/private/batch_cancel_order
     * @param {[]} orderIds
     * @return {Promise<[]>}
     */
    cancelAllOrders(orderIds) {
      const data = {
        orderIds,
      };

      return protectedRequest('post', '/api/v1/spot/batch_cancel_order', data);
    },

    /**
     * Get the specified ticker information
     * https://www.tapbit.com/openapi-docs/spot/public/ticker/
     * @param {String} symbol In Tapbit format as BTC/USDT
     * @return {Promise<Object>}
     */
    ticker(symbol) {
      const params = {
        instrument_id: symbol,
      };

      return publicRequest('get', '/api/spot/instruments/ticker_one', params);
    },

    /**
     * Get spot specified instrument information
     * https://www.tapbit.com/openapi-docs/spot/public/depth/
     * @param {String} symbol In Tapbit format as BTC/USDT
     * @param {Number} [limit=100] 5, 10, 50 or 100
     * @return {Promise<Object>}
     */
    orderBook(symbol, limit = 100) {
      const params = {
        instrument_id: symbol,
        depth: limit,
      };

      return publicRequest('get', '/api/spot/instruments/depth', params);
    },

    /**
     * Get the latest trade list information
     * https://www.tapbit.com/openapi-docs/spot/public/latest_trade_list/
     * @param {String} symbol In Tapbit format as BTC/USDT
     * @return {Promise<[]>}
     */
    getTradesHistory(symbol) {
      const params = {
        instrument_id: symbol,
      };

      return publicRequest('get', '/api/spot/instruments/trade_list', params);
    },

    /**
     * Get spot instruments informations
     * https://www.tapbit.com/openapi-docs/spot/public/trade_pair_list/
     * @return {Promise<[]>}
    */
    markets() {
      return publicRequest('get', '/api/spot/instruments/trade_pair_list', {});
    },

    /**
     * This endpoint returns a list of currency details
     * https://www.tapbit.com/openapi-docs/spot/public/asset_list/
     * @return {Promise<[]>}
    */
    currencies() {
      return publicRequest('get', '/api/spot/instruments/asset/list', {});
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
