/* eslint-disable max-len */
const crypto = require('crypto');
const axios = require('axios');
const utils = require('../../helpers/utils');

module.exports = function() {
  let PUBLIC_WEB_BASE = 'https://api-pub.bitfinex.com';
  let PROTECTED_WEB_BASE = 'https://api.bitfinex.com';
  const WEB_BASE_PREFIX = '/v2';
  let config = {
    apiKey: '',
    secret_key: '',
    tradePwd: '',
  };
  let log = {};

  const handleResponse = (responseOrError, resolve, reject, bodyString, queryString, url) => {
    const data = responseOrError?.data || responseOrError?.response?.data;
    const httpCode = responseOrError?.status || responseOrError?.response?.status;

    const bitfinexMessage = `${data?.[0]} ${data?.[1]}> ${data?.[2]}`;
    const httpMessage = responseOrError?.statusText || responseOrError?.response?.statusText;
    const errorMessage = `${httpCode} ${httpMessage}, ${utils.trimAny(bitfinexMessage, ' .')}`;
    const reqParameters = queryString || '{ No parameters }';
    try {
      if (httpCode === 200) {
        resolve(data);
      } else if ([400].includes(httpCode)) {
        log.warn(`Bitfinex processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}.`);
        resolve(data);
      } else if ([404].includes(httpCode) && errorMessage.includes('order')) {
        log.warn(`Bitfinex processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. We assume that user doesn't have this order (but this may be a temporary server error, can't be sure).`);
        resolve(data);
      } else if ([401, 403].includes(httpCode)) {
        log.error(`Bitfinex to ${url} with data ${reqParameters} failed: ${errorMessage}. Check account keys and permissions.`);
        reject(errorMessage);
      } else if ([410, 503].includes(httpCode)) {
        log.warn(`Request to ${url} with data ${reqParameters} failed: ${errorMessage}. It may be a temporary exchange's API error.`);
        reject(errorMessage);
      } else if ([429].includes(httpCode)) {
        log.warn(`Request to ${url} with data ${reqParameters} failed. Rate limit exceeded. Got error message: ${errorMessage}.`);
        reject(errorMessage);
      } else if ([500].includes(httpCode)) {
        if (data?.[1] === '10114' || errorMessage.includes('nonce')) {
          // Error 10114> nonce: small
          log.warn(`Request to ${url} with data ${reqParameters} failed. Nonce error: ${errorMessage}.`);
          reject(errorMessage);
        } else {
          // Bitfinex returns 500 in case of bad parameters
          log.warn(`Bitfinex processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}.`);
          resolve(data);
        }
      } else if (data) {
        log.warn(`Request to ${url} with data ${reqParameters} failed: ${errorMessage}.`);
        reject(errorMessage);
      } else {
        log.warn(`Request to ${url} with data ${reqParameters} failed. ${responseOrError}.`);
        reject(`Unable to parse data: ${responseOrError}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        log.warn(`Request to ${url} with data ${reqParameters} failed. Unable to parse data: ${JSON.stringify(data)}. Exception: ${e}`);
        reject(`Unable to parse data: ${JSON.stringify(data)}`);
      } else {
        log.warn(`Error while processing response of request to ${url} with data ${reqParameters}: ${e}. Data object I've got: ${JSON.stringify(data)}.`);
        reject(`Unable to process data: ${JSON.stringify(data)}`);
      }
    }
  };

  function protectedRequest(path, data, type = 'get') {
    const urlBase = `${PROTECTED_WEB_BASE}${WEB_BASE_PREFIX}${path}`;

    const pars = [];
    for (const key in data) {
      const v = data[key];
      pars.push(key + '=' + v);
    }
    const nonce = (Date.now() * 1000).toString();
    pars.push('nonce' + '=' + nonce);
    const queryString = pars.join('&');

    let url = urlBase;
    if (queryString && type !== 'post') {
      url += '?' + queryString;
    }

    const bodyString = JSON.stringify(data);
    let sign;
    try {
      const apiPath = `${WEB_BASE_PREFIX}${path}`.substring(1);
      const signature = `/api/${apiPath}${nonce}${bodyString}`;
      sign = setSign(config.secret_key, signature);
    } catch (err) {
      log.error(`Error while creating signature: ${err}`);
      return Promise.reject(null);
    }

    return new Promise((resolve, reject) => {
      try {
        const httpOptions = {
          url,
          method: type,
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'bfx-nonce': nonce,
            'bfx-apikey': config.apiKey,
            'bfx-signature': sign,
          },
          data: type !== 'post' ? undefined : bodyString,
        };

        axios(httpOptions)
            .then((response) => handleResponse(response, resolve, reject, bodyString, queryString, urlBase))
            .catch((error) => handleResponse(error, resolve, reject, bodyString, queryString, urlBase));
      } catch (err) {
        log.log(`Processing of request to ${url} with data ${bodyString} failed. ${err}.`);
        reject(null);
      }
    });
  }

  function publicRequest(path, data, type = 'get') {
    const urlBase = `${PUBLIC_WEB_BASE}${WEB_BASE_PREFIX}${path}`;
    const pars = [];
    for (const key in data) {
      const v = data[key];
      pars.push(key + '=' + v);
    }
    const queryString = pars.join('&');
    let url = urlBase;
    if (queryString && type !== 'post') {
      url += '?' + queryString;
    }

    return new Promise((resolve, reject) => {
      try {
        const httpOptions = {
          url,
          method: type,
          timeout: 10000,
        };

        axios(httpOptions)
            .then((response) => handleResponse(response, resolve, reject, undefined, queryString, urlBase))
            .catch((error) => handleResponse(error, resolve, reject, undefined, queryString, urlBase));

      } catch (err) {
        log.log(`Request to ${url} with data ${queryString} failed. ${err}.`);
        reject(null);
      }
    });
  }

  function setSign(secret, str) {
    return crypto
        .createHmac('sha384', secret)
        .update(str)
        .digest('hex');
  }

  const EXCHANGE_API = {
    LAST_TRADES_COUNT: 600, // get last trades by REST and store by socket
    DEPTH_LENGTH: 100, // get order book depth by REST and store by socket. Note: socket supports max 250, and REST supports max 100

    /**
     * @param {String} apiPublicServer
     * @param {String} apiProtectedServer
     * @param {String} apiKey
     * @param {String} secretKey
     * @param {String} tradePwd
     * @param {Object} logger
     * @param {Boolean} publicOnly
     */
    setConfig(apiPublicServer, apiProtectedServer, apiKey, secretKey, tradePwd, logger, publicOnly = false) {
      if (apiPublicServer) {
        PUBLIC_WEB_BASE = apiPublicServer;
      }

      if (apiProtectedServer) {
        PROTECTED_WEB_BASE = apiProtectedServer;
      }

      if (logger) {
        log = logger;
      }

      if (!publicOnly) {
        config = {
          apiKey,
          secret_key: secretKey,
          tradePwd,
        };
      }
    },

    /**
     * Fetches an array of market information for each currency
     * @return {Array} [[PAIR,[PLACEHOLDER,PLACEHOLDER,PLACEHOLDER,MIN_ORDER_SIZE,MAX_ORDER_SIZE,PLACEHOLDER,PLACEHOLDER,PLACEHOLDER,INITIAL_MARGIN,MIN_MARGIN]]...]
     * https://docs.bitfinex.com/reference/rest-public-conf
     */
    markets() {
      return publicRequest('/conf/pub:info:pair', {}, 'get');
    },

    /**
     * Get info on all currencies
     * 0 - pub:list:currency - Fetch a list of all currencies available on the platform
     * 1 - pub:map:currency:label - Maps symbols to their verbose friendly name (e.g. BTC -> Bitcoin)
     * 2 - pub:map:currency:sym - Map symbols to their API symbols (e.g. DSH -> DASH)
     * 3 - pub:map:currency:pool - Maps symbols to the underlying network/protocol they operate on (e.g. BAT -> ETH)
     * 4 - pub:map:currency:tx:fee - Maps currencies to their current withdrawal fee amount
     * 5 - pub:map:tx:method - Maps currencies to their appropriate method for API withdrawals (e.g. BTC -> bitcoin)
     * 6 - pub:info:tx:status - Fetches an array showing the wallet status for each currency for deposits and withdrawals (1 = active, 0 = maintenance) Also shows if payment IDs are allowed for deposits and withdrawals (1 = allowed, 0 = not allowed)
     * @return {Array} [[COIN, ...], [[COIN, NAME], ...], [[COIN, SYM], ...], [[COIN, POOL], ...], [[COIN, [PLACEHOLDER, FEE]], ...]]
     * https://docs.bitfinex.com/reference/rest-public-conf
     */
    currencies() {
      return publicRequest('/conf/pub:list:currency,pub:map:currency:label,pub:map:currency:sym,pub:map:currency:pool,pub:map:currency:tx:fee,pub:map:tx:method,pub:info:tx:status', {}, 'get');
    },

    /**
     * Get account wallet balances
     * @return {Array}
     * https://docs.bitfinex.com/reference/rest-auth-wallets
     */
    getBalances() {
      return protectedRequest('/auth/r/wallets', {}, 'post');
    },

    /**
     * Get active orders
     * @param {String} symbol Like 'BTCUSD'
     * @return {Array} [[ID, GID, CID, SYMBOL, MTS_CREATE, MTS_UPDATE, AMOUNT, AMOUNT_ORIG, TYPE, TYPE_PREV, _PLACEHOLDER, _PLACEHOLDER, FLAGS, STATUS, _PLACEHOLDER, _PLACEHOLDER, PRICE, PRICE_AVG, PRICE_TRAILING, PRICE_AUX_LIMIT, _PLACEHOLDER, _PLACEHOLDER, _PLACEHOLDER, HIDDEN,  PLACED_ID, _PLACEHOLDER, _PLACEHOLDER, _PLACEHOLDER, ROUTING, _PLACEHOLDER, _PLACEHOLDER, META],]
     * https://docs.bitfinex.com/reference/rest-auth-orders
     */
    getOrders(symbol) {
      return protectedRequest(`/auth/r/orders/t${symbol}`, {}, 'post');
    },

    /**
     * Retrieve a specific active order by order ID
     * @param {Number} orderId Example: 119354495120
     * @returns {Array}
     * https://docs.bitfinex.com/reference/rest-auth-retrieve-orders
     */
    getOrder(orderId) {
      const data = {
        id: [orderId],
      };

      return protectedRequest('/auth/r/orders', data, 'post');
    },

    /**
     * Retrieve a specific closed/cancelled order by order ID
     * @param {Number} orderId Example: 119354495120
     * @returns {Array}
     * https://docs.bitfinex.com/reference/rest-auth-orders-history
     */
    getOrderHist(orderId) {
      const data = {
        id: [orderId],
      };

      return protectedRequest('/auth/r/orders/hist', data, 'post');
    },

    /**
     * Submit an Order
     * @param {String} symbol Like 'BTCUSD'
     * @param {Number} amount Amount of order (positive for buy, negative for sell)
     * @param {String} price
     * @param {String} side 'buy' or 'sell'
     * @param {String} type LIMIT, EXCHANGE LIMIT, MARKET, EXCHANGE MARKET, STOP LIMIT, EXCHANGE STOP LIMIT.. etc
     * https://docs.bitfinex.com/reference/rest-auth-submit-order
     */
    addOrder(symbol, amount, price, side, type) {
      const data = {
        type,
        symbol: `t${symbol}`,
        amount: String(side === 'buy' ? (+amount) : (-amount)),
      };

      if (type === 'EXCHANGE LIMIT') {
        data.price = price;
      }

      return protectedRequest('/auth/w/order/submit', data, 'post');
    },

    /**
     * Cancel an existing order
     * @param {Number} orderId
     * @return {Array}
     * https://docs.bitfinex.com/reference/rest-auth-cancel-order
     */
    cancelOrder(orderId) {
      return protectedRequest('/auth/w/order/cancel', {
        id: orderId,
      }, 'post');
    },

    /**
     * Cancel multiple orders simultaneously
     * @param {Array<Number>} OrderIds
     * @return {Array}
     * https://docs.bitfinex.com/reference/rest-auth-order-cancel-multi
     */
    cancelAllOrders(orderIds) {
      return protectedRequest('/auth/w/order/cancel/multi', {
        id: orderIds,
      }, 'post');
    },

    /**
     * Get trade details for a ticker (market rates)
     * @param {String} symbol
     * @return {Array}
     * https://docs.bitfinex.com/reference/rest-public-ticker
     */
    ticker(symbol) {
      return publicRequest(`/ticker/t${symbol}`, {}, 'get');
    },

    /**
     * The trades endpoint allows the retrieval of past public trades and includes details such as price, size, and time
     * @param {String} symbol
     * @param {Number} limit Max is 10000
     * @return {Array} Last trades
     * https://docs.bitfinex.com/reference/rest-public-trades
     */
    getTradesHistory(symbol, limit = this.LAST_TRADES_COUNT) {
      return publicRequest(`/trades/t${symbol}/hist`, {
        limit,
      }, 'get');
    },

    /**
     * The Public Books endpoint allows you to keep track of the state of Bitfinex order books
     * on a price aggregated basis with customizable precision
     * Level of price aggregation: P0, P1, P2, P3, P4, R0
     * @param {String} symbol
     * @return {Array} [ [ORDER_ID, PRICE, AMOUNT] ]
     * https://docs.bitfinex.com/reference/rest-public-book
     */
    orderBook(symbol) {
      return publicRequest(`/book/t${symbol}/R0`, {
        len: this.DEPTH_LENGTH, // Number of price points ("1", "25", "100")
      }, 'get');
    },

    /**
     * Retrieve your deposit address or generate a new deposit address for a specific currency and wallet
     * @param {String} method Wallet name
     * @return {Array}
     * https://docs.bitfinex.com/reference/rest-auth-deposit-address
     */
    getDepositAddress(method) {
      return protectedRequest('/auth/w/deposit/address', {
        wallet: 'exchange',
        method,
        op_renew: 0, // 1 for new address
      }, 'post');
    },

    /**
     * Maps symbols to deposit method names
     * @returns {Array} [[[DEPOSIT_METHOD, [COIN, ...]], ...]]
     * https://docs.bitfinex.com/reference/rest-public-conf
     */
    getDepositAndWithdrawalMethods() {
      return publicRequest('/conf/pub:map:tx:method', {}, 'get');
    },

    /**
     * Provides an overview of the different fee rates for the account
     * @returns {Array}
     * https://docs.bitfinex.com/reference/rest-auth-summary
     */
    getFees() {
      return protectedRequest('/auth/r/summary', {}, 'post');
    },
  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
