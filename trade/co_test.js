/**
 * Module to test exchange API
 */

const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const config = require('../modules/config/reader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('./settings/tradeParams_' + config.exchange);
const traderapi = require('./trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);

const db = require('../modules/DB');
const orderUtils = require('./orderUtils');
const orderCollector = require('./orderCollector');

module.exports = {
  readableModuleName: 'Test',

  async test() {
    console.log('==========================');

    // const { ordersDb } = db;
    // const order = await ordersDb.findOne({
    //   _id: 'orderId',
    // });

    // const TraderApi = require('../trade/trader_' + config.exchange);

    // const traderapi3 = TraderApi(config.apikey2, config.apisecret2, config.apipassword2, log);
    // const traderapi2 = require('./trader_' + 'azbit')(config.apikey, config.apisecret, config.apipassword, log);

    // const ob = await traderapi.getOrderBook('DOGE/USD');
    // console.log(ob);

    // const req = await traderapi.getTradesHistory('eth/usdt');
    // console.log(req);

    // setTimeout(() => {
    //   const traderapi = require('./trader_' + 'azbit')(config.apikey, config.apisecret, config.apipassword, log);
    //   console.log(require('./orderUtils').parseMarket('ADM/USDT', 'azbit'));
    // }, 3000);

    // const orderCollector = require('./orderCollector');
    // const cancellation = await orderCollector.clearOrderById(
    //     'order id', config.pair, undefined, 'Testing', 'Sample reason', undefined, traderapi);
    // console.log(cancellation);

    // console.log(await traderapi.cancelAllOrders('BNB/USDT'));
    // console.log(await traderapi.cancelOrder('5d13f3e8-dcb3-4a6d-88c1-16cf6e8d8179', undefined, 'DOGE/USDT'));
    // console.log(await traderapi.cancelOrder('ODM54B-5CJUX-RSUKCK', undefined, 'DOGE/USDT'));
    // console.log(traderapi.features().orderNumberLimit);
  },
};
