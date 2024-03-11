const axios = require('axios');
const jwt = require('jsonwebtoken');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://open.big.one/docs/api.html
 */

/**
 * Error codes: https://open.big.one/docs/api_error_codes.html
 * isTemporary means that we consider the request is temporary failed and we'll repeat it later with success possibility
 */
const errorCodeDescriptions = {
  10001: {
    description: 'syntax error',
  },
  10005: {
    description: 'internal error',
  },
  10007: {
    description: 'parameter error',
  },
  10011: {
    description: 'system error',
  },
  10013: {
    description: 'resource not found',
  },
  10014: {
    description: 'insufficient funds',
  },
  10403: {
    description: 'permission denied',
  },
  10429: {
    description: 'too many requests',
    isTemporary: true,
  },
  40004: {
    description: 'unauthorized',
  },
  40103: {
    description: 'invalid otp code',
  },
  40104: {
    description: 'invalid asset pin code',
  },
  40302: {
    description: 'already requested',
  },
  40601: {
    description: 'resource is locked',
  },
  40602: {
    description: 'resource is depleted',
  },
  40603: {
    description: 'insufficient resource',
  },
  54041: {
    description: 'duplicate order',
  },
  54043: {
    description: 'unknown opening order',
  },
  50047: {
    description: 'liquidity taken too much',
  },
};

// No error code descriptions from BigONE
const httpErrorCodeDescriptions = {
  4: { // 4XX
    description: 'Wrong request content, behavior, format',
    isTemporary: false,
  },
  401: {
    description: 'Unauthorized',
    isTemporary: true,
  },
  429: {
    description: 'Warning access frequency exceeding the limit',
    isTemporary: true,
  },
  5: { // 5XX
    description: 'Problems on the Bigone service side',
    isTemporary: true,
  },
  504: {
    description: 'API server has submitted a request to the business core but failed to get a response',
    isTemporary: false,
  },
};

