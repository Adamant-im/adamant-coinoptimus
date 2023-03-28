const db = require('./DB');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const utils = require('../helpers/utils');
const api = require('./api');
const config = require('./configReader');
const constants = require('../helpers/const');
const transferTxs = require('./transferTxs');
const commandTxs = require('./commandTxs');
const unknownTxs = require('./unknownTxs');
const Store = require('./Store');

const processedTxs = {}; // cache for processed transactions

module.exports = async (tx) => {

  // do not process one Tx twice: first check in cache, then check in DB
  if (processedTxs[tx.id]) {
    if (!processedTxs[tx.id].height) {
      await updateProcessedTx(tx, null, true); // update height of Tx and last processed block
    }
    return;
  }
  const { incomingTxsDb } = db;
  const knownTx = await incomingTxsDb.findOne({ _id: tx.id });
  if (knownTx !== null) {
    if (!knownTx.height || !processedTxs[tx.id]) {
      await updateProcessedTx(tx, knownTx, knownTx.height && processedTxs[tx.id]); // update height of Tx and last processed block
    }
    return;
  };

  log.log(`Processing new incoming transaction ${tx.id} from ${tx.senderId} via ${tx.height ? 'REST' : 'socket'}…`);

  let decryptedMessage = '';
  const chat = tx.asset ? tx.asset.chat : '';
  if (chat) {
    decryptedMessage = api.decodeMsg(chat.message, tx.senderPublicKey, config.passPhrase, chat.own_message).trim();
  }

  let commandFix = '';
  if (decryptedMessage.toLowerCase() === 'help') {
    decryptedMessage = '/help';
    commandFix = 'help';
  }
  if (decryptedMessage.toLowerCase() === '/balance') {
    decryptedMessage = '/balances';
    commandFix = 'balance';
  }

  let messageDirective = 'unknown';
  if (decryptedMessage.includes('_transaction') || tx.amount > 0) {
    messageDirective = 'transfer';
  } else if (decryptedMessage.startsWith('/')) {
    messageDirective = 'command';
  }

  const itx = new incomingTxsDb({
    _id: tx.id,
    txid: tx.id,
    date: utils.unixTimeStampMs(),
    timestamp: tx.timestamp,
    amount: tx.amount,
    fee: tx.fee,
    type: messageDirective,
    senderId: tx.senderId,
    senderPublicKey: tx.senderPublicKey,
    recipientPublicKey: tx.recipientPublicKey,
    messageDirective, // command, transfer or unknown
    encrypted_content: decryptedMessage,
    spam: false,
    isProcessed: false,
    // these will be undefined, when we get Tx via socket. Actually we don't need them, store them for a reference
    blockId: tx.blockId,
    height: tx.height,
    block_timestamp: tx.block_timestamp,
    confirmations: tx.confirmations,
    // these will be undefined, when we get Tx via REST
    relays: tx.relays,
    receivedAt: tx.receivedAt,
    isNonAdmin: false,
    commandFix,
  });

  let msgSendBack; let msgNotify;
  const admTxDescription = `Income ADAMANT Tx: ${constants.ADM_EXPLORER_URL}/tx/${tx.id} from ${tx.senderId}`;

  // do not process messages from non-admin accounts
  if (
    !config.admin_accounts.includes(tx.senderId)
  ) {
    log.warn(`${config.notifyName} received a message from non-admin user _${tx.senderId}_. Ignoring. Income ADAMANT Tx: https://explorer.adamant.im/tx/${tx.id}.`);
    itx.update({
      isProcessed: true,
      isNonAdmin: true,
    });
    if (config.notify_non_admins) {
      const notAdminMsg = `I won't execute your commands as you are not an admin. Connect with my master.`;
      api.sendMessage(config.passPhrase, tx.senderId, notAdminMsg).then((response) => {
        if (!response.success) {
          log.warn(`Failed to send ADM message '${notAdminMsg}' to ${tx.senderId}. ${response.errorMessage}.`);
        }
      });
    }
  }

  await itx.save();
  await updateProcessedTx(tx, itx, false);

  if (itx.isProcessed) return;

  switch (messageDirective) {
    case ('transfer'):
      transferTxs(itx, tx);
      break;
    case ('command'):
      const commandResult = await commandTxs(decryptedMessage, tx, itx);

      if (commandResult?.msgSendBack) {
        const chunks = utils.chunkString(commandResult.msgSendBack, constants.MAX_ADM_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          const response = await api.sendMessage(config.passPhrase, tx.senderId, chunk);
          if (!response?.success) {
            log.warn(`Failed to send ADM message '${commandResult.msgSendBack}' to ${tx.senderId}. ${response?.errorMessage}.`);
          }
        }
      }

      break;
    default:
      unknownTxs(tx, itx);
      break;
  }

};

async function updateProcessedTx(tx, itx, updateDb) {

  processedTxs[tx.id] = {
    updated: utils.unixTimeStampMs(),
    height: tx.height,
  };

  if (updateDb && !itx) {
    itx = await db.incomingTxsDb.findOne({ txid: tx.id });
  }

  if (updateDb && itx) {
    await itx.update({
      blockId: tx.blockId,
      height: tx.height,
      block_timestamp: tx.block_timestamp,
      confirmations: tx.confirmations,
    }, true);
  }

  await Store.updateLastProcessedBlockHeight(tx.height);

}
