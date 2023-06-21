/**
 * Optimal ladder/grid trade strategy, when a bot places many orders to buy and sell tokens with prices starting from the spread.
 * When closest to spread order is filled, a bot adds the same order to the opposite side,
 * following the rule "buy lower than you sell, and sell higher than you buy". It works best on volatile market.
 */

const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const config = require('../modules/configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('./settings/tradeParams_' + config.exchange);
const traderapi = require('./trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);
const db = require('../modules/DB');
const orderUtils = require('./orderUtils');
const orderCollector = require('./orderCollector');

let lastNotifyBalancesTimestamp = 0;
let lastNotifyPriceTimestamp = 0;

const NOTIFY_BALANCE_INDEX_PERCENT = 33; // Don't notify 'Not enough balance' when ~ placing ld-orders with index greater than 3 out of 10 — a bot still has coins to place closest to spread orders
const AMOUNT_DEVIATION = 0.02; // 2% random factor
const INTERVAL_MIN = 10000;
const INTERVAL_MAX = 15000;

let isPreviousIterationFinished = true;

module.exports = {
  readableModuleName: 'Ladder',

  run() {
    this.iteration();
  },

  async iteration() {
    const interval = setPause();
    if (
      interval &&
      tradeParams.co_isActive &&
      tradeParams.co_strategy === 'ld'
    ) {
      if (isPreviousIterationFinished) {
        isPreviousIterationFinished = false;
        await this.buildLadder();
        isPreviousIterationFinished = true;
      } else {
        log.log(`Ladder: Postponing iteration of the ladder builder for ${interval} ms. Previous iteration is in progress yet.`);
      }
      setTimeout(() => {
        this.iteration();
      }, interval);
    } else {
      setTimeout(() => {
        this.iteration();
      }, 3000); // Check for config.co_isActive every 3 seconds
    }
  },

  /**
   * Main part of Ladder module
   */
  async buildLadder() {
    try {
      const coin1Decimals = orderUtils.parseMarket(config.pair).coin1Decimals;
      const coin2Decimals = orderUtils.parseMarket(config.pair).coin2Decimals;

      const { ordersDb } = db;
      let ladderOrders = await ordersDb.find({
        isProcessed: false,
        purpose: 'ld', // ld: ladder order
        pair: config.pair,
        exchange: config.exchange,
      });

      // Ladder re-initialization: purge all the orders

      if (tradeParams.mm_ladderReInit) {
        log.log(`Ladder: User re-initialized the ladder. Purging ${ladderOrders.length} orders…`);

        ladderOrders = await this.closeLadderOrders(ladderOrders, 'User re-initialized a ladder');

        if (ladderOrders.length === 0) {
          log.log('Ladder: Re-initialized the ladder successfully. Ready to build the new one.');

          tradeParams.mm_ladderReInit = false;
          utils.saveConfig();
        } else {
          log.warn(`Ladder: Unable to purge all of the previous ladder orders while re-initializing. Still ${ladderOrders.length} orders opened. Will try again.`);
        }

        return;
      }

      // Update ladder orders. Not existed on exchange orders are not removed from the ordersDb.

      ladderOrders = await orderUtils.updateOrders(ladderOrders, config.pair, utils.getModuleName(module.id) + ':ld-',
          undefined, undefined, false); // Update ld-order statuses

      // Close ld-orders in To be removed state. Make sure we close all of them.

      ladderOrders = await this.closeLadderOrders(ladderOrders);

      const toBeRemovedLadderOrders = ladderOrders.filter((order) => order.ladderState === 'To be removed');
      if (toBeRemovedLadderOrders.length !== 0) {
        log.warn('Ladder: Unable to purge all of the ld-orders in To be removed state. Breaking this iteration and will try in the next one.');
        return;
      }

      const outOfRangeLadderOrders = ladderOrders.filter(
          (order) => (order.ladderIndex < 0 || order.ladderIndex > tradeParams.mm_ladderCount - 1),
      );
      if (outOfRangeLadderOrders.length !== 0) {
        log.warn('Ladder: Unable to purge all of the out-of-range ld-orders. Breaking this iteration and will try in the next one.');
        return;
      }


      // Main ld-orders update cycle. Fills the ladder with orders.

      const maxFilledOrderIndex = {};
      const filledOrderPrices = {};

      for (const type of ['buy', 'sell']) {
        let previousOrder;
        let previousOrderInitialState;
        filledOrderPrices[type] = {};

        for (let index = 0; index < tradeParams.mm_ladderCount; index++) {
          const order = ladderOrders.find((order) => order.type === type && order.ladderIndex === index);
          const criticalErrorString = `Stopped building ${type}-ladder on the ${index + 1} of ${tradeParams.mm_ladderCount} order because of critical error`;

          if (order?.ladderState === 'Filled') {
            // Check if the order is truly Filled

            const orderInfo = `${utils.inclineNumber(index)} ${type} ld-order ${order._id} @${order.price} ${config.coin2}`;

            let isOrderFilledByApi = false;
            let isOrderNotFilledByApi = false;

            // If available, use getOrderDetails()

            if (traderapi.getOrderDetails) {
              const orderDetails = await traderapi.getOrderDetails(order._id, order.pair);
              const orderStatus = orderDetails?.status;

              if (!orderStatus) {
                isOrderFilledByApi = ['part_filled', 'filled'].includes(orderStatus);
                isOrderNotFilledByApi = !isOrderFilledByApi;
              } else {
                log.warn(`Ladder: Unable to receive ${orderInfo} status. Request result is ${JSON.stringify(orderDetails)}.`);
              }
            }

            if (isOrderFilledByApi || [constants.LADDER_PREVIOUS_FILLED_ORDER_STATES].includes(previousOrderInitialState)) {
              // Verified that the order is filled

              maxFilledOrderIndex[type] = index;
              filledOrderPrices[type][index] = order.price;

              // Mark cross-type order as To be removed

              const crossTypeOrderIndexToRemove = tradeParams.mm_ladderCount - 1 - index;
              const crossTypeOrderToRemove = ladderOrders.find((order) =>
                order.type === orderUtils.crossType(type) && order.ladderIndex === crossTypeOrderIndexToRemove);

              let updateCrossTypeOrderStateString;
              const crossTypeOrderString = `Cross-type (${orderUtils.crossType(type)}) ld-order with index ${crossTypeOrderIndexToRemove}`;

              if (crossTypeOrderToRemove) {
                updateCrossTypeOrderStateString = updateLadderState(crossTypeOrderToRemove, 'To be removed');
                if (updateCrossTypeOrderStateString) {
                  updateCrossTypeOrderStateString = `${crossTypeOrderString} ${updateCrossTypeOrderStateString}.`;
                }

                crossTypeOrderToRemove.update({
                  ladderCrossOrderId: order._id,
                  ladderCrossOrderIndex: index,
                  ladderCrossOrderType: type,
                  ladderCrossOrderPrice: order.price,
                });

                await crossTypeOrderToRemove.save();
              } else {
                updateCrossTypeOrderStateString = `${crossTypeOrderString} wasn't found.`;
              }

              const isFilledViaApiString = isOrderFilledByApi ? 'Exchange\'s API described the order as filled.' : 'No evidence that the order is not filled.';
              let filledMessage = `Considering ${utils.inclineNumber(index)} ld-order ${order._id} to ${type}`;
              filledMessage += ` ${(order.coin1AmountInitial || order.coin1Amount).toFixed(coin1Decimals)} ${config.coin1} for ${order.coin2Amount.toFixed(coin2Decimals)} ${config.coin2}`;
              filledMessage += ` @${order.price.toFixed(coin2Decimals)} ${config.coin2} as filled: ${isFilledViaApiString} ${updateCrossTypeOrderStateString}`;

              notify(`${config.notifyName}: ${filledMessage}`, 'log');
            } else {
              // Consider the order is not filled; it's Missed

              let updateStateString = updateLadderState(order, 'Missed');
              updateStateString = ` Its ${updateStateString}, it will be re-created.`;

              const isNotFilledViaApiString = isOrderNotFilledByApi ? 'Exchange\'s API described the order as not filled.' : 'Ld-order with lower index is not filled.';

              log.warn(`Ladder: It seems ${orderInfo} is mistakenly marked as filled: ${isNotFilledViaApiString}${updateStateString}`);
              await order.save();
            }
          }

          previousOrderInitialState = order?.ladderState;
          previousOrder = await this.updateLadderOrder(order, previousOrder, type, index);

          if (!previousOrder) {
            log.warn(`Ladder: ${criticalErrorString}/ No previous order received.`);
            break;
          }
        }
      }

      // Include newly placed order and exclude filled (removed)

      ladderOrders = await ordersDb.find({
        isProcessed: false,
        purpose: 'ld', // ld: ladder order
        pair: config.pair,
        exchange: config.exchange,
      });

      // Shift indexes in case of orders filled

      let filledInfoString = '';

      for (const type of ['buy', 'sell']) {
        if (utils.isPositiveOrZeroInteger(maxFilledOrderIndex[type])) {
          for (const order of ladderOrders) {
            order.ladderPreviousIndex = order.ladderIndex;

            if (order.type === type) {
              order.ladderIndex = order.ladderIndex - maxFilledOrderIndex[type] - 1;
            } else {
              order.ladderIndex = order.ladderIndex + maxFilledOrderIndex[type] + 1;
            }

            await order.save();
          }

          filledInfoString += `${maxFilledOrderIndex[type] + 1} ${type} ld-orders filled. `;
        }
      }

      // Set new mm_ladderMidPrice

      const isBuyOrderFilled = utils.isPositiveOrZeroInteger(maxFilledOrderIndex['buy']);
      const isSellOrderFilled = utils.isPositiveOrZeroInteger(maxFilledOrderIndex['sell']);

      if (isBuyOrderFilled || isSellOrderFilled) {
        const mm_ladderMidPriceSaved = tradeParams.mm_ladderMidPrice;

        if (isBuyOrderFilled && isSellOrderFilled) {
          const delta = maxFilledOrderIndex['buy'] - maxFilledOrderIndex['sell'];
          if (delta > 0) {
            tradeParams.mm_ladderMidPrice = filledOrderPrices['buy'][Math.abs(delta) - 1];
          } else if (delta < 0) {
            tradeParams.mm_ladderMidPrice = filledOrderPrices['sell'][Math.abs(delta) - 1];
          } else {
            // = 0, leave the same mm_ladderMidPrice
          }
        } else if (isBuyOrderFilled) {
          tradeParams.mm_ladderMidPrice = filledOrderPrices['buy'][Math.abs(maxFilledOrderIndex['buy'])];
        } else if (isSellOrderFilled) {
          tradeParams.mm_ladderMidPrice = filledOrderPrices['sell'][Math.abs(maxFilledOrderIndex['sell'])];
        }

        if (utils.isPositiveNumber(tradeParams.mm_ladderMidPrice)) {
          tradeParams.mm_ladderMidPriceType = 'Shifted';
          const changeColor = tradeParams.mm_ladderMidPrice > mm_ladderMidPriceSaved ? '🟩' : '🟥';
          filledInfoString += `${changeColor} Mid ladder price changed from ${mm_ladderMidPriceSaved.toFixed(coin2Decimals)} ${config.coin2} to ${tradeParams.mm_ladderMidPrice.toFixed(coin2Decimals)} ${config.coin2}.`;
        } else {
          tradeParams.mm_ladderMidPrice = mm_ladderMidPriceSaved;
          log.warn(`Ladder: Unexpected new Mid ladder price: ${tradeParams.mm_ladderMidPrice}. Keeping ${mm_ladderMidPriceSaved} ${config.coin2} value.`);
        }

        utils.saveConfig();
      }

      // Notify about changes

      if (filledInfoString) {
        notify(`${config.notifyName}: ${filledInfoString}`, 'info');
      }

      // Log ld-orders with their types info after update

      let ladderOrdersByState = '';
      constants.LADDER_STATES.forEach((state) => {
        const ladderOrdersWithState = ladderOrders.filter((order) => order.ladderState === state);
        if (ladderOrdersWithState.length) {
          ladderOrdersByState += `${state}: ${ladderOrdersWithState.length}, `;
        }
      });
      ladderOrdersByState = utils.trimAny(ladderOrdersByState, ', ');

      if (ladderOrdersByState) {
        ladderOrdersByState = ' -> ' + ladderOrdersByState;
      }

      log.log(`Ladder: ${ladderOrders.length} ld-orders stored${ladderOrdersByState}.`);
    } catch (e) {
      log.error(`Error in buildLadder() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  },

  /**
   * Closes ld-orders:
   * - In To be removed state
   * - All ld-orders if closeAllOrdersReason provided
   * @param {Array<Object>} ldOrders Ladder orders from the DB
   * @param {String} closeAllOrdersReason To close all the ld-orders, tell a reason
   * @return {Array of Object} Updated order list, removed orders excluded
   */
  async closeLadderOrders(ldOrders, closeAllOrdersReason) {
    let toBeRemovedCount = 0;
    let removedCount = 0;

    const updatedLdOrders = [];

    for (const order of ldOrders) {
      try {
        let reasonToClose = ''; const reasonObject = {};

        if (closeAllOrdersReason) {
          reasonToClose = closeAllOrdersReason;
        } else if (order.ladderState === 'To be removed') {
          reasonToClose = `Cross-type (${order.ladderCrossOrderType}) ld-order @${order.ladderCrossOrderPrice} ${config.coin2} with index ${order.ladderCrossOrderIndex} is filled for this ${order.type} ${utils.inclineNumber(order.ladderIndex)} ld-order @${order.price} ${config.coin2}`;
        } else if (order.ladderIndex < 0 || order.ladderIndex > tradeParams.mm_ladderCount - 1) {
          reasonToClose = `Ld-order to ${order.type} @${order.price} ${config.coin2} index ${order.ladderIndex} is out of [0, ${tradeParams.mm_ladderCount - 1}] range`;
        }

        if (reasonToClose) {
          toBeRemovedCount++;

          const cancellation = await orderCollector.clearOrderById(
              order, order.pair, order.type, this.readableModuleName, reasonToClose, reasonObject, traderapi);

          if (cancellation.isCancelRequestProcessed) {
            removedCount++;

            let updateStateString = updateLadderState(order, 'Removed');
            updateStateString = ` Its ${updateStateString}.`;

            log.log(`Ladder: Closed ${utils.inclineNumber(order.ladderIndex)} ${order.type} ld-order ${order._id} @${order.price} ${config.coin2}.${updateStateString}`);

            await order.save();
          } else {
            updatedLdOrders.push(order);
          }
        } else {
          updatedLdOrders.push(order);
        }
      } catch (e) {
        log.error(`Error in closeLadderOrders() of ${utils.getModuleName(module.id)} module: ${e}`);
      }
    }

    if (toBeRemovedCount) {
      log.log(`Ladder: Closed ${removedCount} of ${toBeRemovedCount} ld-orders in To be removed state or with out-of-range index. Total ladder orders: ${ldOrders.length}⟶${updatedLdOrders.length}.`);
    }

    return updatedLdOrders;
  },

  /**
   * Updates a ladder order depending on its state:
   * - Not placed, Cancelled, Missed, undefined -> Place new order
   * - Open, Partly filled, To be removed, Removed -> Nothing
   * - Filled -> Mark as executed and processed. There will be no ld-order with its ID.
   * @param {Object} order If order is already in ordersDB
   * @param {Object} previousOrder Order with previous ladder index
   * @param {String} type 'buy' or 'sell'
   * @param {Number} index Ladder order index of the type
   * @return {Object} Created or Updated orderDb object
   */
  async updateLadderOrder(order, previousOrder, type, index) {
    const paramString = `order: ${order}, previousOrder: ${previousOrder}, type: ${type}, index: ${index}`;

    try {
      const price = order?.price || setPrice(previousOrder?.price || tradeParams.mm_ladderMidPrice, type);

      switch (order?.ladderState) {
        case undefined:
        case 'Not placed':
        case 'Cancelled':
        case 'Missed':
          order = await this.placeLadderOrder(order, price, type, index);
          break;
        case 'Open':
        case 'Partly filled':
        case 'To be removed':
        case 'Removed':
          log.log(`Ladder: ${utils.inclineNumber(order.ladderIndex)} ${order.type} ld-order ${order._id} @${order.price} ${config.coin2} is in ${order.ladderState} state. Skipping.`);
          break;
        case 'Filled':
          await order.update({
            isProcessed: true,
            isExecuted: true,
          }, true);
          log.log(`Ladder: Removed filled ${utils.inclineNumber(order.ladderIndex)} ${order.type} ld-order ${order._id} @${order.price} ${config.coin2} from the ordersDb.`);
          break;
        default:
          break;
      }

      return order;
    } catch (e) {
      log.error(`Error in updateLadderOrder${paramString}) of ${utils.getModuleName(module.id)} module: ${e}`);
    }
  },

  /**
   * Places a new ladder order
   * It may replace already existed order
   * @param {Object} order If already exists
   * @param {Number} price Order price
   * @param {String} type 'buy' or 'sell'
   * @param {Number} index Ladder order index of the type
   * @return {Object} Created or Updated orderDb object
   */
  async placeLadderOrder(order, price, type, index) {
    const paramString = `order: ${order}, price: ${price}, type: ${type}, index: ${index}`;

    const { ordersDb } = db;
    let newOrder = {};

    let actionString = '';

    try {
      const coin1Decimals = orderUtils.parseMarket(config.pair).coin1Decimals;
      const coin2Decimals = orderUtils.parseMarket(config.pair).coin2Decimals;
      let coin1Amount; let coin2Amount;

      if (order) {
        actionString = `Ladder: Updating ${utils.inclineNumber(index)} ${type} ld-order ${order._id} @${order.price} ${config.coin2} in ${ladderStateString(order)} state…`;
        log.log(actionString);

        coin1Amount = order.coin1Amount;
        coin2Amount = order.coin2Amount;

        newOrder = Object.assign(newOrder, order);
        delete newOrder.db;
        delete newOrder._id;
        newOrder.ladderPreviousOrderId = order._id;

        newOrder = new ordersDb(newOrder);
      } else {
        actionString = `Ladder: Creating new ${utils.inclineNumber(index)} ${type} ld-order @${price} ${config.coin2}…`;
        log.log(actionString);

        const amounts = setAmount(price);
        coin1Amount = amounts.coin1Amount;
        coin2Amount = amounts.coin2Amount;

        if (!utils.isPositiveNumber(coin1Amount) || !utils.isPositiveNumber(coin2Amount)) {
          const errorMessage = `Unable to calculate amount for placing ladder order. Check if ${config.coin1} and ${config.coin2} rates are available. Ladder order is not saved.`;

          if (Date.now()-lastNotifyPriceTimestamp > constants.HOUR) {
            notify(`${config.notifyName}: ${errorMessage}`, 'warn');
            lastNotifyPriceTimestamp = Date.now();
          } else {
            log.warn(`Ladder: ${errorMessage}`);
          }

          return false;
        }

        newOrder = new ordersDb({
          // _id: orderReq.orderId,
          date: utils.unixTimeStampMs(),
          purpose: 'ld', // ld: ladder order
          type,
          // targetType: type,
          exchange: config.exchange,
          apikey: config.apikey,
          pair: config.pair,
          coin1: config.coin1,
          coin2: config.coin2,
          price,
          coin1Amount,
          coin2Amount,
          LimitOrMarket: 1, // 1 for limit price. 0 for Market price.
          isProcessed: false,
          isExecuted: false,
          isCancelled: false,
          isClosed: false,
          isVirtual: true, // Doesn't exist on exchange, only in DB
          ladderIndex: index,
        });
      }

      // Check if min order amount met
      const minAmount = orderUtils.getMinOrderAmount(price).min;
      if (coin1Amount < minAmount) {
        order = order || newOrder;

        let updateStateString = updateLadderState(order, 'Not placed', 'Minimal order amount is not met');
        if (updateStateString) {
          updateStateString = ` Ladder order ${updateStateString}.`;
        }

        const errorMessage = `Order amount ${coin1Amount.toFixed(coin1Decimals)} is less, than minimal ${minAmount.toFixed(coin1Decimals)} ${config.coin1}.`;
        log.log(`Ladder: ${errorMessage}${updateStateString}`);

        order.ladderUpdateDate = utils.unixTimeStampMs();
        await order.save();

        return order;
      }

      // Check balances
      const balances = await isEnoughCoins(config.coin1, config.coin2, coin1Amount, coin2Amount, type, index);
      if (!balances.result) {
        order = order || newOrder;

        let updateStateString = updateLadderState(order, 'Not placed', 'Not enough balances');
        if (updateStateString) {
          updateStateString = ` Ladder order ${updateStateString}.`;
        }

        if (balances.message) {
          if (
            Date.now()-lastNotifyBalancesTimestamp > constants.HOUR &&
            index < Math.ceil(tradeParams.mm_ladderCount * NOTIFY_BALANCE_INDEX_PERCENT / 100)
          ) {
            notify(`${config.notifyName}: ${balances.message}${updateStateString}`, 'warn', config.silent_mode);
            lastNotifyBalancesTimestamp = Date.now();
          } else {
            log.log(`Ladder: ${balances.message}${updateStateString}`);
          }
        }

        order.ladderUpdateDate = utils.unixTimeStampMs();
        await order.save();

        return order;
      }

      const orderInfo = `${type} ${coin1Amount.toFixed(coin1Decimals)} ${config.coin1} for ${coin2Amount.toFixed(coin2Decimals)} ${config.coin2} at ${price.toFixed(coin2Decimals)} ${config.coin2}`;
      const orderReq = await traderapi.placeOrder(type, config.pair, price, coin1Amount, 1, null);

      if (orderReq?.orderId) {
        newOrder._id = orderReq.orderId;
        newOrder.isVirtual = false;

        let updateStateString = updateLadderState(newOrder, 'Open');
        if (updateStateString) {
          updateStateString = ` Its ${updateStateString}.`;
        }

        log.info(`Ladder: Successfully placed ld-order to ${orderInfo} with ID ${newOrder._id}.${updateStateString}`);
      } else {
        let updateStateString = updateLadderState(newOrder, 'Not placed', 'No order id returned');
        if (updateStateString) {
          updateStateString = ` Its ${updateStateString}.`;
        }

        log.log(`Ladder: Saved ld-order to ${orderInfo}. It was not created on exchange yet: No order id returned.${updateStateString}`);
      }

      newOrder.ladderUpdateDate = utils.unixTimeStampMs();
      await newOrder.save();

      await order?.update({
        isProcessed: true,
        isClosed: true,
        ladderReplacedByOrderId: newOrder._id,
        ladderUpdateDate: utils.unixTimeStampMs(),
      }, true);


      return newOrder;
    } catch (e) {
      log.error(`Error in placeLadderOrder(${paramString}) of ${utils.getModuleName(module.id)} module: ${e}`);
    }
  },
};

/**
 * Checks if enough funds to place ld-order
 * @param {String} coin1 = config.coin1 (base)
 * @param {String} coin2 = config.coin2 (quote)
 * @param {Number} amount1 Amount in coin1 (base)
 * @param {Number} amount2 Amount in coin2 (quote)
 * @param {String} type 'buy' or 'sell'
 * @param {Number} ladderIndex Ladder order index, for logging only
 * @returns {Object<Boolean, String>}
 *  result: if enough funds to place order
 *  message: error message
 */
async function isEnoughCoins(coin1, coin2, amount1, amount2, type, ladderIndex) {
  const coin1Decimals = orderUtils.parseMarket(config.pair).coin1Decimals;
  const coin2Decimals = orderUtils.parseMarket(config.pair).coin2Decimals;

  const balances = await traderapi.getBalances(false);
  let balance1free; let balance2free;
  let balance1freezed; let balance2freezed;
  let isBalanceEnough = true;
  let output = '';

  if (balances) {
    try {
      balance1free = balances.filter((crypto) => crypto.code === coin1)[0]?.free || 0;
      balance2free = balances.filter((crypto) => crypto.code === coin2)[0]?.free || 0;
      balance1freezed = balances.filter((crypto) => crypto.code === coin1)[0]?.freezed || 0;
      balance2freezed = balances.filter((crypto) => crypto.code === coin2)[0]?.freezed || 0;

      if ((!balance1free || balance1free < amount1) && type === 'sell') {
        output = `Not enough balance to place ${amount1.toFixed(coin1Decimals)} ${coin1} ${type} ld-order with ${ladderIndex} index. Free: ${balance1free.toFixed(coin1Decimals)} ${coin1}, frozen: ${balance1freezed.toFixed(coin1Decimals)} ${coin1}.`;
        isBalanceEnough = false;
      }
      if ((!balance2free || balance2free < amount2) && type === 'buy') {
        output = `Not enough balance to place ${amount2.toFixed(coin2Decimals)} ${coin2} ${type} ld-order with ${ladderIndex} index. Free: ${balance2free.toFixed(coin2Decimals)} ${coin2}, frozen: ${balance2freezed.toFixed(coin2Decimals)} ${coin2}.`;
        isBalanceEnough = false;
      }

      return {
        result: isBalanceEnough,
        message: output,
      };

    } catch (e) {
      log.warn(`Ladder: Unable to process balances for placing ld-order with ${ladderIndex} index: ${e}`);
      return {
        result: false,
      };
    }
  } else {
    log.warn(`Ladder: Unable to get balances for placing ld-order with ${ladderIndex} index.`);
    return {
      result: false,
    };
  }
}

/**
 * Calculates ld-order price
 * It ignores Price watcher
 * @param {Number} previousOrderPrice Price of the order with index - 1
 * @param {String} type 'buy' or 'sell'
 * @returns {Number} Order price
*/
function setPrice(previousOrderPrice, type) {
  const ladderPriceStep = tradeParams.mm_ladderPriceStepPercent/100;

  if (type === 'buy') {
    return previousOrderPrice * (1 - ladderPriceStep);
  } else {
    return previousOrderPrice * (1 + ladderPriceStep);
  }
}

/**
 * Sets randomized order amount ±AMOUNT_DEVIATION
 * @param {Number} price Price of the order
 * @returns {Object<Number, Number>} coin1Amount, coin2Amount
*/
function setAmount(price) {
  let coin1Amount;
  let coin2Amount;
  if (tradeParams.mm_ladderAmountCoin === config.coin1) {
    coin1Amount = tradeParams.mm_ladderAmount;
    coin2Amount = coin1Amount * price;
  } else if (tradeParams.mm_ladderAmountCoin === config.coin2) {
    coin2Amount = tradeParams.mm_ladderAmount;
    coin1Amount = coin2Amount / price;
  }

  coin1Amount = utils.randomDeviation(coin1Amount, AMOUNT_DEVIATION);
  coin2Amount = utils.randomDeviation(coin2Amount, AMOUNT_DEVIATION);

  return {
    coin1Amount,
    coin2Amount,
  };
}

/**
 * Sets interval to review ladder orders in ms
 * @returns {Number}
*/
function setPause() {
  let min = INTERVAL_MIN;
  let max = INTERVAL_MAX;

  if (traderapi.features().openOrdersCacheSec) {
    // If open orders if cached (P2PB2B exchange), don't review orders before cache expires
    min = traderapi.features().openOrdersCacheSec * 1000;
    max = min + (INTERVAL_MAX - INTERVAL_MIN);
  }

  return utils.randomValue(min, max, true);
}

/**
 * Creates info string in ladderState (ladderNotPlacedReason) format
 * @param {Object} order orderDb record
 * @returns {String}
*/
function ladderStateString(order) {
  let stateString = '';

  if (order.ladderState) {
    stateString = order.ladderState;

    if (order.ladderNotPlacedReason) {
      stateString += ` (${order.ladderNotPlacedReason})`;
    }
  }

  return stateString;
}

/**
 * Updates an order with a new state
 * @param {Object} order orderDb record
 * @param {String} newState A state to update order to
 * @param {String} newNotPlacedReason An additional state to update order to
 * @returns {String} Update state info
*/
function updateLadderState(order, newState, newNotPlacedReason) {
  let updateStateString = '';

  if (order.ladderState) {
    const isNotPlacedReasonDiffers = order.ladderNotPlacedReason !== newNotPlacedReason;

    if (order.ladderState !== newState || isNotPlacedReasonDiffers) {
      order.ladderPreviousState = order.ladderState;
      order.ladderPreviousNotPlacedReason = order.ladderNotPlacedReason;

      const previousNotPlacedReasonString = isNotPlacedReasonDiffers && order.ladderNotPlacedReason ? ` (${order.ladderPreviousNotPlacedReason})` : '';
      const newNotPlacedReasonString = isNotPlacedReasonDiffers && newNotPlacedReason ? ` (${newNotPlacedReason})` : '';

      updateStateString = `state updated from ${order.ladderPreviousState}${previousNotPlacedReasonString} to ${newState}${newNotPlacedReasonString}`;
    }
  }

  order.ladderState = newState;
  order.ladderNotPlacedReason = newNotPlacedReason;

  return updateStateString;
}