module.exports = function() {
  let WEB_BASE = 'https://big.one/api/v3';
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
   * @param {string} queryString
   * @param {string} url
   */
  const handleResponse = (responseOrError, resolve, reject, queryString, url) => {
    const httpCode = responseOrError?.status ?? responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText ?? responseOrError?.response?.statusText;

    const data = responseOrError?.data ?? responseOrError?.response?.data;

    const success = httpCode === 200 && data?.code === 0;

    const bigoneError = errorCodeDescriptions[data?.code];
    const error = {
      code: data?.code ?? 'No error code',
      message: data?.message ?? 'No error message',
      description: bigoneError?.description ?? 'No error description',
    };

    const httpCodeInfo = httpErrorCodeDescriptions[httpCode] ?? httpErrorCodeDescriptions[httpCode?.toString()[0]];

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const bigoneErrorInfoString = `[${error.code}] ${trimAny(error.description, ' .')}, ${trimAny(error.message, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${bigoneErrorInfoString}` : String(responseOrError);

        if (typeof data === 'object') {
          data.bigoneErrorInfo = bigoneErrorInfoString;
        }

        if (httpCode && !httpCodeInfo?.isTemporary && !bigoneError?.isTemporary) {
          log.log(`BigONE processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);

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
   * @param {string} type Request type: get, post, delete
   * @param {string} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    const bodyString = getParamsString(data);

    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    const payload = {
      type: 'OpenAPIV2',
      sub: config.apiKey,
      nonce: (Date.now() * 10 ** 6).toString(),
    };

    const sign = jwt.sign(payload, config.secret_key, { header });

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sign}`,
        },
        data: type === 'post' ? data : undefined,
        params: type === 'get' ? data : undefined,
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, url))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, url));
    });
  }

  /**
   * Makes a request to public endpoint
   * @param {string} type Request type: get, post, delete
   * @param {string} path Endpoint
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
     * Balance of all assets
     * https://open.big.one/docs/spot_accounts.html#balance-of-all-assets
     * @return {Promise<Object>}
     */
    getBalances() {
      return protectedRequest('get', '/viewer/accounts', {});
    },

    /**
     * Get user orders in one asset pair
     * https://open.big.one/docs/spot_orders.html#get-user-orders-in-one-asset-pair
     * @param {string} symbol In BigONE format as BTC-USDT
     * @param {number} [limit=200] Default: 20. Max: 200
     * @param {string} [page_token]
     * It's possible to require order state: PENDING,OPENING,CLOSED,NONE_FILLED,ALL. Default is PENDING (same as OPENING), which includes FIRED and PENDING.
     * @return {Promise<Object>}
     */
    getOrders(symbol, limit = 200, page_token) {
      const params = {
        asset_pair_name: symbol,
        limit,
        page_token,
      };

      return protectedRequest('get', '/viewer/orders', params);
    },

    /**
     * Get one order
     * https://open.big.one/docs/spot_orders.html#get-one-order
     * @param {string} orderId Example: '41994282348'
     * @returns {Promise<Object>}
     */
    getOrder(orderId) {
      return protectedRequest('get', `/viewer/orders/${orderId}`, {});
    },

    /**
     * Create Order
     * https://open.big.one/docs/spot_orders.html#create-order
     * @param {string} symbol In BigONE format as BTC-USDT
     * @param {string} amount Base coin amount
     * @param {string} quote Quote coin amount
     * @param {string} price Order price
     * @param {string} side buy or sell
     * @param {string} type market or limit
     * @return {Promise<Object>}
     */
    addOrder(symbol, amount, quote, price, side, type) {
      const data = {
        asset_pair_name: symbol,
        side: side === 'buy' ? 'BID' : 'ASK',
        type: type.toUpperCase(),
        price: type === 'limit' ? price : undefined,
        amount: type === 'market' && side === 'buy' ? quote : amount,
      };

      return protectedRequest('post', '/viewer/orders', data);
    },

    /**
     * Cancel Order
     * https://open.big.one/docs/spot_orders.html#cancel-order
     * @param {string} orderId Example: '41994282348'
     * @return {Promise<Object>}
     */
    cancelOrder(orderId) {
      return protectedRequest('post', `/viewer/orders/${orderId}/cancel`, {});
    },

    /**
     * Cancel All Orders
     * https://open.big.one/docs/spot_orders.html#cancel-all-orders
     * @param {string} symbol In BigONE format as BTC-USDT
     * @return {Promise<Object>}
     */
    cancelAllOrders(symbol) {
      const data = {
        asset_pair_name: symbol,
      };

      return protectedRequest('post', '/viewer/orders/cancel', data);
    },

    /**
     * Ticker of one asset pair
     * https://open.big.one/docs/spot_tickers.html#ticker-of-one-asset-pair
     * @param {string} symbol In BigONE format as BTC-USDT
     * @return {Promise<Object>}
     */
    ticker(symbol) {
      return publicRequest('get', `/asset_pairs/${symbol}/ticker`, {});
    },

    /**
     * OrderBook of a asset pair
     * https://open.big.one/docs/spot_order_books.html#orderbook-of-a-asset-pair
     * @param {string} symbol In BigONE format as BTC-USDT
     * @param {number} [limit=200] Default: 50. Max: 200
     * @return {Promise<Object>}
     */
    orderBook(symbol, limit = 200) {
      const params = {
        limit,
      };

      return publicRequest('get', `/asset_pairs/${symbol}/depth`, params);
    },

    /**
     * Trades of a asset pair
     * Note: returns 50 latest trades only
     * https://open.big.one/docs/spot_asset_pair_trade.html#trades-of-a-asset-pair
     * @param {string} symbol In BigONE format as BTC-USDT
     * @return {Promise<Object>}
     */
    getTradesHistory(symbol) {
      return publicRequest('get', `/asset_pairs/${symbol}/trades`, {});
    },

    /**
     * All AssetPairs
     * https://open.big.one/docs/spot_asset_pair.html#all-assetpairs
     * @return {Promise<{}>}
    */
    markets() {
      return publicRequest('get', '/asset_pairs', {});
    },

    /**
     * Get deposite address of one asset of user
     * https://open.big.one/docs/spot_deposit.html#get-deposite-address-of-one-asset-of-user
     * @param {string} coin as BTC
     * @return {Promise<Object>}
     */
    getDepositAddress(coin) {
      return protectedRequest('get', `/viewer/assets/${coin}/address`, {});
    },

    /**
     * TradingFee of user
     * https://open.big.one/docs/spot_trading_fee.html#tradingfee-of-user
     * @param {string} asset_pair_names Example: 'BTC-USDT,ONE-USDT'
     * @return {Promise<Object>}
     */
    getFees(asset_pair_names) {
      const params = {
        asset_pair_names,
      };

      return protectedRequest('get', '/viewer/trading_fees', params);
    },

  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
