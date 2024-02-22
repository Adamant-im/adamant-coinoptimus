const crypto = require('crypto');
const axios = require('axios');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://docs.digifinex.com/en-ww/spot/v3/rest.html
 */

/**
 * Error codes: https://docs.digifinex.com/en-ww/spot/v3/rest.html#error-codes
 * isTemporary means that we consider the request is temporary failed and we'll repeat it later with success possibility
 */

const errorCodeDescriptions = {
  10001: {
    description: 'Wrong request method, please check it\'s a GET or POST request',
  },
  10002: {
    description: 'Invalid ApiKey',
  },
  10003: {
    description: 'Sign doesn\'t match',
  },
  10004: {
    description: 'Illegal request parameters',
  },
  10005: {
    description: 'Request frequency exceeds the limit',
    isTemporary: true,
  },
  10006: {
    description: 'Unauthorized to execute this request',
  },
  10007: {
    description: 'IP address Unauthorized',
  },
  10008: {
    description: 'Timestamp for this request is invalid',
    isTemporary: true,
  },
  10009: {
    description: 'Unexist endpoint or misses ACCESS-KEY, please check endpoint URL',
  },
  10011: {
    description: 'ApiKey expired. Please go to client side to re-create an ApiKey.',
  },
  20002: {
    description: 'Trade of this trading pair is suspended',
  },
  20007: {
    description: 'Price precision error',
  },
  20008: {
    description: 'Amount precision error',
  },
  20009: {
    description: 'Amount is less than the minimum requirement',
  },
  20010: {
    description: 'Cash Amount is less than the minimum requirement',
  },
  20011: {
    description: 'Insufficient balance',
  },
  20012: {
    description: 'Invalid trade type (valid value: buy/sell)',
  },
  20013: {
    description: 'No order info found',
  },
  20014: {
    description: 'Invalid date (Valid format: 2018-07-25)',
  },
  20015: {
    description: 'Date exceeds the limit',
  },
  20018: {
    description: 'Your have been banned for API trading by the system',
    isTemporary: true,
  },
  20019: {
    description: 'Wrong trading pair symbol, correct format:"base_quote", e.g. "btc_usdt"',
  },
  20020: {
    description: 'You have violated the API trading rules and temporarily banned for trading. At present, we have certain restrictions on the user\'s transaction rate and withdrawal rate.',
    isTemporary: true,
  },
  20021: {
    description: 'Invalid currency',
  },
  20022: {
    description: 'The ending timestamp must be larger than the starting timestamp',
  },
  20023: {
    description: 'Invalid transfer type',
  },
  20024: {
    description: 'Invalid amount',
  },
  20025: {
    description: 'This currency is not transferable at the moment',
    isTemporary: true,
  },
  20026: {
    description: 'Transfer amount exceed your balance',
  },
  20027: {
    description: 'Abnormal account status',
  },
  20028: {
    description: 'Blacklist for transfer',
  },
  20029: {
    description: 'Transfer amount exceed your daily limit',
    isTemporary: true,
  },
  20030: {
    description: 'You have no position on this trading pair',
  },
  20032: {
    description: 'Withdrawal limited',
  },
  20033: {
    description: 'Wrong Withdrawal ID',
  },
  20034: {
    description: 'Withdrawal service of this crypto has been closed',
  },
  20035: {
    description: 'Withdrawal limit',
    isTemporary: true,
  },
  20036: {
    description: 'Withdrawal cancellation failed',
  },
  20037: {
    description: 'The withdrawal address, Tag or chain type is not included in the withdrawal management list',
  },
  20038: {
    description: 'The withdrawal address is not on the white list',
  },
  20039: {
    description: 'Can\'t be canceled in current status',
  },
  20040: {
    description: 'Withdraw too frequently; limitation: 3 times a minute, 100 times a day',
    isTemporary: true,
  },
  20041: {
    description: 'Beyond the daily withdrawal limit',
    isTemporary: true,
  },
  20042: {
    description: 'Current trading pair does not support API trading',
  },
  50000: {
    description: 'Exception error',
    isTemporary: true,
  },
};

