const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const config = require('./config/reader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');

const tradeParams = require('../trade/settings/tradeParams_' + config.exchange);
const traderapi = require('../trade/trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);
const orderCollector = require('../trade/orderCollector');
const orderStats = require('../trade/orderStats');
const orderUtils = require('../trade/orderUtils');

const timeToConfirm = 1000 * 60 * 10; // 10 minutes to confirm
const pendingConfirmation = {
  command: '',
  timestamp: 0,
};

const previousBalances = [
  {}, // balances of the first trade account
  {}, // balances of the second trade account
  {}, // sum of balances for both trade accounts
];
/*
  accountNo -> userId -> balances object
  {
    userId: {
      timestamp,
      balances: balances for userId/senderId @timestamp
    }
  }
*/

const previousOrders = [
  {}, // orders of the first trade account
  {}, // orders of the second trade account
];

module.exports = async (commandMsg, tx, itx) => {
  let commandResult = {};

  try {
    const from = tx.senderTgUsername ?
      `${tx.senderTgUsername} (message ${tx.id})` :
      `${tx.senderId} (transaction ${tx.id})`;

    log.log(`Processing '${commandMsg}' command from ${from}…`);

    let group = commandMsg
        .trim()
        .replace(/ {2,}/g, ' ')
        .split(' ');
    let commandName = group.shift().trim().toLowerCase().replace('/', '');

    const alias = aliases[commandName];
    if (alias) {
      log.log(`Alias '${commandMsg}' converted to command '${alias(group)}'`);
      group = alias(group)
          .trim()
          .replace(/ {2,}/g, ' ')
          .split(' ');
      commandName = group.shift().trim().toLowerCase().replace('/', '');
    }

    const command = commands[commandName];

    if (command) {
      commandResult = await command(group, tx, itx?.commandFix); // commandFix if for /help only
    } else {
      commandResult.msgSendBack = `I don’t know */${commandName}* command. ℹ️ You can start with **/help**.`;
    }

    if (commandResult.msgNotify) {
      notify(`${commandResult.msgNotify} Action is executed by ${from}.`, commandResult.notifyType);
    }

    if (itx) {
      await itx.update({ isProcessed: true }, true);
    }

    if (commandName !== 'y') {
      utils.saveConfig(false, `After-commandTxs(/${commandName})`);
    }
  } catch (e) {
    tx = tx || {};

    if (tx.senderTgUsername) {
      log.error(`Error while processing ${commandMsg} command from ${tx.senderTgUsername} (message ${tx.id}). Error: ${e.toString()}`);
    } else {
      log.error(`Error while processing ${commandMsg} command from ${tx.senderId} (transaction ${tx.id}). Error: ${e.toString()}`);
    }
  }

  return commandResult;
};

/**
 * Get pair rates info from an exchange
 * @param {String} pair Trade pair to request
 * @returns {Object} success, exchangeRates, ratesString
 */
async function getRatesInfo(pair) {
  let exchangeRates;
  let ratesString;
  let success;

  try {
    const pairObj = orderUtils.parseMarket(pair);
    const coin2 = pairObj.coin2;
    const coin2Decimals = pairObj.coin2Decimals;

    exchangeRates = await traderapi.getRates(pairObj.pair);

    if (exchangeRates) {
      const delta = exchangeRates.ask-exchangeRates.bid;
      const average = (exchangeRates.ask+exchangeRates.bid)/2;
      const deltaPercent = delta/average * 100;

      ratesString = `${config.exchangeName} rates for ${pair} pair:`;
      ratesString += `\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      if (exchangeRates.last) {
        ratesString += ` Last price: _${(exchangeRates.last).toFixed(coin2Decimals)}_ ${coin2}.`;
      }

      success = true;
    } else {
      ratesString = `Unable to get ${config.exchangeName} rates for ${pairObj.pair}.`;
      success = false;
    }
  } catch (e) {
    log.error(`Error in getRatesString() of ${utils.getModuleName(module.id)} module: ` + e);
    ratesString = `Unable to process ${config.exchangeName} rates for ${pair}.`;
    success = false;
  }

  return {
    success,
    exchangeRates,
    ratesString,
  };
}

/**
 * Set a command to be confirmed
 * @param {String} command This command will be executed with /y
 */
async function setPendingConfirmation(command) {
  try {
    pendingConfirmation.command = command;
    pendingConfirmation.timestamp = Date.now();
    log.log(`Pending command to confirm: ${command}.`);
  } catch (e) {
    log.error(`Error in setPendingConfirmation() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

/**
 * Command to confirm pending command, set with setPendingConfirmation()
 * @param {Array of String} params Doesn't matter
 * @param {Object} tx Information about initiator
 * @return {Object} commandResult.msgSendBack to reply
 */
async function y(params, tx) {
  try {
    if (pendingConfirmation.command) {
      let commandResult = {
        msgNotify: '',
        msgSendBack: '',
        notifyType: 'log',
      };

      if (Date.now() - pendingConfirmation.timestamp > timeToConfirm) {
        commandResult.msgSendBack = `I will not confirm command ${pendingConfirmation.command} as it is expired. Try again.`;
      } else {
        commandResult = await module.exports(`${pendingConfirmation.command} -y`, tx);
        commandResult.msgNotify = ''; // Command itself will notify, we need only msgSendBack
      }

      pendingConfirmation.command = '';

      return commandResult;
    } else {
      return {
        msgNotify: '',
        msgSendBack: 'There is no pending command to confirm.',
        notifyType: 'log',
      };
    }
  } catch (e) {
    log.error(`Error in y()-confirmation of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

/**
 * Start trading
 * @param {String[]} params Strategy and params
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function start(params) {
  const strategy = params[0]?.toLowerCase();

  if (!['ld'].includes(strategy)) {
    return {
      msgNotify: '',
      msgSendBack: 'Indicate strategy, _ld_ for Ladder/ Grid trading. Example: */start ld*.',
      notifyType: 'log',
    };
  }

  let msgNotify; let msgSendBack; let strategyName; let infoString;

  if (strategy === 'ld') {
    // start ld {AMOUNT} {COIN} {COUNT} {STEP%} [mid {MIDPRICE} COIN2]

    const pairObj = orderUtils.parseMarket(config.pair);
    const coin2Decimals = pairObj.coin2Decimals;
    let midPriceCalculated;

    let ratesInfo;

    const exchangeRates = await traderapi.getRates(pairObj.pair);
    if (exchangeRates) {
      const delta = exchangeRates.ask-exchangeRates.bid;
      midPriceCalculated = (exchangeRates.ask+exchangeRates.bid)/2;
      midPriceCalculated = +midPriceCalculated.toFixed(coin2Decimals);
      const deltaPercent = delta/midPriceCalculated * 100;
      ratesInfo = `\n\n${config.exchangeName} rates for ${pairObj.pair} pair:\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(delta).toFixed(coin2Decimals)}_ ${config.coin2} (${(deltaPercent).toFixed(2)}%)`;
    } else {
      return {
        msgNotify: '',
        msgSendBack: `Unable to get ${config.exchangeName} rates for ${pairObj.pair}. Try later.`,
        notifyType: 'log',
      };
    }

    const sampleCommand = `Example: */start ld 100 ${config.coin2} 10 2%*.${ratesInfo}`;

    if (params.length < 5) {
      return {
        msgNotify: '',
        msgSendBack: `Not enough parameters to enable ladder. ${sampleCommand}.`,
        notifyType: 'log',
      };
    }

    const amount = +params[1];
    if (!utils.isPositiveNumber(amount)) {
      return {
        msgNotify: '',
        msgSendBack: `Incorrect amount: ${amount}. ${sampleCommand}.`,
        notifyType: 'log',
      };
    }

    const amountCoin = params[2]?.toUpperCase();
    if (amountCoin !== config.coin1 && amountCoin !== config.coin2) {
      return {
        msgNotify: '',
        msgSendBack: `Set an order volume either in ${config.coin1} or ${config.coin2}. ${sampleCommand}.`,
        notifyType: 'log',
      };
    }

    const orderCount = +params[3];
    if (!utils.isPositiveInteger(orderCount)) {
      return {
        msgNotify: '',
        msgSendBack: `Set correct ld-order count (each side). ${sampleCommand}.`,
        notifyType: 'log',
      };
    }

    const stepPercentParam = params[4];
    let stepPercent;
    if (stepPercentParam) {
      const percentSign = stepPercentParam.slice(-1);
      stepPercent = +stepPercentParam.slice(0, -1);
      if (!utils.isPositiveNumber(stepPercent) || percentSign !== '%') {
        return {
          msgNotify: '',
          msgSendBack: `Set correct ladder step percent. ${sampleCommand}.`,
          notifyType: 'log',
        };
      }
    }

    const sampleCommandFull = `Example: */start ld 100 ${config.coin2} 10 2% mid ${midPriceCalculated.toFixed(coin2Decimals)} ${config.coin2}*.${ratesInfo}`;

    const midString = params[5]?.toLowerCase();
    if (midString && midString !== 'mid' && !['-y', '-Y'].includes(params[5])) {
      return {
        msgNotify: '',
        msgSendBack: `To set a custom middle price, use 'mid'. ${sampleCommandFull}.`,
        notifyType: 'log',
      };
    }

    let midPrice;

    if (midString === 'mid') {
      midPrice = +params[6];
      if (!utils.isPositiveNumber(midPrice)) {
        return {
          msgNotify: '',
          msgSendBack: `Incorrect middle ladder price: ${midPrice}. ${sampleCommandFull}.`,
          notifyType: 'log',
        };
      }

      const midPriceCoin = params[7]?.toUpperCase();
      if (midPriceCoin !== config.coin2) {
        return {
          msgNotify: '',
          msgSendBack: `Set a middle ladder price in ${config.coin2}. ${sampleCommandFull}.`,
          notifyType: 'log',
        };
      }
    } else {
      midPrice = midPriceCalculated;
    }

    strategyName = 'Ladder/ Grid';
    infoString = ` with ${orderCount} ~${amount} ${amountCoin} orders on each side with ${stepPercent}% step, starting from the middle of ${midPrice} ${config.coin2}`;

    let isConfirmed = params[params.length-1];
    if (['-y', '-Y'].includes(isConfirmed)) {
      isConfirmed = true;
    } else {
      isConfirmed = false;
    }

    if (isConfirmed) {
      tradeParams.co_isActive = true;
      tradeParams.co_strategy = strategy;

      tradeParams.mm_ladderReInit = true;
      tradeParams.mm_isLadderActive = true;

      tradeParams.mm_ladderAmount = amount;
      tradeParams.mm_ladderAmountCoin = amountCoin;
      tradeParams.mm_ladderCount = orderCount;
      tradeParams.mm_ladderPriceStepPercent = stepPercent;
      tradeParams.mm_ladderMidPrice = midPrice;
      tradeParams.mm_ladderMidPriceType = midString === 'mid' ? 'Manual' : 'Calculated';
    } else {
      setPendingConfirmation(`/start ${params.join(' ')}`);

      const reInitWarn = tradeParams.mm_isLadderActive ? ' Current ladder will be re-initialized.' : '';

      msgNotify = '';
      msgSendBack = `Are you sure to start ${strategyName} strategy${infoString} on ${config.pair} pair?${reInitWarn} Confirm with **/y** command or ignore.${ratesInfo}`;

      return {
        msgNotify,
        msgSendBack,
        notifyType: 'log',
      };
    }


    msgNotify = `${config.notifyName} started ${strategyName} strategy${infoString} on ${config.pair} pair.`;
    msgSendBack = `Starting ${strategyName} strategy${infoString} on ${config.pair} pair.`;

    return {
      msgNotify,
      msgSendBack,
      notifyType: 'log',
    };
  }
}

/**
 * Start trading
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
function stop() {
  let msgNotify; let msgSendBack;

  if (tradeParams.co_isActive) {
    msgNotify = `${config.notifyName} stopped trading on ${config.pair} pair.`;
    msgSendBack = `Trading on ${config.pair} pair stopped.`;
  } else {
    msgNotify = '';
    msgSendBack = 'Trading is not active.';
  }

  tradeParams.co_isActive = false;

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Enable some option
 * It's a stub
 * @param {String[]} params Option
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function enable(params, {}, isWebApi = false) {
  let msgNotify; let msgSendBack; let infoString; let optionsString;

  try {
    const option = params[0]?.toLowerCase();

    if (!['sample_option'].includes(option)) {
      msgSendBack = 'Indicate option:\n\n_sample_option_ for Sample option.';
      msgSendBack += '\n\nExample: */enable sample_option*.';
      return {
        msgNotify: '',
        msgSendBack,
        notifyType: 'log',
      };
    }

    if (option === 'sample_option') {
      optionsString = 'Sample option';
      infoString = ' with some additional settings';
    }

    msgNotify = `${config.notifyName} enabled ${optionsString}${infoString}.`;
    msgSendBack = `${optionsString} is enabled${infoString}.`;
    if (!tradeParams.co_isActive) {
      msgNotify += ' Trading is not started yet.';
      msgSendBack += ' To start Trading, type */start*.';
    }
  } catch (e) {
    log.error(`Error in enable() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Disable some option
 * It's a stub
 * @param {String[]} params Option
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
function disable(params) {
  let msgNotify; let msgSendBack; let optionsString;

  const option = params[0]?.toLowerCase();

  if (!['sample_option'].includes(option)) {
    msgSendBack = 'Indicate option:\n\n_sample_option_ for Sample option.';
    msgSendBack += '\n\nExample: */enable sample_option*.';
    return {
      msgNotify: '',
      msgSendBack,
      notifyType: 'log',
    };
  }

  if (option === 'sample_option') {
    optionsString = 'Sample option';
  }

  msgNotify = `${config.notifyName} disabled ${optionsString}.`;
  msgSendBack = `${optionsString} is disabled.`;
  if (tradeParams.co_isActive) {
    msgNotify += ' Trading is still active.';
    msgSendBack += ' Trading is still active—to stop it, type */stop*.';
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Close orders
 * @param {String[]} params Order filter: trade pair, 'buy' or 'sell', order type, price
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function clear(params) {
  try {
    let pair = params[0];
    if (!pair || pair.indexOf('/') === -1) {
      pair = config.pair;
    }
    const pairObj = orderUtils.parseMarket(pair);

    let doForce;
    let purposes;
    let purposeString;
    let type;
    let filter;
    let filerPriceString;

    const orderPurposes = utils.cloneObject(orderCollector.orderPurposes);
    delete orderPurposes['all'];

    for (const param of params) {
      if (['buy'].includes(param.toLowerCase())) {
        type = 'buy';
      }
      if (['sell'].includes(param.toLowerCase())) {
        type = 'sell';
      }
      if (['force'].includes(param.toLowerCase())) {
        doForce = true;
      }

      if (['all'].includes(param.toLowerCase())) {
        purposes = 'all';
      }
      if (['unk'].includes(param.toLowerCase())) {
        purposes = 'unk';
        purposeString = 'unknown';
      }

      Object.keys(orderPurposes).forEach((purpose) => {
        if (param.toLowerCase() === purpose) {
          purposes = [purpose];
          purposeString = orderPurposes[purpose]?.toLowerCase();
        }
      });

      if (param.startsWith('>') || param.startsWith('<')) {
        if (['all', 'unk'].includes(purposes)) {
          return {
            msgNotify: '',
            msgSendBack: `Price filter doesn't work with **all** and **unk** orders. Try: */clear mm sell >0.5 ${config.coin2}*.`,
            notifyType: 'log',
          };
        }
        filerPriceString = param;
        let price = param;
        const paramIndex = params.indexOf(param);
        const operator = param.charAt(0);
        price = +price.substring(1);
        if (!utils.isPositiveOrZeroNumber(price)) {
          return {
            msgNotify: '',
            msgSendBack: `Indicate price after '${operator}'. Example: */clear mm sell >0.5 ${config.coin2}*.`,
            notifyType: 'log',
          };
        }
        const priceCoin = params[paramIndex + 1]?.toUpperCase();
        if (priceCoin !== pairObj.coin2) {
          return {
            msgNotify: '',
            msgSendBack: `Price should be in ${pairObj.coin2} for ${pairObj.pair}. Example: */clear ${pairObj.pair} mm sell >0.5 ${pairObj.coin2}*.`,
            notifyType: 'log',
          };
        }
        filter = { };
        if (operator === '<') {
          filter.price = { $lt: price };
        } else {
          filter.price = { $gt: price };
        }
      }
    }

    if (!purposes) {
      return {
        msgNotify: '',
        msgSendBack: 'Specify type of orders to clear. F. e., */clear mm sell*.',
        notifyType: 'log',
      };
    }

    let output = '';
    let clearedInfo = {};
    const typeString = type ? `**${type}**-` : '';

    const api = traderapi;

    if (purposes === 'all') {
      clearedInfo = await orderCollector.clearAllOrders(pairObj.pair, doForce, type, 'User command', `${typeString}orders`, api);
    } else { // Closing orders of specified type only
      let filterString = '';
      if (purposes === 'unk') {
        clearedInfo = await orderCollector.clearUnknownOrders(pairObj.pair, doForce, type, 'User command', `**${purposeString}** ${typeString}orders${filterString}`, api);
      } else {
        if (filter) filterString = ` with price ${filerPriceString} ${config.coin2}`;
        clearedInfo = await orderCollector.clearLocalOrders(purposes, pairObj.pair, doForce, type, filter, 'User command', `**${purposeString}** ${typeString}orders${filterString}`, api);
      }
    }
    output = clearedInfo.logMessage;

    return {
      msgNotify: '',
      msgSendBack: output,
      notifyType: 'log',
    };
  } catch (e) {
    log.error(`Error in clear() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

async function fill(params) {
  const isConfirmed = params.find((param) => ['-y'].includes(param.toLowerCase())) !== undefined;

  let count; let amount; let low; let high; let amountName;
  params.forEach((param) => {
    try {
      if (param.startsWith('count')) {
        count = +param.split('=')[1].trim();
      }
      if (param.startsWith('amount')) {
        amount = +param.split('=')[1].trim();
        amountName = 'amount';
      }
      if (param.startsWith('quote')) {
        amount = +param.split('=')[1].trim();
        amountName = 'quote';
      }
      if (param.startsWith('low')) {
        low = +param.split('=')[1].trim();
      }
      if (param.startsWith('high')) {
        high = +param.split('=')[1].trim();
      }
    } catch (e) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. It works like this: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
        notifyType: 'log',
      };
    }
  });

  if (params.length < 4) {
    return {
      msgNotify: '',
      msgSendBack: 'Wrong arguments. It works like this: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
      notifyType: 'log',
    };
  }

  let output = '';
  let type;

  let pair = params[0];
  if (!pair || pair.indexOf('/') === -1) {
    pair = config.pair;
    type = params[0]?.trim().toLowerCase();
  } else {
    type = params[1]?.trim().toLowerCase();
  }

  if (!['buy', 'sell'].includes(type)) {
    return {
      msgNotify: '',
      msgSendBack: 'Specify _buy_ or _sell_ orders to fill. Example: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
      notifyType: 'log',
    };
  }

  const pairObj = orderUtils.parseMarket(pair);

  if (!amount || !amountName || (type === 'buy' && amountName === 'amount') || (type === 'sell' && amountName === 'quote')) {
    output = 'Buy should follow with _quote_, sell with _amount_.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!count || count === Infinity || count < 1 || count === undefined) {
    output = 'Specify order count.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!high || high === Infinity || high === undefined || !low || low === Infinity || low === undefined) {
    output = 'Specify _low_ and _high_ prices to fill orders.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (low > high) {
    output = 'To fill orders _high_ should be greater than _low_.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  const onWhichAccount = '';

  const balances = await traderapi.getBalances(false);
  let balance;
  let isBalanceEnough = true;
  if (balances) {
    try {
      if (type === 'buy') {
        balance = balances.filter((crypto) => crypto.code === pairObj.coin2)?.[0]?.free || 0;
        output = `Not enough ${pairObj.coin2}${onWhichAccount} to fill orders. Check balances.`;
      } else {
        balance = balances.filter((crypto) => crypto.code === pairObj.coin1)?.[0]?.free || 0;
        output = `Not enough ${pairObj.coin1}${onWhichAccount} to fill orders. Check balances.`;
      }
      isBalanceEnough = balance >= amount;
    } catch (e) {
      output = `Unable to process balances${onWhichAccount}: ${e}. Check parameters.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  } else {
    output = `Unable to get ${config.exchangeName} balances${onWhichAccount}. Try again.`;
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!isBalanceEnough) {
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  let totalUSD;

  if (amountName === 'quote') {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin2, 'USD', amount).outAmount;
  } else {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin1, 'USD', amount).outAmount;
  }

  if (config.amount_to_confirm_usd && totalUSD && totalUSD >= config.amount_to_confirm_usd && !isConfirmed) {
    setPendingConfirmation(`/fill ${params.join(' ')}`);

    const totalUSDstring = utils.formatNumber(totalUSD.toFixed(0), true);

    let confirmationMessage;
    if (amountName === 'quote') {
      confirmationMessage = `Are you sure to fill ${count} orders${onWhichAccount} to ${type} ${pairObj.coin1} worth ~${totalUSDstring} USD priced from ${low} to ${high} ${pairObj.coin2}?`;
    } else {
      confirmationMessage = `Are you sure to fill ${count} orders${onWhichAccount} to ${type} ${amount} ${pairObj.coin1} (worth ~${totalUSDstring} USD) priced from ${low} to ${high} ${pairObj.coin2}?`;
    }
    confirmationMessage += ' Confirm with **/y** command or ignore.';

    return {
      msgNotify: '',
      msgSendBack: confirmationMessage,
      notifyType: 'log',
    };
  }

  // Make order list
  const orderList = [];
  const delta = high - low;
  const step = delta / count;
  const orderAmount = amount / count;
  const deviation = 0.9;

  let price = low;
  let total = 0; let coin1Amount = 0; let coin2Amount = 0;
  for (let i=0; i < count; i++) {
    price += utils.randomDeviation(step, deviation);
    coin1Amount = utils.randomDeviation(orderAmount, deviation);
    total += coin1Amount;

    // Checks if total or price exceeded
    if (total > amount) {
      if (count === 1) {
        coin1Amount = amount;
      } else {
        break;
      }
    }
    if (price > high) {
      if (count === 1) {
        price = high;
      } else {
        break;
      }
    }

    // Count base and quote currency amounts
    if (type === 'buy') {
      coin2Amount = coin1Amount;
      coin1Amount = coin1Amount / price;
    } else {
      // coin1Amount = coin1Amount;
      coin2Amount = coin1Amount * price;
    }
    orderList.push({
      price,
      amount: coin1Amount,
      altAmount: coin2Amount,
    });
  }

  // Place orders
  let total1 = 0; let total2 = 0;
  let placedOrders = 0; let notPlacedOrders = 0;
  let order;
  for (let i = 0; i < orderList.length; i++) {
    order = await orderUtils.addGeneralOrder(type, pairObj.pair, orderList[i].price, orderList[i].amount, 1, null, pairObj, 'man');
    if (order?._id) {
      placedOrders += 1;
      total1 += +orderList[i].amount;
      total2 += +orderList[i].altAmount;
    } else {
      notPlacedOrders += 1;
    }
  }

  let notPlacedString = '';
  if (placedOrders > 0) {
    if (notPlacedOrders) {
      notPlacedString = ` ${notPlacedOrders} orders missed because of errors, check log file for details.`;
    }
    output = `${placedOrders} orders${onWhichAccount} to ${type} ${utils.formatNumber(+total1.toFixed(pairObj.coin1Decimals), false)} ${pairObj.coin1} for ${utils.formatNumber(+total2.toFixed(pairObj.coin2Decimals), false)} ${pairObj.coin2}.${notPlacedString}`;
  } else {
    output = `No orders${onWhichAccount} were placed. Check log file for details.`;
  }

  const msgNotify = placedOrders > 0 ? `${config.notifyName} placed ${output}` : '';
  const msgSendBack = placedOrders > 0 ? `Placed ${output}` : output;

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Place manual 'buy' order
 * @param {String[]} params Order params
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function buy(params) {
  const result = getBuySellParams(params, 'buy');
  return await buy_sell(result, 'buy');
}

/**
 * Place manual 'sell' order
 * @param {String[]} params Order params
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function sell(params) {
  const result = getBuySellParams(params, 'sell');
  return await buy_sell(result, 'sell');
}

/**
 * Get order params f
 * @param {String[]} params Order params
 * @returns {Object}
 */
function getBuySellParams(params, type) {
  const isConfirmed = params.find((param) => ['-y'].includes(param.toLowerCase())) !== undefined;

  // default: pair={config} BaseCurrency/QuoteCurrency, price=market
  // amount XOR quote
  // buy ADM/BTC amount=200 price=0.00000224 — buy 200 ADM at 0.00000224
  // sell ADM/BTC amount=200 price=0.00000224 — sell 200 ADM at 0.00000224
  // buy ADM/BTC quote=0.01 price=0.00000224 — buy ADM for 0.01 BTC at 0.00000224
  // sell ADM/BTC quote=0.01 price=0.00000224 — sell ADM to get 0.01 BTC at 0.00000224

  // when Market order, buy should follow quote, sell — amount
  // buy ADM/BTC quote=0.01 — buy ADM for 0.01 BTC at market price
  // buy ADM/BTC quote=0.01 price=market — the same
  // buy ADM/BTC quote=0.01 — buy ADM for 0.01 BTC at market price
  // sell ADM/BTC amount=8 — sell 8 ADM at market price

  let amount; let quote; let price = 'market';
  params.forEach((param) => {
    try {
      if (param.startsWith('quote')) {
        quote = +param.split('=')[1].trim();
      }
      if (param.startsWith('amount')) {
        amount = +param.split('=')[1].trim();
      }
      if (param.startsWith('price')) {
        price = param.split('=')[1].trim();
        if (price.toLowerCase() === 'market') {
          price = 'market';
        } else {
          price = +price;
        }
      }
    } catch (e) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
        notifyType: 'log',
      };
    }
  });

  if (params.length < 1) {
    return {
      msgNotify: '',
      msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
      notifyType: 'log',
    };
  }

  if ((quote && amount) || (!quote && !amount)) {
    return {
      msgNotify: '',
      msgSendBack: 'You should specify amount _or_ quote, and not both of them.',
      notifyType: 'log',
    };
  }

  const amountOrQuote = quote || amount;

  let output = '';
  if (((!price || price === Infinity || price <= 0) && (price !== 'market')) || (!amountOrQuote || amountOrQuote === Infinity || amountOrQuote <= 0)) {
    output = `Incorrect params: ${amountOrQuote}, ${price}. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (price === 'market' && !traderapi.features().placeMarketOrder) {
    return {
      msgNotify: '',
      msgSendBack: `Placing Market orders on ${config.exchangeName} via API is not supported.`,
      notifyType: 'log',
    };
  }

  // When Market order, buy should pass quote parameter, when sell — amount
  if (price === 'market' && !traderapi.features()?.allowAmountForMarketBuy) {
    if ((type === 'buy' && !quote) || ((type === 'sell' && !amount))) {
      output = 'When placing Market order, buy should follow with _quote_, sell with _amount_. Command works like this: */sell ADM/BTC amount=200 price=market*.';
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  }

  // When Market order, amount in coin1 is necessary for both buy and sell
  if (price === 'market' && traderapi.features()?.amountForMarketOrderNecessary) {
    if (!amount) {
      output = `When placing Market order on ${config.exchangeName}, _amount_ is necessary. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  }

  let pair = params[0];
  if (!pair || pair.indexOf('/') === -1) {
    pair = config.pair;
  }
  const pairObj = orderUtils.parseMarket(pair);

  let totalUSD;

  if (amount) {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin1, 'USD', amount).outAmount;
  } else {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin2, 'USD', quote).outAmount;
  }

  if (config.amount_to_confirm_usd && totalUSD && totalUSD >= config.amount_to_confirm_usd && !isConfirmed) {
    setPendingConfirmation(`/${type} ${params.join(' ')}`);

    let msgSendBack = '';

    const totalUSDstring = utils.formatNumber(totalUSD.toFixed(0), true);
    const amountCalculated = amount ||
      exchangerUtils.convertCryptos(pairObj.coin2, pairObj.coin1, quote).outAmount.toFixed(pairObj.coin1Decimals);

    if (price === 'market') {
      if (amount) {
        msgSendBack += `Are you sure to ${type} ${amountCalculated} ${pairObj.coin1} (worth ~${totalUSDstring} USD) at market price?`;
      } else {
        msgSendBack += `Are you sure to ${type} ${pairObj.coin1} worth ~${totalUSDstring} USD at market price?`;
      }
    } else {
      msgSendBack += `Are you sure to ${type} ${amountCalculated} ${pairObj.coin1} (worth ~${totalUSDstring} USD) at ${price} ${pairObj.coin2}?`;

      const marketPrice = exchangerUtils.convertCryptos(pairObj.coin1, pairObj.coin2, 1).outAmount;
      const priceDifference = utils.numbersDifferencePercentDirectNegative(marketPrice, price);

      if (
        (priceDifference < -30 && type === 'buy') ||
        (priceDifference > 30 && type === 'sell')
      ) {
        msgSendBack += ` **Warning: ${type} price is ${Math.abs(priceDifference).toFixed(0)}% ${marketPrice > price ? 'less' : 'greater'} than market**.`;
      }
    }
    msgSendBack += ' Confirm with **/y** command or ignore.';

    return {
      msgSendBack,
      msgNotify: '',
      notifyType: 'log',
    };
  }

  return {
    amount,
    price,
    quote,
    pairObj,
  };
}

/**
 * Runs an order with params
 * @param {Object} params { amount, price, quote, pairObj } or { msgNotify, msgSendBack, notifyType }
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function buy_sell(params, type) {
  if (params.msgSendBack) {
    return params; // Error info here
  }

  if (!params.amount) {
    params.amount = params.quote / params.price;
  } else {
    params.quote = params.amount * params.price;
  }

  let result; let msgNotify; let msgSendBack;
  if (params.price === 'market') {
    result = await orderUtils.addGeneralOrder(type, params.pairObj.pair, null,
        params.amount, 0, params.quote, params.pairObj, 'man', params.api);
  } else {
    result = await orderUtils.addGeneralOrder(type, params.pairObj.pair, params.price,
        params.amount, 1, params.quote, params.pairObj, 'man', params.api);
  }

  if (result !== undefined) {
    msgSendBack = result.message;
    if (result?._id) {
      msgNotify = `${config.notifyName}: ${result.message}`;
    }
  } else {
    const onWhichAccount = params.api?.isSecondAccount ? ' (on second account)' : '';
    msgSendBack = `Request to place an order${onWhichAccount} with params ${JSON.stringify(params)} failed. It looks like an API temporary error. Try again.`;
    msgNotify = '';
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Shows trading params
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
function params() {
  const settings = JSON.stringify(tradeParams, null, 2);
  const msgSendBack = `I am set to work with ${config.pair} pair on ${config.exchangeName}. Current trading settings: \n\n${settings}`;

  return {
    msgNotify: '',
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Shows help info
 * @param {*} commandFix
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
function help({}, {}, commandFix) {

  let output = 'I am **online** and ready to trade.';
  output += ' See command reference on https://github.com/Adamant-im/adamant-coinoptimus/wiki';
  output += '\nHappy trading!';

  if (commandFix === 'help') {
    output += '\n\nNote: commands starts with slash **/**. Example: **/help**.';
  }

  return {
    msgNotify: '',
    msgSendBack: `${output}`,
    notifyType: 'log',
  };
}

/**
 * Get coin rates
 * @param {String[]} params Coin or trade pair
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function rates(params) {
  let output = '';

  try {
    // if no coin/pair is set, treat it as coin1 set in config
    if (!params[0]) {
      params[0] = config.coin1;
    }

    // if coin1 only, treat it as pair set in config
    if (params[0]?.toUpperCase().trim() === config.coin1) {
      params[0] = config.pair;
    }

    let pair; let coin1;
    const pairObj = orderUtils.parseMarket(params[0]);
    if (pairObj) {
      pair = pairObj.pair;
      coin1 = pairObj.coin1;
    } else {
      coin1 = params[0]?.toUpperCase();
    }

    const res = Object
        .keys(exchangerUtils.currencies)
        .filter((t) => t.startsWith(coin1 + '/'))
        .map((t) => {
          const quoteCoin = t.replace(coin1 + '/', '');
          const pair = `${coin1}/**${quoteCoin}**`;
          const rate = utils.formatNumber(exchangerUtils.currencies[t].toFixed(constants.PRECISION_DECIMALS));
          return `${pair}: ${rate}`;
        })
        .join(', ');

    if (!res.length) {
      if (!pair) {
        output = `I can’t get rates for *${coin1} from Infoservice*. Try */rates ADM*.`;
        return {
          msgNotify: '',
          msgSendBack: output,
          notifyType: 'log',
        };
      }
    } else {
      output = `Global market rates for ${coin1}:\n${res}.`;
    }

    if (pair) {
      if (output) {
        output += '\n\n';
      }

      const exchangeRatesInfo = await getRatesInfo(pair);
      output += exchangeRatesInfo.ratesString;
    }
  } catch (e) {
    log.error(`Error in rates() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

async function getDepositInfo(accountNo = 0, tx = {}, coin1) {
  let output = '';

  try {
    const api = traderapi;
    const depositAddresses = await api.getDepositAddress(coin1);

    if (depositAddresses?.length) {
      output = `The deposit addresses for ${coin1} on ${config.exchangeName}:\n${depositAddresses.map(({ network, address, memo }) => `${network ? `_${network}_: ` : ''}${address}${memo ? `, ${memo}` : ''}`).join('\n')}`;
    } else {
      output = `Unable to get a deposit addresses for ${coin1}.`;

      if (depositAddresses?.message) {
        output += ` Error: ${depositAddresses?.message}.`;
      } else if (api.features().createDepositAddressWithWebsiteOnly) {
        output += ` Note: ${config.exchangeName} don't create new deposit addresses via API. Create it manually with a website.`;
      }
    }
  } catch (e) {
    log.error(`Error in getDepositInfo() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return output;
}

/**
 * Show deposit address for a coin
 * @param {String[]} params Coin to deposit
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function deposit(params, tx = {}) {
  let output = '';

  try {
    if (!params[0] || params[0].indexOf('/') !== -1) {
      output = 'Please specify coin to get a deposit address. F. e., */deposit ADM*.';
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }

    if (!traderapi.features().getDepositAddress) {
      return {
        msgNotify: '',
        msgSendBack: 'The exchange doesn\'t support receiving a deposit address.',
        notifyType: 'log',
      };
    }

    const coin1 = params[0].toUpperCase();
    const account0DepositInfo = await getDepositInfo(0, tx, coin1);
    const account1DepositInfo = undefined;
    output = account1DepositInfo ?
      account0DepositInfo.replace(`on ${config.exchangeName}`, `on ${config.exchangeName} (account 1)`) +
      '\n\n\n' + account1DepositInfo.replace(`on ${config.exchangeName}`, `on ${config.exchangeName} (account 2)`) :
      account0DepositInfo;
  } catch (e) {
    log.error(`Error in deposit() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Show trade pair stats
 * @param {String[]} params Trade pair
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function stats(params) {
  let output = '';

  try {
    let pair = params[0];
    if (!pair) {
      pair = config.pair;
    }
    if (pair.indexOf('/') === -1) {
      output = `Wrong pair '${pair}'. Try */stats ${config.pair}*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
    const pairObj = orderUtils.parseMarket(pair);
    const coin1 = pairObj.coin1;
    const coin2 = pairObj.coin2;
    const coin1Decimals = pairObj.coin1Decimals;
    const coin2Decimals = pairObj.coin2Decimals;

    // First, get exchange 24h stats on pair: volume, low, high, spread
    const exchangeRates = await traderapi.getRates(pairObj.pair);
    const totalVolume24 = +exchangeRates?.volume;
    if (exchangeRates) {
      let volumeInCoin2String = '';
      if (exchangeRates.volumeInCoin2) {
        volumeInCoin2String = ` & ${utils.formatNumber(+exchangeRates.volumeInCoin2.toFixed(coin2Decimals), true)} ${coin2}`;
      }
      output += `${config.exchangeName} 24h stats for ${pairObj.pair} pair:`;
      let delta = exchangeRates.high-exchangeRates.low;
      let average = (exchangeRates.high+exchangeRates.low)/2;
      let deltaPercent = delta/average * 100;
      output += `\nVol: ${utils.formatNumber(+exchangeRates.volume.toFixed(coin1Decimals), true)} ${coin1}${volumeInCoin2String}.`;
      if (exchangeRates.low && exchangeRates.high) {
        output += `\nLow: ${exchangeRates.low.toFixed(coin2Decimals)}, high: ${exchangeRates.high.toFixed(coin2Decimals)}, delta: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      } else {
        output += '\nNo low and high rates available.';
      }
      delta = exchangeRates.ask-exchangeRates.bid;
      average = (exchangeRates.ask+exchangeRates.bid)/2;
      deltaPercent = delta/average * 100;
      output += `\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      if (exchangeRates.last) {
        output += `\nLast price: _${(exchangeRates.last).toFixed(coin2Decimals)}_ ${coin2}.`;
      }
    } else {
      output += `Unable to get ${config.exchangeName} stats for ${pairObj.pair}. Try again later.`;
    }

    // Second, get order book information
    const orderBook = await traderapi.getOrderBook(pairObj.pair);
    const orderBookInfo = utils.getOrderBookInfo(orderBook);
    if (orderBook && orderBookInfo) {
      const delta = orderBookInfo.smartAsk-orderBookInfo.smartBid;
      const average = (orderBookInfo.smartAsk+orderBookInfo.smartBid)/2;
      const deltaPercent = delta/average * 100;

      const bids2 = orderBookInfo.liquidity['percent2'].amountBidsQuote;
      const asks2 = orderBookInfo.liquidity['percent2'].amountAsks;
      const bidsFull = orderBookInfo.liquidity['full'].amountBidsQuote;
      const asksFull = orderBookInfo.liquidity['full'].amountAsks;

      const bidsPercent2 = bids2 / bidsFull * 100;
      const asksPercent2 = asks2 / asksFull * 100;

      const fairPrice2 = bids2 / asks2;
      const fairPriceFull = bidsFull / asksFull;

      output += '\n\n**Order book information**:\n\n';
      output += `Smart bid: ${orderBookInfo.smartBid.toFixed(coin2Decimals)}, smart ask: ${orderBookInfo.smartAsk.toFixed(coin2Decimals)}, smart spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      output += `\nFull depth (may be limited by exchange API): ${orderBookInfo.liquidity['full'].bidsCount} bids with ${utils.formatNumber(bidsFull.toFixed(coin2Decimals), true)} ${coin2}`;
      output += ` and ${orderBookInfo.liquidity['full'].asksCount} asks with ${utils.formatNumber(asksFull.toFixed(coin1Decimals), true)} ${coin1}.`;
      output += ` Fair price: _${utils.formatNumber(fairPriceFull.toFixed(coin2Decimals), true)}_ ${coin2}.`;
      output += `\nDepth ±2%: ${orderBookInfo.liquidity['percent2'].bidsCount} bids with ${utils.formatNumber(bids2.toFixed(coin2Decimals), true)} ${coin2} (${bidsPercent2.toFixed(2)}%)`;
      output += ` and ${orderBookInfo.liquidity['percent2'].asksCount} asks with ${utils.formatNumber(asks2.toFixed(coin1Decimals), true)} ${coin1} (${asksPercent2.toFixed(2)}%).`;
      if (fairPrice2) {
        output += ` Fair price: _${utils.formatNumber(fairPrice2.toFixed(coin2Decimals), true)}_ ${coin2}.`;
      }
    } else {
      output += `\n\nUnable to get ${config.exchangeName} order book information for ${pairObj.pair}. Try again later.`;
    }

    const mmDisabledNote = tradeParams.mm_isActive ? '' : ' [Note: currently market-making is disabled]';

    // Third, get target mm volume
    // ..

    // Forth, get order statistics
    const { statList, statTotal } = await orderStats.getAllOrderStats(['ld', 'man'], pairObj.pair);

    const composeOrderStats = function(stats) {
      const composeLine = function(time, label) {
        if (stats[`coin1AmountTotal${time}Count`]) {
          const percentString = (totalVolume24 && time === 'Day') ? ` (${(stats[`coin1AmountTotal${time}`] / totalVolume24 * 100).toFixed(2)}%)` : '';
          return `\n${label || time} — ${stats[`coin1AmountTotal${time}Count`]} orders with ${utils.formatNumber(stats[`coin1AmountTotal${time}`].toFixed(coin1Decimals), true)} ${coin1} and ${utils.formatNumber(stats[`coin2AmountTotal${time}`].toFixed(coin2Decimals), true)} ${coin2}${percentString}`;
        } else {
          return `\n${label || time} — No orders`;
        }
      };

      let orderStatsString = `_${stats.purposeName}_:`;
      if (stats.coin1AmountTotalHourCount !== 0) {
        orderStatsString += composeLine('Hour');
      }
      if (stats.coin1AmountTotalDayCount > stats.coin1AmountTotalHourCount) {
        orderStatsString += composeLine('Day');
      }
      if (stats.coin1AmountTotalMonthCount > stats.coin1AmountTotalDayCount) {
        orderStatsString += composeLine('Month');
      }
      orderStatsString += composeLine('All', 'All time');
      return orderStatsString;
    };

    if (statTotal?.coin1AmountTotalAllCount > 0) {
      output += `\n\n**Executed order statistics**${mmDisabledNote}:`;
      statList.forEach((stats) => {
        output += `\n\n${composeOrderStats(stats)}`;
      });
      output += `\n\n${composeOrderStats(statTotal)}`;
    } else {
      output += `\n\nThe bot executed no orders on ${pairObj.pair} pair all time.`;
    }
  } catch (e) {
    log.error(`Error in stats() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Show trade pair exchange config
 * @param {String[]} params Trade pair
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function pair(params) {
  let output = '';

  try {
    let pair = params[0]?.toUpperCase();
    if (!pair) {
      pair = config.pair;
    }
    if (pair.indexOf('/') === -1) {
      return {
        msgNotify: '',
        msgSendBack: `Wrong pair '${pair}'. Try */pair ${config.pair}*.`,
        notifyType: 'log',
      };
    }

    if (!traderapi.features().getMarkets) {
      return {
        msgNotify: '',
        msgSendBack: 'The exchange doesn\'t support receiving market info.',
        notifyType: 'log',
      };
    }

    const info = traderapi.marketInfo(pair);
    if (!info) {
      return {
        msgNotify: '',
        msgSendBack: `Unable to receive ${pair} market info. Try */pair ${config.pair}*.`,
        notifyType: 'log',
      };
    }

    output = `${config.exchangeName} reported these details on ${pair} market:\n\n`;
    output += JSON.stringify(info, null, 3);
  } catch (e) {
    log.error(`Error in pair() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Get open orders details for accountNo
 * @param {Number} accountNo 0 is for the first trade account, 1 is for the second
 * @param {Object} tx Command Tx info
 * @param {Object} pair Trading pair
 * @returns Order details for an account
 */
async function getOrdersInfo(accountNo = 0, tx = {}, pair) {
  let output = '';
  const pairObj = orderUtils.parseMarket(pair);
  let diffStringUnknownOrdersCount = '';

  const api = traderapi;
  const ordersByType = await orderStats.ordersByType(pairObj.pair, api);
  const openOrders = await traderapi.getOpenOrders(pairObj.pair);

  if (openOrders) {

    let diff; let sign;
    let diffStringExchangeOrdersCount = '';
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj?.pair]?.openOrdersCount) {
      diff = openOrders.length - previousOrders[accountNo][tx.senderId][pairObj.pair].openOrdersCount;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffStringExchangeOrdersCount = ` (${sign}${diff})`;
    }

    if (openOrders.length > 0) {
      output = `${config.exchangeName} open orders for ${pairObj.pair} pair: ${openOrders.length}${diffStringExchangeOrdersCount}.`;
    } else {
      output = `No open orders on ${config.exchangeName} for ${pairObj.pair}.`;
    }

    ordersByType.openOrdersCount = openOrders.length;
    ordersByType.unkLength = openOrders.length - ordersByType['all'].allOrders.length;
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj?.pair]?.unkLength) {
      diff = ordersByType.unkLength - previousOrders[accountNo][tx.senderId][pairObj.pair].unkLength;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffStringUnknownOrdersCount = ` (${sign}${diff})`;
    }

  } else {
    output = `Unable to get ${config.exchangeName} orders for ${pairObj.pair}.`;
  }

  const getDiffString = function(purpose) {
    let diff; let sign;
    let diffString = '';
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj.pair]?.[purpose]?.allOrders.length >= 0) {
      diff = ordersByType[purpose].allOrders.length -
        previousOrders[accountNo][tx.senderId][pairObj.pair][purpose].allOrders.length;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffString = ` (${sign}${diff})`;
    }
    return diffString;
  };

  const getAmountsString = function(purpose) {
    let amountsString = '';
    if (ordersByType[purpose].buyOrdersQuote || ordersByType[purpose].sellOrdersAmount) {
      amountsString = ` — ${ordersByType[purpose].buyOrdersQuote.toFixed(pairObj.coin2Decimals)} ${pairObj.coin2} buys & ${ordersByType[purpose].sellOrdersAmount.toFixed(pairObj.coin1Decimals)} ${pairObj.coin1} sells`;
    }
    return amountsString;
  };

  if (ordersByType?.['all']?.allOrders?.length > 0) {
    output += '\n\nOrders in my database:';
    Object.keys(orderCollector.orderPurposes).forEach((purpose) => {
      output += `\n${orderCollector.orderPurposes[purpose]}: ${ordersByType[purpose].allOrders.length}${getDiffString(purpose)}${getAmountsString(purpose)},`;
    });
    output = utils.trimAny(output, ',') + '.';
  } else {
    output += '\n\n' + 'No open orders in my database.';
  }

  output += `\n\nOrders which are not in my database (Unknown orders): ${ordersByType.unkLength}${diffStringUnknownOrdersCount}.`;

  previousOrders[accountNo][tx.senderId] = {};
  previousOrders[accountNo][tx.senderId][pairObj.pair] = ordersByType;

  return output;
}

/**
 * Get details for open orders of specific type for accountNo
 * @param {Number} accountNo 0 is for the first trade account, 1 is for the second
 * @param {Object} tx Command Tx info
 * @param {String} pair Trading pair
 * @param {String} type Type of orders to list
 * @param {Boolean} fullInfo Show full order info. Probably there will be line breaks and not convenient to read.
 * @returns List of open orders of specific type
 */
async function getOrdersDetails(accountNo = 0, tx = {}, pair, type, fullInfo) {
  let output = '';
  const pairObj = orderUtils.parseMarket(pair);

  const api = traderapi;
  const ordersByType = (await orderStats.ordersByType(pairObj.pair, api, false))[type]?.allOrders;

  if (ordersByType?.length) {
    output = `${config.exchangeName} ${type}-orders for ${pairObj.pair} pair: ${ordersByType.length}.\n`;

    ordersByType.sort((a, b) => b.price - a.price);

    for (const order of ordersByType) {
      output += '`';

      if (type === 'ld') {
        output += `${utils.padTo2Digits(order.ladderIndex)} `;
      }

      output += `${order.type} ${order.coin1Amount?.toFixed(pairObj.coin1Decimals)} ${order.coin1} @${order.price?.toFixed(pairObj.coin2Decimals)} ${order.coin2} for ${+order.coin2Amount?.toFixed(pairObj.coin2Decimals)} ${order.coin2}`;

      if (fullInfo) {
        output += ` ${utils.formatDate(new Date(order.date))}`;
      }

      if (type === 'ld') {
        output += ` ${order.ladderState}`;

        if (fullInfo) {
          output += ` ${order.ladderNotPlacedReason ? ' (' + order.ladderNotPlacedReason + ')' : ''}`;
        }
      }

      output += '`\n';
    }
  } else {
    output = `No ${type}-orders opened on ${config.exchangeName} for ${pairObj.pair} pair.`;
  }

  return output;
}

/**
 * Get open orders details
 * @param {Object} params Optional trade pair and type of orders
 * @param {Object} tx Command Tx info
 * @returns Notification messages
 */
async function orders(params, tx = {}) {
  let detailsType;
  let pair = params[0];

  if (Object.keys(orderCollector.orderPurposes).includes(pair?.toLowerCase())) {
    detailsType = pair; // It's an order type
    pair = config.pair;
  }

  pair = pair || config.pair;

  if (pair.indexOf('/') === -1) {
    return {
      msgNotify: '',
      msgSendBack: `Wrong pair '${pair}'. Try */orders ${config.pair}*.`,
      notifyType: 'log',
    };
  }

  detailsType = detailsType || params[1]?.toLowerCase();

  let account0Orders;
  let account1Orders;

  if (detailsType) {
    if (!Object.keys(orderCollector.orderPurposes).includes(detailsType)) {
      return {
        msgNotify: '',
        msgSendBack: `Wrong order type '${detailsType}'. Try */orders ${config.pair} man*.`,
        notifyType: 'log',
      };
    }

    const fullInfo = params[params.length - 1]?.toLowerCase() === 'full' ? true : false;

    account0Orders = await getOrdersDetails(0, tx, pair, detailsType, fullInfo);
    account1Orders = undefined;
  } else {
    account0Orders = await getOrdersInfo(0, tx, pair);
    account1Orders = undefined;
  }

  const output = account1Orders ?
      account0Orders.replace(' pair:', ' pair (account 1):').replace(`on ${config.exchangeName} for`, `on ${config.exchangeName} (account 1) for`) +
      '\n\n\n' + account1Orders.replace(' pair:', ' pair (account 2):').replace(`on ${config.exchangeName} for`, `on ${config.exchangeName} (account 2) for`) :
      account0Orders;

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Get info on coin withdrawal information and networks
 * @param {Array} params Command parameters to parse
 * @param {Object} tx Income ADM transaction
 * @param {Boolean} isWebApi If isWebApi true, messages can be different
 * @returns Notification messages
 * @returns {Promise<void>}
 */
async function info(params, tx, isWebApi = false) {
  try {
    const coin = params[0]?.toUpperCase() || '';
    if (coin?.length < 2) {
      return {
        msgNotify: '',
        msgSendBack: 'Specify coin to get withdrawal information and networks. Example: */info USDT*.',
        notifyType: 'log',
      };
    }

    if (traderapi.features().getCurrencies && traderapi.currencies) {
      await traderapi.getCurrencies(coin, true);

      const currency = await traderapi.currencyInfo(coin);
      if (!currency) {
        return {
          msgNotify: '',
          msgSendBack: `It seems ${config.exchangeName} doesn't have _${coin}_ coin. Try */info USDT*.`,
          notifyType: 'log',
        };
      }

      let msgSendBack = `_${coin}_ on ${config.exchangeName} info:\n`;
      msgSendBack += coinInfoString(currency);

      return {
        msgNotify: '',
        msgSendBack,
        notifyType: 'log',
      };
    }

    return {
      msgNotify: '',
      msgSendBack: `It seems ${config.exchangeName} doesn't provide info about coins.`,
      notifyType: 'log',
    };
  } catch (e) {
    log.error(`Error in info() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

/**
 * Calculates coin value in other coin
 * @param {String[]} params Coins and value
 * @returns {Object} { msgNotify, msgSendBack, notifyType }
 */
async function calc(params, tx, isWebApi = false) {
  let output = '';
  try {

    if (params.length !== 4) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. Command works like this: */calc 2.05 BTC in USDT*.',
        notifyType: 'log',
      };
    }

    const amount = +params[0];
    const inCurrency = params[1].toUpperCase().trim();
    const outCurrency = params[3].toUpperCase().trim();
    const pair = inCurrency + '/' + outCurrency;
    const pair2 = outCurrency + '/' + inCurrency;

    if (!utils.isPositiveOrZeroNumber(amount)) {
      output = `Wrong amount: _${params[0]}_. Command works like this: */calc 2.05 BTC in USD*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
    if (!exchangerUtils.hasTicker(inCurrency)) {
      output = `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
    }
    if (!exchangerUtils.hasTicker(outCurrency)) {
      output = `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
    }

    let result;
    if (!output) {
      result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount).outAmount;
      if (!utils.isPositiveOrZeroNumber(result)) {
        output = `Unable to calc _${params[0]}_ ${inCurrency} in ${outCurrency}.`;
        return {
          msgNotify: '',
          msgSendBack: `${output}`,
          notifyType: 'log',
        };
      }

      const precision = exchangerUtils.isFiat(outCurrency) ? 2 : constants.PRECISION_DECIMALS;
      output = isWebApi ? utils.formatNumber(result.toFixed(precision), false) : `Global market value of ${utils.formatNumber(amount)} ${inCurrency} equals ${utils.formatNumber(result.toFixed(precision), true)} ${outCurrency}.`;
    } else {
      output = '';
    }

    if (output && !isWebApi) {
      output += '\n\n';
    }
    let askValue; let bidValue;

    let exchangeRates = await traderapi.getRates(pair);
    if (!isWebApi) {
      if (exchangeRates) {
        askValue = exchangeRates.ask * amount;
        bidValue = exchangeRates.bid * amount;
        output += `${config.exchangeName} value of ${utils.formatNumber(amount)} ${inCurrency}:\nBid: **${utils.formatNumber(bidValue.toFixed(8))} ${outCurrency}**, ask: **${utils.formatNumber(askValue.toFixed(8))} ${outCurrency}**.`;
      } else {
        exchangeRates = await traderapi.getRates(pair2);
        if (exchangeRates) {
          askValue = amount / exchangeRates.ask;
          bidValue = amount / exchangeRates.bid;
          output += `${config.exchangeName} value of ${utils.formatNumber(amount)} ${inCurrency}:\nBid: **${utils.formatNumber(bidValue.toFixed(8))} ${outCurrency}**, ask: **${utils.formatNumber(askValue.toFixed(8))} ${outCurrency}**.`;
        } else {
          output += `Unable to get ${config.exchangeName} rates for ${pair}.`;
        }
      }
    }

  } catch (e) {
    log.error(`Error in calc() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Creates a string about coin info
 * @param {Object} coin
 * @return {String}
 */
function coinInfoString(coin) {
  const networksSupported = traderapi.features().supportCoinNetworks && typeof coin.networks === 'object' && Object.keys(coin.networks)?.length;

  let message = '';
  message += `Coin status is ${buildStatusString(coin)}${coin.comment ? ': ' + utils.trimAny(coin.comment, '. ') : ''}.`;
  if (coin.type) {
    message += ` Type: ${coin.type}.`;
  }
  if (coin.decimals) {
    message += ` Decimals: ${coin.decimals}, precision: ${coin.precision?.toFixed(coin.decimals)}.`;
  }
  message += '\n';

  if (!networksSupported) {
    message += coinNetworkInfoString(coin);

    if (traderapi.features().supportCoinNetworksRestricted) {
      message += `\nNote: Receiving coin networks on ${config.exchangeName} is of private API. Try _/deposit ${coin.symbol}_ to list supported networks.`;
    }
  } else {
    message += `Supported networks for _${coin.name}_:`;
    message += supportedNetworksString(coin);
  }

  return message;
}

/**
 * Creates a string with coin's network info
 * @param {Object} coinOrNetwork Coin or coin.networks[network]
 * @param {Object} coin Coin to get parent info for a network
 * @return String
 */
function coinNetworkInfoString(coinOrNetwork, coin) {
  let message = '';

  const confirmations = coinOrNetwork.confirmations || coin?.confirmations;
  if (confirmations) {
    message += `Deposit confirmations: ${confirmations}. `;
  }

  const symbol = coinOrNetwork.symbol || coin?.symbol;
  const withdrawalFee = coinOrNetwork.withdrawalFee ?? coin?.withdrawalFee;
  const withdrawalFeeCurrency = coinOrNetwork.withdrawalFeeCurrency || coin?.withdrawalFeeCurrency || symbol;
  const minWithdrawal = coinOrNetwork.minWithdrawal || coin?.minWithdrawal;
  const maxWithdrawal = coinOrNetwork.maxWithdrawal || coin?.maxWithdrawal;
  if (utils.isPositiveOrZeroNumber(withdrawalFee) || coinOrNetwork.minWithdrawal) {
    if (utils.isPositiveOrZeroNumber(withdrawalFee)) {
      message += `Withdrawal fee — ${withdrawalFee} ${withdrawalFeeCurrency}`;
    } else {
      message += 'Withdrawal fee — unknown';
    }
    if (minWithdrawal) {
      message += `, minimum amount to withdraw ${minWithdrawal} ${symbol}`;
    }
    if (coinOrNetwork.maxWithdrawal) {
      message += `, maximum ${maxWithdrawal} ${symbol}`;
    }
  }

  message = utils.trimAny(message, '. ');

  const decimals = coinOrNetwork.decimals || coin?.decimals;
  const precision = coinOrNetwork.precision || coin?.precision;

  if (decimals) {
    if (message) {
      message += '. ';
    }

    message += `Decimals: ${decimals}, precision: ${precision?.toFixed(decimals)}`;
  }

  message = message ? message + '.' : '';

  return message;
}

/**
 * Creates a coin/network status string
 * @param {Object} coin
 * @return String
 */
function buildStatusString(coinOrNetwork) {
  let statusString = '';
  statusString = coinOrNetwork.status === 'ONLINE' ? `${coinOrNetwork.status.toLowerCase()}` : `**${coinOrNetwork.status}**`;

  if (coinOrNetwork.depositStatus || coinOrNetwork.withdrawalStatus) {
    if (coinOrNetwork.status !== coinOrNetwork.depositStatus || coinOrNetwork.status !== coinOrNetwork.withdrawalStatus) {
      statusString += ` (deposits: ${coinOrNetwork.depositStatus}, withdrawals: ${coinOrNetwork.depositStatus})`;
    }
  }

  return statusString;
}

/**
 * Creates a string from supported networks on exchange
 * @param {Object} coin
 * @return String
 */
function supportedNetworksString(coin) {
  let message = '';

  for (const network of Object.keys(coin.networks)) {
    const networkStatus = buildStatusString(coin.networks[network]);
    message += `\n+ _${network}_ is ${networkStatus}. `;
    message += coinNetworkInfoString(coin.networks[network], coin);
    message = utils.trimAny(message, '. ') + '.';
  }

  return message;
}

/**
 * Creates a string for balances object, looks like total-available-frozen for each crypto
 * Adds totalBTC, totalUSD, totalNonCoin1USD, totalNonCoin1BTC to balances object
 * @param {Array of Object} balances Balances object
 * @param {String} caption Like '${config.exchangeName} balances:'
 * @param {Array} params First parameter: account type, e.g., main, trade, margin, or 'full'
 * @return {String, Object} String of balances info and Balances object with totalBTC, totalUSD, totalNonCoin1USD, totalNonCoin1BTC
 */
function balancesString(balances, caption, params) {
  let output = '';

  let totalBTC = 0; let totalUSD = 0;
  let totalNonCoin1BTC = 0; let totalNonCoin1USD = 0;

  const unknownCryptos = [];

  if (balances.length === 0) {
    output = 'All empty.';
  } else {
    output = caption;

    // Skip total-available-frozen for totals
    balances = balances.filter((crypto) => !['totalBTC', 'totalUSD', 'totalNonCoin1BTC', 'totalNonCoin1USD'].includes(crypto.code));

    // Create total-available-frozen string for each crypto in Balances object
    balances.forEach((crypto) => {
      // In requested to show balances of special account type, e.g, for margin account
      const accountTypeString = params?.[0] ? `[${crypto.accountType}] ` : '';

      output += `${accountTypeString}${utils.formatNumber(crypto.total?.toFixed(8), true)} _${crypto.code}_`;

      if (crypto.total !== crypto.free) {
        output += ` (${utils.formatNumber(crypto.free?.toFixed(8), true)} available`;

        if (crypto.freezed > 0) {
          output += ` & ${utils.formatNumber(crypto.freezed?.toFixed(8), true)} frozen`;
        }

        output += ')';
      }

      output += '\n';

      let value;
      const skipUnknownCryptos = ['BTXCRD'];

      // Incrementally count Total holdings in USD
      if (utils.isPositiveOrZeroNumber(crypto.usd)) {
        totalUSD += crypto.usd;
        if (crypto.code !== config.coin1) totalNonCoin1USD += crypto.usd;
      } else {
        value = exchangerUtils.convertCryptos(crypto.code, 'USD', crypto.total).outAmount;

        if (utils.isPositiveOrZeroNumber(value)) {
          totalUSD += value;
          if (crypto.code !== config.coin1) totalNonCoin1USD += value;
        } else if (!skipUnknownCryptos.includes(crypto.code)) {
          unknownCryptos.push(crypto.code);
        }
      }

      // Incrementally count Total holdings in BTC
      if (utils.isPositiveOrZeroNumber(crypto.btc)) {
        totalBTC += crypto.btc;
        if (crypto.code !== config.coin1) totalNonCoin1BTC += crypto.btc;
      } else {
        value = exchangerUtils.convertCryptos(crypto.code, 'BTC', crypto.total).outAmount;

        if (utils.isPositiveOrZeroNumber(value)) {
          totalBTC += value;
          if (crypto.code !== config.coin1) totalNonCoin1BTC += value;
        }
      }
    });

    output += `Total holdings ~ ${utils.formatNumber(totalUSD.toFixed(2), true)} _USD_ or ${utils.formatNumber(totalBTC.toFixed(8), true)} _BTC_`;
    output += `\nTotal holdings (non-${config.coin1}) ~ ${utils.formatNumber(totalNonCoin1USD.toFixed(2), true)} _USD_ or ${utils.formatNumber(totalNonCoin1BTC.toFixed(8), true)} _BTC_`;

    if (unknownCryptos.length) {
      output += `. Note: I didn't count unknown cryptos ${unknownCryptos.join(', ')}.`;
    }

    output += '\n';

    balances.push({
      code: 'totalUSD',
      total: totalUSD,
    });

    balances.push({
      code: 'totalBTC',
      total: totalBTC,
    });

    balances.push({
      code: 'totalNonCoin1USD',
      total: totalNonCoin1USD,
    });

    balances.push({
      code: 'totalNonCoin1BTC',
      total: totalNonCoin1BTC,
    });
  }

  return { output, balances };
}

/**
 * Create balance info string for an account, including balance difference from previous request
 * @param {Number} accountNo 0 for first account, 1 for second one
 * @param {Object} tx [deprecated] Income ADM transaction to get senderId
 * @param {String} userId senderId or userId for web
 * @param {Boolean} isWebApi If true, info messages will be different
 * @param {Array} params First parameter: account type, like main, trade, margin, or 'full'.
 *   Note: Balance difference only for 'trade' account
 * @return {String}
 */
async function getBalancesInfo(accountNo = 0, tx, isWebApi = false, params, userId) {
  let output = '';

  try {
    let balances =
      await traderapi.getBalances();

    const accountTypeString = params?.[0] ? ` _${params?.[0]}_ account` : '';
    const caption = `${config.exchangeName}${accountTypeString} balances:\n`;
    const balancesObject = balancesString(balances, caption, params);
    output = balancesObject.output;
    balances = balancesObject.balances;

    if (!isWebApi && !params?.[0]) {
      output += utils.differenceInBalancesString(
          balances,
          previousBalances[accountNo][userId],
          orderUtils.parseMarket(config.pair),
      );

      previousBalances[accountNo][userId] = { timestamp: Date.now(), balances };
    }
  } catch (e) {
    log.error(`Error in getBalancesInfo() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return output;
}

/**
 * Show account balance info
 * @param {Array} params First parameter: account type, like main, trade, margin, or 'full'.
 *   If undefined, will show balances for 'trade' account. If 'full', for all account types.
 *   Exchange should support features().accountTypes
 *   Note: Both account balances in case of two-keys trading will show only for 'trade'
 * @param {Object} tx Income ADM transaction for in-chat command
 * @param {Object} user User info for web
 * @param {Boolean} isWebApi If true, info messages will be different
 * @return {String}
 */
async function balances(params, tx, user, isWebApi = false) {
  let output = '';

  try {
    if (params?.[0]) {
      if (traderapi.features().accountTypes) {
        params[0] = params[0].toLowerCase();
      } else {
        params = {};
      }
    }

    const userId = isWebApi ? user.login : tx.senderId;

    // Get balances info for each account separately
    const account0Balances = await getBalancesInfo(0, tx, isWebApi, params, userId);
    const account1Balances = undefined;

    output = account1Balances ? account0Balances + '\n\n' + account1Balances : account0Balances;

    // Get balances info combined for two accounts (commonBalances)
    if (account0Balances && account1Balances && !isWebApi && !params?.[0]) {
      const commonBalances = utils.sumBalances(previousBalances[0][userId]?.balances, previousBalances[1][userId]?.balances);

      output += balancesString(commonBalances, '\n\n**Both accounts**:\n').output;

      const diffString = utils.differenceInBalancesString(
          commonBalances,
          previousBalances[2][userId],
          orderUtils.parseMarket(config.pair),
      );

      if (diffString) {
        output += diffString;
      }

      previousBalances[2][userId] = { timestamp: Date.now(), balances: commonBalances };
    }
  } catch (e) {
    log.error(`Error in balances() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output || 'Unable to get account balances. Check API keys, or it may be a temporary error. See logs for details.',
    notifyType: 'log',
  };
}

async function getAccountInfo(accountNo = 0, tx, isWebApi = false) {
  const paramString = `accountNo: ${accountNo}, tx: ${tx}, isWebApi: ${isWebApi}`;

  let output = '';

  try {
    const api = traderapi;

    if (traderapi.features().getTradingFees) {
      const feesBTC = config.pair === 'BTC/USDT' ? [] : await api.getFees('BTC/USDT');
      const feesCoin2 = await api.getFees(config.coin1);

      const fees = [...feesBTC, ...feesCoin2];

      output += `${config.exchangeName} trading fees:\n`;

      fees.forEach((pair) => {
        output += `_${pair.pair}_: maker ${utils.formatNumber(pair.makerRate, true)}, taker ${utils.formatNumber(pair.takerRate, true)}`;
        if (pair.takerRateStable && pair.takerRateCrypto) {
          output += `, taker-stable ${utils.formatNumber(pair.takerRateStable, true)}`;
          output += `, taker-crypto ${utils.formatNumber(pair.takerRateCrypto, true)}`;
        }
        output += '\n';
      });
      output += '\n';

    } else {
      output += `${config.exchangeName}'s API doesn't provide trading fees information.\n\n`;
    }

    if (traderapi.features().getAccountTradeVolume) {
      const tradingVolume = await api.getVolume();

      output += `${config.exchangeName} 30-days trading volume: `;

      output += `${utils.formatNumber(tradingVolume?.volume30days, true)}`;
      output += tradingVolume?.volumeUnit ? ` ${tradingVolume?.volumeUnit}` : '';
      output += tradingVolume?.updated ? ` as on ${tradingVolume?.updated}.` : '.';

    } else {
      output += `${config.exchangeName}'s API doesn't provide trading volume information.`;
    }
  } catch (e) {
    log.error(`Error in getAccountInfo(${paramString}) of ${utils.getModuleName(module.id)} module: ${e}`);
    output = 'Error while receiving account information. Try again later.';
  }

  return output;
}

async function account({}, tx, isWebApi = false) {
  let output = '';

  try {

    if (traderapi.features().getTradingFees || traderapi.features().getAccountTradeVolume) {
      const account0Info = await getAccountInfo(0, tx, isWebApi);
      const account1Info = undefined;
      output = account1Info ? account0Info + '\n\n' + account1Info : account0Info;
    } else {
      output = `${config.exchangeName}'s API doesn't provide account information.`;
    }

  } catch (e) {
    log.error(`Error in account() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

function version() {
  return {
    msgNotify: '',
    msgSendBack: `I am running on _adamant-coinoptimus_ software version _${config.version}_. Revise code on ADAMANT's GitHub.`,
    notifyType: 'log',
  };
}

const aliases = {
  b: () => ('/balances'),
};

const commands = {
  help,
  rates,
  stats,
  pair,
  orders,
  calc,
  balances,
  account,
  version,
  start,
  stop,
  clear,
  fill,
  params,
  buy,
  sell,
  enable,
  disable,
  deposit,
  y,
  info,
  saveConfig: utils.saveConfig,
};

module.exports.commands = commands;
