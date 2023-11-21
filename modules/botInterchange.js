const { io } = require('socket.io-client');
const config = require('./../modules/config/reader');
const logger = require('./../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('./../trade/settings/tradeParams_' + config.exchange);
const utils = require('./../helpers/utils');
const { encrypt, decrypt } = require('./../helpers/encryption');
const exchangeUtils = require('./../helpers/cryptos/exchanger');

class SocketConnection {
  connection = null;
  interchangeInterval = 60000;
  pollingIntervalId = null;

  connect() {
    try {
      const botInfo = {
        pair: config.pair,
        coin1: config.coin1,
        coin2: config.coin2,
        exchange: config.exchange,
        exchangeName: config.exchangeName,
        name: config.name,
        version: config.version,
        projectName: config.projectName,
        projectNamePlain: config.projectNamePlain,
        projectBranch: config.projectBranch,
        botId: config.bot_id,
        botName: config.bot_name,
        account: config.account,
      };

      this.connection = io(
          config.com_server,
          {
            reconnection: true,
            reconnectionDelay: 5000, // Default is 1000
            query: {
              botInfo: JSON.stringify(encrypt(JSON.stringify(botInfo))),
            },
          },
      );
    } catch (e) {
      logger.error(`[ComServer] Error while processing connect function. Error: ${e}`);
    }
  }

  initHandlers() {
    this.connection.on('connect', () => {
      logger.info(`[ComServer] Connected to communication server ${config.com_server}.`);

      this.startPolling();
    });

    this.connection.on('connect_error', (err) => {
      logger.error(`[ComServer] Connection error: ${err}`);

      clearInterval(this.pollingIntervalId);
    });

    this.connection.on('disconnect', () => {
      logger.warn('[ComServer] Disconnected from communication server.');

      clearInterval(this.pollingIntervalId);
    });

    this.connection.on('convert', (encryptedData, callback) => {
      try {
        const { from, to, amount } = JSON.parse(decrypt(encryptedData));

        const { outAmount } = exchangeUtils.convertCryptos(from, to, amount);
        const encryptedResponse = encrypt(JSON.stringify(outAmount));

        callback(encryptedResponse);
      } catch (e) {
        logger.error(`[ComServer] Error while processing 'convert' event. Error: ${e}`);
      }
    });

    /**
     * Processes a command, received remotely from a ComServer
     * Does it the same way as the commandTxs
     * @param {string} encryptedParams Command and its parameters
     */
    this.connection.on('remote-command', async (encryptedParams) => {
      try {
        const { commands } = require('./commandTxs');

        const params = JSON.parse(decrypt(encryptedParams));
        const command = commands[params.command[0]];
        const tx = params.tx || {};

        const from = tx.senderTgUsername ?
          `${tx.senderTgUsername} (message ${tx.id})` :
          `${tx.senderId} (transaction ${tx.id})`;

        const fullCommand = params.command.join(' ');

        logger.log(`[ComServer] Got new remote command '/${fullCommand}' from ${from}…`);

        // When receiving command from a ComServer, process param aliases additionally. E.g., {QUOTE_COIN} to USDT
        const commandParams = params.command.map((param) => (paramsAliases[param] || param));

        const commandResult = await command(commandParams.slice(1), params.tx);

        logger.log(`[ComServer] Remote command '/${fullCommand}' from ${from} processed, sending results to a requesting bot…`);
        if (commandResult.msgNotify) {
          notify(`${commandResult.msgNotify} Action is executed **remotely** by ${from}.`, commandResult.notifyType);
        }

        utils.saveConfig(false, 'BotInterchange-onRemoteCommand()');

        this.connection.emit(
            'remote-command-response',
            encrypt(JSON.stringify({
              ...commandResult,
              command: params.command,
              botId: config.bot_id,
              id: params.id,
              connectionId: params.connectionId,
              tx,
            }),
            ),
        );
      } catch (e) {
        logger.error(`[ComServer] Error while processing remote command ${JSON.stringify(encryptedParams)} (encrypted). Error: ${e}`);
      }
    });

    /**
     * Save new params, received from a ComServer
     * Note: as on ComServer v1.2.1 (November 2023), it's not used
     * @param {Object} data New parameters to save
     */
    this.connection.on('newParams', (data) => {
      try {
        data = decrypt(data);
        logger.log(`[ComServer] Got new params: ${JSON.stringify(data)}`);

        Object.assign(tradeParams, data);
        utils.saveConfig(false, 'BotInterchange-onNewParams()');
      } catch (e) {
        logger.error(`[ComServer] Error while processing 'newParams' event. Error: ${e}`);
      }
    });
  }

  /**
   * Send something to ComServer regularly
   */
  startPolling() {
    this.pollingIntervalId = setInterval(() => {
      try {
        // Now we update ComServer on saving new parameters, see utils.saveConfig()
        // this.connection.emit('trade-params-update', encrypt(JSON.stringify(tradeParams)));
      } catch (e) {
        logger.error(`[ComServer] Error while processing polling function. Error: ${e}`);
      }
    }, this.interchangeInterval);
  }
}

const paramsAliases = {
  '{QUOTE_COIN}': config.coin2,
};

const botInterchange = new SocketConnection();

module.exports = { botInterchange };
