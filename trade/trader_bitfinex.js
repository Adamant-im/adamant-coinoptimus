const BitfinexApi = require('./api/bitfinex_api');
const utils = require('../helpers/utils');
const _networks = require('../helpers/networks');

// API endpoints:
const apiPublicServer = 'https://api-pub.bitfinex.com';
const apiProtectedServer = 'https://api.bitfinex.com';

const exchangeName = 'Bitfinex';

// https://docs.bitfinex.com/docs#price-precision
const marketDecimals = 8;
const marketPrecision = utils.getPrecision(marketDecimals);
const priceSignificantDigits = 5;

// https://docs.bitfinex.com/reference/rest-auth-withdraw
const bitfinexMethods = {
  tetheruse: {
    name: 'Tether(USD) on Ethereum',
    chainMappedCode: 'ERC20',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusx: {
    name: 'Tether(USD) on Tron',
    chainMappedCode: 'TRC20',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusl: {
    name: 'Tether(USD) on Liquid',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetheruso: {
    name: 'Tether(USD) on Omni',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtsol: {
    name: 'Tether(USD) on Solana',
    chainMappedCode: 'SOL',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtavax: {
    name: 'Tether(USD) on Avalanche (C Chain)',
    chainMappedCode: 'AVAX-C-CHAIN',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtalg: {
    name: 'Tether(USD) on Algorand',
    chainMappedCode: 'ALGO',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtdot: {
    name: 'Tether(USD) on Polkadot',
    chainMappedCode: 'DOT',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtksm: {
    name: 'Tether(USD) on Kusama',
    chainMappedCode: 'KUSAMA',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetheruss: {
    name: 'Tether(USD) on EOS',
    chainMappedCode: 'EOS',
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdthez: {
    name: 'Tether(USD) on Hermez (L2 Ethereum)',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtomg: {
    name: 'Tether(USD) on OMG',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtbch: {
    name: 'Tether(USD) on BCH',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  tetherusdtdvf: {
    name: 'Tether(USD) on Deversifi (L2 Ethereum)',
    chainMappedCode: undefined,
    symbol: 'USDT',
    apiSymbol: 'UST',
  },
  // Skipped EURT, CNHT, XAUT, MXNT
};

// Skip shit besides TEST*
const skipSymbols = [
  'EUTF0', 'USTF0',
];

module.exports = (
    apiKey,
    secretKey,
    pwd,
    log,
    publicOnly = false,
    loadMarket = true,
) => {
  const bitfinexApiClient = BitfinexApi();

  bitfinexApiClient.setConfig(apiPublicServer, apiProtectedServer, apiKey, secretKey, pwd, log, publicOnly);

  if (loadMarket) {
    getMarkets();
    getCurrencies();
  }

  /**
   * Get info on all markets
   * module.exports.exchangeMarkets stores market names in Bitfinex format like 'ADMUST'
   * When any method receives a request,
   * It formats 'pair' parameter from general format like 'ADM/USDT' to Bitfinex's 'ADMUST'
   * getMarkets() is internal functions, it's not called outside of this module
   * @param {String} pair
   * @returns {Promise<unknown>|*}
   */
  function getMarkets(pair) {
    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair];

    module.exports.gettingMarkets = true;
    return new Promise((resolve) => {
      bitfinexApiClient.markets().then((markets = []) => {
        try {
          const result = {};
          markets[0].forEach((market) => {
            const pairName = deformatPairName(market[0]);
            result[pairName.pair] = {
              pair: pairName.pair,
              pairReadable: pairName.pairReadable,
              pairPlain: market[0],
              coin1: pairName.coin1,
              coin2: pairName.coin2,
              coin1Decimals: marketDecimals,
              coin2Decimals: marketDecimals,
              coin1Precision: marketPrecision,
              coin2Precision: marketPrecision,
              coin1MinAmount: Number(market[1][3]),
              coin1MaxAmount: Number(market[1][4]),
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: null, // in coin1
              status: 'ONLINE', // 'ONLINE' for active
              statusMessage: null, // extra information regarding the status,
            };
          });

          if (Object.keys(result).length > 0) {
            module.exports.exchangeMarkets = result;
            log.log(`Received info about ${Object.keys(result).length} markets on ${exchangeName} exchange.`);
          }
          resolve(result);
        } catch (e) {
          resolve(false);
          log.warn('Error while processing getMarkets() request: ' + e);
        }
      }).catch((err) => {
        log.warn(`API request getMarkets() of ${utils.getModuleName(module.id)} module failed. ${err}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingMarkets = false;
      });
    });
  }

  /**
   * Get info on all currencies
   * @param {String} coin If set, take it as 1) Usual ticker as USDT 2) Bitfinex ticker as USD
   * @param {Boolean} forceUpdate Update currencies to refresh parameters, as withdrawal fees
   * @returns {Promise<unknown>|*}
   */
  function getCurrencies(coin, forceUpdate = false) {
    if (module.exports.gettingCurrencies) return;
    const storedCurrencies = module.exports.exchangeCurrencies;

    if (storedCurrencies && !forceUpdate) {
      if (storedCurrencies[coin]) {
        return storedCurrencies[coin];
      } else {
        for (const currency in storedCurrencies) {
          if (storedCurrencies[currency].symbol.toUpperCase() === coin) {
            return storedCurrencies[currency];
          }
        }
        return undefined;
      }
    }

    module.exports.gettingCurrencies = true;
    return new Promise((resolve) => {
      bitfinexApiClient.currencies().then((currencies) => {
        try {
          const result = {};
          currencies[0].forEach((currency) => { // 0 - pub:list:currency
            if (!currency.includes('TEST') && !skipSymbols.includes(currency)) {
              result[currency] = {
                name: undefined, // To be set with 1 - pub:map:currency:label
                symbol: currency, // Usual ticker. May by replaced with 2 - pub:map:currency:sym. UST -> USDT
                status: 'ONLINE', // 'ONLINE', 'OFFLINE'
                comment: undefined,
                confirmations: undefined, // for deposit
                withdrawalFee: undefined,
                minWithdrawal: undefined,
                maxWithdrawal: undefined,
                logoUrl: undefined, // logo url is not provided by api
                exchangeAddress: undefined,
                decimals: marketDecimals,
                precision: marketPrecision,
                minSize: undefined,
                type: undefined, // 'fiat'
                networks: undefined,
                defaultNetwork: undefined,
                apiSymbol: currency, // Bitfinex ticker as UST for USDT
              };
            }
          });

          currencies?.[1].forEach((currency) => { // 1 - pub:map:currency:label
            if (result[currency?.[0]]) {
              result[currency?.[0]].name = currency?.[1];
            }
          });

          currencies?.[2].forEach((currency) => { // 2 - pub:map:currency:sym ["USS","USDt"],["UST","USDt"]
            if (result[currency?.[0]]) {
              result[currency?.[0]].symbol = currency?.[1].toUpperCase();
            }
          });

          currencies?.[3].forEach((currency) => { // 3 - pub:map:currency:pool
            const apiSymbol = currency[0];
            const network = currency[1];

            if (result[apiSymbol]) {
              result[apiSymbol].networks = result[apiSymbol].networks || {};

              const chainMappedCode = formatNetworkName(network); // ETH -> ERC20
              result[apiSymbol].networks[chainMappedCode] = {
                minWithdrawal: undefined,
                maxWithdrawal: undefined,
                confirmations: undefined,
                status: undefined,
                chainName: network, // Chain plain name on Bitfinex (method)
                chainMappedCode,
                chainMappedName: _networks[chainMappedCode]?.name,
                contractAddress: undefined,
              };
            }
          });

          currencies?.[4].forEach((currency) => { // 4 - pub:map:currency:tx:fee
            if (result[currency?.[0]]) {
              result[currency?.[0]].withdrawalFee = currency?.[1][1];
            }
          });

          currencies?.[5].forEach((currency) => { // 5 - pub:map:tx:method [ [ ["BITCOIN",["BTC"] ],.. ]
            const apiSymbols = currency[1];
            const method = currency[0];
            const methodInfo = currencies?.[6].filter((el) => el[0] === method)?.[0] || {}; // 6 - pub:info:tx:status
            let withdrawalFee;
            currencies[4].forEach((fee) => { // 4 - pub:map:currency:tx:fee
              if ('TETHER' + fee[0] === method) {
                withdrawalFee = fee[1][1];
              }
            });

            apiSymbols.forEach((apiSymbol) => {
              if (result[apiSymbol]) {
                result[apiSymbol].methods = result[apiSymbol].methods || []; // One coin has several withdrawal methods
                result[apiSymbol].methods[method] = {
                  methodName: method,
                  chainName: method, // Chain plain name on Bitfinex (method)
                  depositStatus: methodInfo[1] ? 'ONLINE' : 'OFFLINE',
                  withdrawalStatus: methodInfo[2] ? 'ONLINE' : 'OFFLINE',
                  status: (methodInfo[1] || methodInfo[2]) ? 'ONLINE' : 'OFFLINE',
                  paymentIdDeposit: methodInfo[7],
                  paymentIdWithdrawal: methodInfo[8],
                  confirmations: methodInfo[11],
                  withdrawalFee,
                };
              }
            });
          });

          // Fill networks according to methods
          Object.keys(result).forEach((currency) => {
            const currencyMethods = result[currency].methods;
            if (currencyMethods) {
              let coinHasBitfinexMethod = false;

              // Specific method info, i. e., for USDT
              Object.keys(currencyMethods)?.forEach((methodName) => {
                const method = currencyMethods[methodName];
                const bitfinexMethod = bitfinexMethods[methodName.toLowerCase()];

                if (bitfinexMethod?.chainMappedCode) {
                  coinHasBitfinexMethod = true;
                  result[currency].networks = result[currency].networks || {};
                  result[currency].networks[bitfinexMethod.chainMappedCode] = {
                    minWithdrawal: undefined,
                    maxWithdrawal: undefined,
                    confirmations: method.confirmations,
                    depositStatus: method.depositStatus,
                    withdrawalStatus: method.withdrawalStatus,
                    status: method.status,
                    methodName: method.methodName,
                    chainName: method.methodName, // Chain plain name on Bitfinex (method)
                    name: bitfinexMethod.name, // Method full name on Bitfinex
                    chainMappedCode: bitfinexMethod.chainMappedCode,
                    chainMappedName: _networks[bitfinexMethod.chainMappedCode]?.name,
                    contractAddress: undefined,
                    withdrawalFee: method.withdrawalFee,
                  };
                }
              });

              if (!coinHasBitfinexMethod) {
                const method = Object.values(currencyMethods)?.[0];

                if (result[currency].networks) { // Coin has a network info like ERC20
                  Object.keys(result[currency].networks)?.forEach((networkName) => {
                    Object.assign(result[currency].networks[networkName], method);
                  });
                } else { // Create coin network with the same name as method, 'BITCOIN' for example
                  result[currency].networks = {};
                  result[currency].networks[result[currency].symbol] = {
                    minWithdrawal: undefined,
                    maxWithdrawal: undefined,
                    contractAddress: undefined,
                    ...method,
                  };
                }
              } // if (!coinHasBitfinexMethod)
            } // if (currencyMethods)
          });

          if (Object.keys(result).length > 0) {
            module.exports.exchangeCurrencies = result;
            log.log(`${forceUpdate ? 'Updated' : 'Received'} info about ${Object.keys(result).length} currencies on ${exchangeName} exchange.`);
          }

          module.exports.gettingCurrencies = false;
          resolve(result);
        } catch (e) {
          resolve(false);
          log.warn('Error while processing getCurrencies() request: ' + e);
        }
      }).catch((err) => {
        log.warn(`API request getCurrencies() of ${utils.getModuleName(module.id)} module failed. ${err}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingCurrencies = false;
      });
    });
  }

  /**
   * Returns pair in Bitfinex format like 'BTCUST'
   * @param pair Pair in any format
   * @returns {Object|Boolean} pair, pairReadable, coin1, coin2
  */
  function formatPairName(pair) {
    if (!module.exports.exchangeCurrencies) {
      const message = 'Unable to format pair name. Currencies from Bitfinex are not loaded yet.';
      log.warn(message);
      return false;
    }
    pair = pair?.toUpperCase();
    let coin1;
    let coin2;
    if (pair.indexOf('_') > -1) {
      [coin1, coin2] = pair.split('_');
    } else {
      [coin1, coin2] = pair.split('/');
    }
    const coinApiSymbol1 = getCurrencies(coin1)?.apiSymbol;
    const coinApiSymbol2 = getCurrencies(coin2)?.apiSymbol;
    pair = `${coinApiSymbol1}${coinApiSymbol2}`;
    return {
      pair,
      pairReadable: `${coin1}/${coin2}`,
      coin1,
      coin2,
    };
  }

  /**
   * Returns pair in Bitfinex format like 'BTCUST', coin1 & coin2
   * @param pair Pair in plain Bitfinex format like 'BTCUST', 'SHIB:UST'
   * @returns {Object} Pair, coin1, coin2
   */
  function deformatPairName(pair) {
    pair = pair?.toUpperCase();
    let coin1;
    let coin2;
    if (pair.includes(':')) {
      [coin1, coin2] = pair.split(':');
    } else if (pair.includes('/')) {
      [coin1, coin2] = pair.split('/');
    } else {
      coin1 = pair.substring(0, 3);
      coin2 = pair.substring(3, 6);
    }

    return {
      pair: `${coin1}${coin2}`,
      pairReadable: `${coin1}/${coin2}`,
      coin1,
      coin2,
    };
  }

  return {
    bitfinexApiClient,

    getCurrencies,

    getMarkets,

    get markets() {
      return module.exports.exchangeMarkets;
    },

    get currencies() {
      return module.exports.exchangeCurrencies;
    },

    get depositMethods() {
      return module.exports.depositMethods;
    },

    /**
     * Get market info for a pair
     * @param pair
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      const pair_ = formatPairName(pair);
      if (!pair_) {
        return false;
      }
      return getMarkets(pair_.pair);
    },

    /**
     * Get currency info for a coin
     * @param coin
     * @returns {*|Promise<unknown>}
     */
    currencyInfo(coin) {
      return getCurrencies(coin);
    },

    /**
     * Features available on Bitfinex exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: true,
        placeMarketOrder: true,
        getDepositAddress: true,
        getTradingFees: true,
        getAccountTradeVolume: false,
        createDepositAddressWithWebsiteOnly: false,
        selfTradeProhibited: true,
        getFundHistory: true,
        getFundHistoryImplemented: true,
        allowAmountForMarketBuy: true,
        amountForMarketOrderNecessary: true,
        orderNumberLimit: 100,
        accountTypes: ['exchange', 'margin', 'funding'], // Bitfinex have account types (wallets)
        supportCoinNetworks: true,
        getWithdrawalById: false,
        withdrawAccountType: undefined, // Withdrawals available from any account
        withdrawalSuccessNote: 'Depending on your account settings, Bitfinex may email you to approve the withdrawal',
        supportTransferBetweenAccounts: true,
      };
    },

    /**
     * List of account balances for all currencies
     * @param {Boolean} nonzero Bitfinex API returns only non-zero balances
     * @param {String} accountType Bitfinex supports funding(main), exchange(trade), margin account types.
     *   If undefined, will return balances for 'exchange(trade)' account. If 'full', will return balances for all account types.
     * @returns {Promise<unknown>}
     */
    async getBalances(nonzero = true, accountType) {
      const paramString = `nonzero: ${nonzero}, accountType: ${accountType}`;

      if (!module.exports.exchangeCurrencies) {
        log.warn('Unable to format pair name. Currencies from Bitfinex are not loaded yet.');
        return undefined;
      }

      let data;

      try {
        data = await bitfinexApiClient.getBalances();
      } catch (e) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${e}`);
        return undefined;
      }

      try {
        if (data && data[0] !== 'error') {
          let assets = data;
          let result = [];

          if (!accountType) {
            accountType = 'exchange';
          }

          // We want only assets from specific account
          if (accountType !== 'full') {
            assets = assets.filter((crypto) => crypto[0] === accountType);
          }

          assets.forEach((crypto) => {
            result.push({
              accountType: crypto[0],
              code: this.currencyInfo(crypto[1]).symbol,
              free: +crypto[4],
              freezed: +crypto[2] - +crypto[4],
              total: +crypto[2],
            });
          });
          if (nonzero) {
            result = result.filter((crypto) => crypto.free || crypto.freezed);
          }

          return result;
        } else {
          const errorMessage = `${data?.[0]} ${data?.[1]}> ${data?.[2]}`;
          log.warn(`Request getBalances(${paramString}) failed: ${errorMessage}`);
          return undefined;
        }
      } catch (e) {
        log.warn(`Error while processing getBalances(${paramString}) request: ${e}`);
        return undefined;
      }
    },

    /**
     * List of all account open orders
     * @param {String} pair
     * @returns {Promise<*[]|undefined>}
     */
    async getOpenOrders(pair) {
      const paramString = `pair: ${pair}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        return undefined;
      }

      let data;

      try {
        data = await bitfinexApiClient.getOrders(pair_.pair);
      } catch (e) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${e}`);
        return undefined;
      }

      try {
        if (data && data[0] !== 'error') {
          const result = [];

          data.forEach((order) => {
            let orderStatus;
            let orderType;

            orderStatus = order?.[13];
            if (orderStatus === 'ACTIVE') {
              orderStatus = 'new';
            } else if (orderStatus.includes('PARTIALLY FILLED')) {
              orderStatus = 'part_filled';
            } else {
              orderStatus = 'filled';
            }

            if (order?.[8].includes('MARKET')) {
              orderType = 'market';
            } else if (order?.[8].includes('LIMIT')) {
              orderType = 'limit';
            }

            result.push({
              orderId: order?.[0]?.toString(),
              symbol: order?.[3], // in Bitfinex format like 'tBTCUSD'
              price: +order?.[16],
              side: +order?.[6] > 0 ? 'buy' : 'sell',
              type: orderType,
              timestamp: order?.[4],
              amount: Math.abs(order?.[7]), // AMOUNT_ORIG
              status: orderStatus,
              amountExecuted: Math.abs(order?.[7]) - Math.abs(order?.[6]),
              amountLeft: Math.abs(order?.[6]), // AMOUNT
            });
          });

          return result;
        } else {
          const errorMessage = `${data?.[0]} ${data?.[1]}> ${data?.[2]}`;
          log.warn(`Request getOpenOrders(${paramString}) failed: ${errorMessage}`);
          return undefined;
        }
      } catch (e) {
        log.warn(`Error while processing getOpenOrders(${paramString}) request: ${e}`);
        return undefined;
      }
    },

    /**
     * Cancel an order
     * @param {String} orderId
     * @param {String} side
     * @param {String} pair For logging only
     * @returns {Promise<unknown>}
     */
    cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;

      return new Promise((resolve) => {
        bitfinexApiClient.cancelOrder(+orderId).then((data) => {
          try {
            if (data && data[0] !== 'error') {
              log.log(`Cancelling order ${orderId} on ${pair} pair…`);
              resolve(true);
            } else {
              const errorMessage = `${data?.[0]} ${data?.[1]}> ${data?.[2]}`;
              log.log(`Unable to cancel ${orderId} on ${pair} pair: ${errorMessage || 'No details.'}`);
              resolve(false);
            }
          } catch (e) {
            log.warn(`Error while processing cancelOrder(${paramString}) request: ${e}`);
            resolve(undefined);
          }
        }).catch((err) => {
          log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Cancel all orders
     * @param {String} pair
     * @returns {Promise<boolean>}
     */
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        return undefined;
      }

      const orderIds = [];
      try {
        const ordersToCancel = await this.getOpenOrders(pair);
        if (!ordersToCancel?.length) {
          log.log(`Cancelling all ${pair_.pairReadable} orders: No open orders.`);
          return true;
        }
        ordersToCancel.forEach((order) => {
          orderIds.push(+order.orderId);
        });
      } catch (err) {
        log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}`);
      }

      return new Promise((resolve) => {
        bitfinexApiClient.cancelAllOrders(orderIds).then((data) => {
          try {
            if (data && data[0] !== 'error') {
              log.log(`Cancelling all ${orderIds?.length} orders on ${pair_.pairReadable} pair…`);
              resolve(true);
            } else {
              const errorMessage = `${data?.[0]} ${data?.[1]}> ${data?.[2]}`;
              log.log(`Unable to cancel all ${orderIds?.length} orders (${orderIds}) on ${pair_.pairReadable} pair: ${errorMessage || 'No details.'}`);
              resolve(false);
            }
          } catch (e) {
            log.warn(`Error while processing cancelAllOrders(${paramString}, orderIds: ${orderIds}) request: ${e}`);
            resolve(undefined);
          }
        }).catch((err) => {
          log.warn(`API request cancelAllOrders(${paramString}, orderIds: ${orderIds}) of ${utils.getModuleName(module.id)} module failed. ${err}`);
          resolve(undefined);
        });
      });
    },

    /**
     * Get trade details for a market rates
     * @param pair
     * @returns {Promise<unknown>}
     */
    async getRates(pair) {
      const paramString = `pair: ${pair}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        return undefined;
      }

      try {
        const ticker = await bitfinexApiClient.ticker(pair_.pair);

        try {
          if (ticker && ticker[0] !== 'error') {
            return {
              ask: +ticker?.[2],
              bid: +ticker?.[0],
              volume: +ticker?.[7],
              volumeInCoin2: +ticker?.[7] * +ticker?.[6],
              high: +ticker?.[8],
              low: +ticker?.[9],
            };
          } else {
            const errorMessage = `${ticker?.[0]} ${ticker?.[1]}> ${ticker?.[2]}`;
            log.warn(`Request getRates(${paramString}) failed: ${errorMessage}`);
            return undefined;
          }
        } catch (e) {
          log.warn(`Error while processing getRates(${paramString}) request: ${e}`);
          return undefined;
        }
      } catch (err) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}`);
        return undefined;
      }
    },

    /**
     * Places an order
     * @param {String} orderType
     * @param {String} pair
     * @param {Number} price
     * @param {Number} coin1Amount
     * @param {Number} limit
     * @param {Number} coin2Amount
     * @returns {Promise<unknown>|undefined}
     */
    placeOrder(orderType, pair, price, coin1Amount, limit = 1, coin2Amount) {
      const paramString = `orderType: ${orderType}, pair: ${pair}, price: ${price}, coin1Amount: ${coin1Amount}, limit: ${limit}, coin2Amount: ${coin2Amount}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        message = `Unable to place an order on ${exchangeName} exchange. Unable to parse market ${pair}.`;
        log.warn(message);
        return {
          message,
        };
      }

      let output = '';
      let message;
      const order = {};

      if (!coin1Amount && coin2Amount && price) { // for Limit orders, calculate coin1Amount if only coin2Amount is provided
        coin1Amount = coin2Amount / price;
      }

      if (!this.marketInfo(pair)) {
        message = `Unable to place an order on ${exchangeName} exchange. I don't have info about market ${pair}.`;
        log.warn(message);
        return {
          message,
        };
      }

      if (coin1Amount) {
        coin1Amount = +(+coin1Amount).toFixed(this.marketInfo(pair).coin1Decimals);
      }
      if (coin2Amount) {
        coin2Amount = +(+coin2Amount).toFixed(this.marketInfo(pair).coin2Decimals);
      }
      if (price) {
        price = +(+price).toPrecision(priceSignificantDigits);
      }

      if (limit) { // Limit order
        output = `${orderType} ${coin1Amount} ${pair_.coin1.toUpperCase()} at ${price} ${pair_.coin2.toUpperCase()}.`;

        return new Promise((resolve) => {
          bitfinexApiClient.addOrder(pair_.pair, coin1Amount, String(price), orderType, 'EXCHANGE LIMIT').then((data) => {
            try {
              if (data && data[0] !== 'error') {
                const orderId = String(data[4]?.[0]?.[0]);
                message = `Order placed to ${output} Order Id: ${orderId}.`;
                log.info(message);
                order.orderId = orderId;
                order.message = message;
                resolve(order);
              } else {
                const details = data?.[2] ? ` Details> ${data?.[1]} ${utils.trimAny(data?.[2], ' .')}.` : ' { No details }.';
                message = `Unable to place order to ${output}${details} Check parameters and balances.`;
                log.warn(message);
                order.orderId = false;
                order.message = message;
                resolve(order);
              }
            } catch (e) {
              message = `Error while processing placeOrder(${paramString}) request: ${e}`;
              log.warn(message);
              order.orderId = false;
              order.message = message;
              resolve(order);
            }
          }).catch((err) => {
            log.log(`API request Bitfinex.addOrder-limit(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}.`);
            resolve(undefined);
          });
        });
      }

      if (coin2Amount) {
        output = `${orderType} ${pair_.coin1.toUpperCase()} for ${coin2Amount} ${pair_.coin2.toUpperCase()} at Market Price on ${pair} market.`;
      } else {
        output = `${orderType} ${coin1Amount} ${pair_.coin1.toUpperCase()} at Market Price on ${pair} market.`;
      }

      return new Promise((resolve) => {
        bitfinexApiClient.addOrder(pair_.pair, coin1Amount, undefined, orderType, 'EXCHANGE MARKET').then((data) => {
          try {
            if (data && data[0] !== 'error') {
              const orderId = String(data[4]?.[0]?.[0]);
              message = `Order placed to ${output} Order Id: ${orderId}.`;
              log.info(message);
              order.orderId = orderId;
              order.message = message;
              resolve(order);
            } else {
              const details = data?.[2] ? ` Details> ${data?.[1]} ${utils.trimAny(data?.[2], ' .')}.` : ' { No details }.';
              message = `Unable to place order to ${output}${details} Check parameters and balances.`;
              log.warn(message);
              order.orderId = false;
              order.message = message;
              resolve(order);
            }
          } catch (e) {
            message = `Error while processing placeOrder(${paramString}) request: ${e}`;
            log.warn(message);
            order.orderId = false;
            order.message = message;
            resolve(order);
          }
        }).catch((err) => {
          log.log(`API request Bitfinex.addOrder-market(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}.`);
          resolve(undefined);
        });
      });
    },


    /**
     * Get trades history
     * @param {String} pair
     * @param {Number} limit
     * @returns {Promise<unknown>}
     */
    async getTradesHistory(pair, limit) {
      const paramString = `pair: ${pair}, limit: ${limit}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        return undefined;
      }

      try {
        const trades = await bitfinexApiClient.getTradesHistory(pair_.pair, limit);

        try {
          if (trades && trades[0] !== 'error') {
            const result = [];
            trades.forEach((trade) => {
              result.push({
                coin1Amount: Math.abs(trade?.[2]), // amount in coin1
                price: +trade?.[3], // trade price
                coin2Amount: Math.abs(trade?.[2]) * +trade?.[3], // quote in coin2
                date: trade?.[1], // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
                type: +trade?.[2] > 0 ? 'buy' : 'sell', // 'buy' or 'sell'
                tradeId: trade?.[0]?.toString(),
              });
            });

            // We need ascending sort order
            result.sort((a, b) => {
              return parseFloat(a.date) - parseFloat(b.date);
            });

            return result;
          } else {
            const errorMessage = `${trades?.[0]} ${trades?.[1]}> ${trades?.[2]}`;
            log.warn(`Request getTradesHistory(${paramString}) failed: ${errorMessage}`);
            return undefined;
          }
        } catch (e) {
          log.warn(`Error while processing getTradesHistory(${paramString}) request: ${e}`);
          return undefined;
        }
      } catch (e) {
        log.log(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${e}.`);
        return undefined;
      }
    },

    /**
     * Get market depth
     * @param {String} pair
     * @returns {Promise<unknown>}
     */
    async getOrderBook(pair) {
      const paramString = `pair: ${pair}`;

      const pair_ = formatPairName(pair);
      if (!pair_) {
        return undefined;
      }

      try {
        const book = await bitfinexApiClient.orderBook(pair_.pair);

        if (!book) {
          log.warn(`API request getOrderBook(pair: ${pair}) of ${utils.getModuleName(module.id)} module failed: order book is ${book}.`);
          return false;
        }

        try {
          if (book && book[0] !== 'error') {
            const result = {
              bids: [],
              asks: [],
            };

            book.forEach((crypto) => {
              if (crypto[2] > 0) {
                result.bids.push({
                  amount: +crypto[2],
                  price: +crypto[1],
                  count: 1,
                  type: 'bid-buy-left',
                });
              } else {
                result.asks.push({
                  amount: -crypto[2],
                  price: +crypto[1],
                  count: 1,
                  type: 'ask-sell-right',
                });
              }
            });

            result.asks.sort((a, b) => {
              return parseFloat(a.price) - parseFloat(b.price);
            });

            result.bids.sort((a, b) => {
              return parseFloat(b.price) - parseFloat(a.price);
            });

            return result;
          } else {
            const errorMessage = `${book?.[0]} ${book?.[1]}> ${book?.[2]}`;
            log.warn(`Request orderBook(${paramString}) failed: ${errorMessage}`);
            return undefined;
          }
        } catch (e) {
          log.warn(`Error while processing orderBook(${paramString}) request: ${e}`);
          return undefined;
        }
      } catch (e) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${e}`);
        return undefined;
      }
    },

    /**
     * Get deposit address for exact currency
     * @param {String} coin Familiar coin ticker as 'USDT'
     * @returns {Promise<unknown>}
     */
    async getDepositAddress(coin) {
      const paramString = `coin: ${coin}`;

      try {
        coin = coin?.toUpperCase();
        const coinBitfinex = this.currencyInfo(coin);

        const networks = coinBitfinex.networks;

        let message;
        if (!networks) {
          message = `Unable to get networks for ${coin}.`;
          log.warn(message);
          return false;
        }

        const depositAddresses = [];
        const networkNames = Object.keys(networks);

        for (const network of networkNames) {
          const data = await bitfinexApiClient.getDepositAddress(networks[network].methodName);

          if (data && data[0] !== 'error') {
            depositAddresses.push({
              network: `${network} (${data[4]?.[1]})`,
              address: data[4]?.[4],
            });
          } else {
            const details = data?.[2] ? `${utils.trimAny(data?.[2], ' .')}.` : '{ No details }.';
            message = `Unable to get deposit address for ${coinBitfinex}. Details> ${details}`;
            log.warn(message);
          }
        }

        return depositAddresses;
      } catch (e) {
        log.warn(`Error while processing getDepositAddress(${paramString}) request: ${e}`);
        return undefined;
      }
    },

    async getFees(coinOrPair) {
      const paramString = `coinOrPair: ${coinOrPair}`;

      let pair_; let coin;
      if (coinOrPair?.includes('/')) {
        pair_ = formatPairName(coinOrPair);
      } else {
        coin = this.currencyInfo(coinOrPair)?.apiSymbol?.toUpperCase();
      }

      const symbols = [];
      if (coin) {
        Object.values(module.exports.exchangeMarkets).forEach((pair) => {
          if (pair.coin1 === coin) {
            symbols.push(`${pair.coin1}-${pair.coin2}`.toUpperCase());
          }
        });
      }

      const result = [];

      try {
        const feeRates = await bitfinexApiClient.getFees();
        const makerRate = +feeRates?.[4]?.[0]?.[0];
        const takerRate = +feeRates?.[4]?.[1]?.[2];
        const takerRateCrypto = +feeRates?.[4]?.[1]?.[0];
        const takerRateStable = +feeRates?.[4]?.[1]?.[1];

        // For a single pair
        if (pair_?.pair) {
          result.push({
            pair: coinOrPair.toUpperCase(),
            makerRate,
            takerRate,
            takerRateCrypto,
            takerRateStable,
          });
        } else {
          for (const symbol of symbols) {
            result.push({
              pair: symbol.replace('-', '/'),
              makerRate,
              takerRate,
              takerRateCrypto,
              takerRateStable,
            });
          }
        }
      } catch (err) {
        log.log(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}.`);
        return undefined;
      }

      return result;
    },

    /**
     * Transfer funds between exchange account types. See features().accountTypes[].
     * @param {String} coin Coin to transfer
     * @param {String} from Account to transfer from
     * @param {String} to Account to transfer to
     * @param {Number} amount Quantity to transfer
     * @returns {Object<Boolean, String>} Request results
     */
    async transfer(coin, from, to, amount) {
      const paramString = `coin: ${coin}, from: ${from}, to: ${to}, amount: ${amount}`;

      try {
        const coinApiSymbol = getCurrencies(coin)?.apiSymbol;
        const result = await bitfinexApiClient.transferFunds(coinApiSymbol, from, to, amount);

        if (result && result[0] !== 'error') {
          const transfer = result[4];
          if (transfer) {
            log.log(`Transferred ${amount} ${coin} from ${from}-account to ${to}-account.`);
            return {
              success: true,
              error: null,
            };
          }
        } else {
          const errorMessage = `${result?.[0]} ${result?.[1]}> ${result?.[2]}`;
          log.warn(`Unable to transfer funds from ${from}-account to ${to}-account: ${errorMessage}.`);
          return {
            success: false,
            error: errorMessage,
          };
        }
      } catch (e) {
        log.warn(`API request transfer(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${e}`);
        return {
          success: false,
          error: e,
        };
      }
    },

    /**
     * Get transfers (deposits/withdrawals) history
     * @param {String} coin Filter by coin, optional
     * @param {Number} limit Limit records, optional
     * @returns {Promise<{success: boolean, error: string}|{result: *[], success: boolean}>}
     */
    async getTransfersHistory(coin, limit) {
      const paramString = `coin: ${coin}, limit: ${limit}`;

      try {
        const coinApiSymbol = getCurrencies(coin)?.apiSymbol;
        const records = await bitfinexApiClient.getTransfersHistory(coinApiSymbol);
        const result = [];

        if (records && records[0] !== 'error') {
          records.forEach((record) => {
            result.push({
              id: record[0].toString(), // Movement identifier
              currencySymbol: getCurrencies(record[1])?.symbol,
              currencyName: record[2], // The extended name of the currency (ex. "BITCOIN")
              quantity: record[12], // Amount not including fees
              cryptoAddress: record[16],
              fundsTransferMethodId: null,
              cryptoAddressTag: null,
              txId: record[20],
              fee: Math.abs(record[13]), // Tx Fees applied
              confirmations: null,
              updatedAt: record[6], // Movement last updated at
              createdAt: record[5], // Movement started at
              status: record[9],
              source: null,
              accountId: null,
              chain: null,
              chainPlain: null,
              userNote: record[21], // Optional personal withdraw transaction note
            });
          });

          return {
            success: true,
            result,
          };
        } else {
          const errorMessage = `${records?.[0]} ${records?.[1]}> ${records?.[2]}`;
          log.warn(`Request getTransfersHistory(${paramString}) failed: ${errorMessage}`);

          return {
            success: false,
            error: errorMessage,
          };
        }
      } catch (err) {
        log.log(`API request getTransfersHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}.`);

        return {
          success: false,
          error: err,
        };
      }
    },

    /**
     * Get deposit history
     * @param {String} coin Filter by coin, optional
     * @param {Number} limit Limit records, optional
     * @returns {Promise<{success: boolean, error: string}|{result: *[], success: boolean}>}
     */
    async getDepositHistory(coin, limit) {
      const deposits = await this.getTransfersHistory(coin, limit);

      if (deposits?.success) {
        // Amount of funds moved (positive for deposits, negative for withdrawals)
        deposits.result = deposits.result.filter((record) => record.quantity > 0);
        deposits.result.slice(0, limit);
      }
      return deposits;
    },

    /**
     * Get withdrawal history
     * @param {String} coin Filter by coin, optional
     * @param {Number} limit Limit records, optional
     * @returns {Promise<{success: boolean, error: string}|{result: *[], success: boolean}>}
     */
    async getWithdrawalHistory(coin, limit) {
      const withdrawals = await this.getTransfersHistory(coin, limit);

      if (withdrawals?.success) {
        // Amount of funds moved (positive for deposits, negative for withdrawals)
        withdrawals.result = withdrawals.result.filter((record) => record.quantity < 0);
        withdrawals.result.forEach((record) => record.quantity = Math.abs(record.quantity));
        withdrawals.result = withdrawals.result.slice(0, limit);
      }

      return withdrawals;
    },

    /**
     * Withdraw coin from Bitfinex
     * @param { String } address Crypto address to withdraw funds to
     * @param { Number } amount Quantity to withdraw. Fee to be added, if provided.
     * @param { String } coin In usual format as USDT for Bitfinex's UST
     * @param { Number } withdrawalFee Not used, it will be added by exchange
     * @param { String } network For Bitfinex it's called 'method'
     * @return {Promise<Object>} Withdrawal details
     */
    async withdraw(address, amount, coin, withdrawalFee, network) {
      const paramString = `address: ${address}, amount: ${amount}, coin: ${coin}, withdrawalFee: ${withdrawalFee}, network: ${network}`;

      const decimals = getCurrencies(coin)?.decimals || constants.DEFAULT_WITHDRAWAL_PRECISION;
      if (decimals) amount = +amount.toFixed(decimals);

      try {
        const result = await bitfinexApiClient.addWithdrawal(null, address, amount, network);

        if (result && result[0] !== 'error') {
          const withdrawalInfo = result[4]; // [ WITHDRAWAL_ID, _PH, METHOD, PAYMENT_ID, WALLET, AMOUNT, _PH, _PH, WITHDRAWAL_FEE ]

          if (withdrawalInfo[0]) {
            return {
              success: true,
              result: {
                id: withdrawalInfo[0],
                currency: coin,
                amount: +withdrawalInfo[5],
                address,
                withdrawalFee: +withdrawalInfo[8],
                status: null,
                date: result?.[0],
                target: null,
                network: withdrawalInfo[2],
                payment_id: withdrawalInfo[4],
                wallet: withdrawalInfo[5],
                note: result[7],
              },
            };
          } else {
            return {
              success: false,
              error: result[7] || 'No details',
            };
          }
        } else {
          const errorMessage = `${result?.[0]} ${result?.[1]}> ${result?.[2]}`;
          log.warn(`Request withdraw(${paramString}) failed: ${errorMessage}`);

          return {
            success: undefined,
            error: errorMessage,
          };
        }
      } catch (err) {
        log.warn(`API request withdraw(${paramString}}) of ${utils.getModuleName(module.id)} module failed. ${err}`);

        return {
          success: undefined,
          error: err,
        };
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
    ETH: _networks['ERC20'].code,
    TRX: _networks['TRC20'].code,
    AVAXC: _networks['AVAX-C-CHAIN'].code,
    MATICM: _networks['MATIC'].code,
    SOL: _networks['SOL'].code,
    EOS: _networks['EOS'].code,
  };

  return networksNameMap[network?.toUpperCase()] || network;
}