module.exports = function() {
  let WEB_BASE = 'https://openapi.digifinex.com/v3'; // Default, may be changed on init
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
    const httpCode = responseOrError?.status || responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText ?? responseOrError?.response?.statusText;

    const data = responseOrError?.data || responseOrError?.response?.data;
    const success = data?.code === 0 || data?.code === 200;

    const digifinexError = errorCodeDescriptions[data?.code];
    const error = {
      code: data?.code ?? 'No error code',
      message: digifinexError?.description ?? data?.msg ?? 'No error message',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const digifinexErrorInfo = `[${error.code}] ${trimAny(error.message, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${digifinexErrorInfo}` : String(responseOrError);

        if (typeof data === 'object') {
          data.digifinexErrorInfo = digifinexErrorInfo;
        }

        if (httpCode === 200 && !digifinexError?.isTemporary) {
          log.log(`Digifinex processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);

          resolve(data);
        } else {
          const errorDescription = errorCodeDescriptions[error.code] ?? 'Unknown error';

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

    const queryString = getParamsString(data);

    const sign = getSignature(config.secret_key, queryString);

    const timestamp = Math.floor(Date.now() / 1000);

    return new Promise((resolve, reject) => {
      try {
        const httpOptions = {
          url,
          method: type,
          timeout: 10000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'ACCESS-KEY': config.apiKey,
            'ACCESS-SIGN': sign,
            'ACCESS-TIMESTAMP': timestamp,
          },
          data: type === 'get' ? undefined : queryString,
          params: type === 'get' ? data : undefined,
        };

        axios(httpOptions)
            .then((response) => handleResponse(response, resolve, reject, queryString, url))
            .catch((error) => handleResponse(error, resolve, reject, queryString, url));
      } catch (error) {
        log.log(`Processing of request to ${url} with data ${queryString} failed. ${error}.`);
        reject(null);
      }
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
      try {
        const httpOptions = {
          url,
          params,
          method: type,
          timeout: 10000,
          headers: {
            rt: 1, // Return hidden trading pairs
          },
        };

        axios(httpOptions)
            .then((response) => handleResponse(response, resolve, reject, queryString, url))
            .catch((error) => handleResponse(error, resolve, reject, queryString, url));

      } catch (err) {
        log.log(`Request to ${url} with data ${queryString} failed. ${err}.`);
        reject(null);
      }
    });
  }

  /**
   * Get a signature for a Digifinex request
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
     * Get spot account assets
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#spot-account-assets
     * @return {Promise<Object>}
     */
    getBalances() {
      return protectedRequest('get', '/spot/assets', {});
    },

    /**
     * Get current active orders
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#current-active-orders
     * @param {String} symbol
     * @return {Promise<Object>}
     */
    getOrders(symbol) {
      const params = {
        symbol,
      };

      return protectedRequest('get', '/spot/order/current', params);
    },

    /**
     * Get order trades details
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#get-order-status
     * @param {String} orderId Example: '6b58ccadbc81ec4d02ef7b8cb716b5f8'
     * @returns {Promise<Object>}
     */
    getOrder(orderId) {
      const params = {
        order_id: orderId,
      };

      return protectedRequest('get', '/spot/order/detail', params);
    },

    /**
     * Create new order
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#create-new-order
     * @param {string} symbol In Digifinex format as BTC_USDT
     * @param {string} amount Base coin amount
     * @param {string} quote Quote coin amount
     * @param {string} price Order price
     * @param {string} side buy or sell
     * @return {Promise<Object>}
     */
    addOrder(symbol, amount, quote, price, side) {
      const data = {
        symbol,
        type: price ? side : `${side}_market`,
        amount: price ? amount : (side === 'buy' ? quote : amount),
        price: price ? price : undefined,
      };

      return protectedRequest('post', '/spot/order/new', data);
    },

    /**
     * Cancel order
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#cancel-order
     * @param {String} orderId Example: '6b58ccadbc81ec4d02ef7b8cb716b5f8'
     * @return {Promise<Object>}
     */
    cancelOrder(orderId) {
      const data = {
        order_id: orderId,
      };

      return protectedRequest('post', '/spot/order/cancel', data);
    },

    /**
     * Cancel all orders
     * Using the same endpoint:
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#cancel-order
     * @param {Array<String>} ordersIds
     * @return {Promise<Object>}
     */
    cancelAllOrders(ordersIds) {
      const data = {
        order_id: ordersIds.join(','),
      };

      return protectedRequest('post', '/spot/order/cancel', data);
    },

    /**
     * Get spot trading pair symbols
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#spot-trading-pair-symbol
     * @return {Promise<Object>}
     */
    markets() {
      return publicRequest('get', '/spot/symbols', {});
    },

    /**
     * Get currency deposit and withdrawal information
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#get-currency-deposit-and-withdrawal-information
     * @return {Promise<Object>}
     */
    currencies() {
      return publicRequest('get', '/currencies', {});
    },

    /**
     * Get ticker price
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#ticker-price
     * @param {String} symbol In Digifinex format as BTC_USDT
     * @return {Promise<Object>}
     */
    ticker(symbol) {
      const params = {
        symbol: symbol.toLowerCase(),
      };

      return publicRequest('get', '/ticker', params);
    },

    /**
     * Get orderbook
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#get-orderbook
     * @param {String} symbol In Digifinex format as BTC_USDT
     * @param {Number} [limit=150] Limit of depth, default 10, maximum 150
     * @return {Promise<Object>}
     */
    orderBook(symbol, limit = 150) {
      const params = {
        symbol,
        limit,
      };
      return publicRequest('get', '/order_book', params);
    },

    /**
     * Get trades history
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#get-recent-trades
     * @param {String} symbol In Digifinex format as BTC_USDT
     * @param {Number} [limit=500] Limit of trades returned, default 100, maximum 500
     * @return {Promise<Object>} Last trades
     */
    getTradesHistory(symbol, limit = 500) {
      const params = {
        symbol,
        limit,
      };

      return publicRequest( 'get', '/trades', params);
    },

    /**
     * Query the address of a specific currency
     * https://docs.digifinex.com/en-ww/spot/v3/rest.html#deposit-address-inquiry
     * @param {String} coin As BTC
     * @return {Promise<Object>}
     */
    getDepositAddress(coin) {
      const params = {
        currency: coin.toLowerCase(),
      };

      return protectedRequest('get', '/deposit/address', params);
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
module.exports.errorCodes = errorCodeDescriptions;