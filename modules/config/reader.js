const jsonminify = require('jsonminify');
const fs = require('fs');
const keys = require('adamant-api/src/helpers/keys');

const { version } = require('../../package.json');

const fields = require('./schema.js');
const validateSchema = require('./validate.js');

const isDev = process.argv.includes('dev');

let config = {};

try {
  let configPath = './config.default.jsonc';

  if (fs.existsSync('./config.jsonc')) {
    configPath = './config.jsonc';
  }

  if (isDev || process.env.JEST_WORKER_ID) {
    if (fs.existsSync('./config.test.jsonc')) {
      configPath = './config.test.jsonc';
    }
  }

  config = JSON.parse(jsonminify(fs.readFileSync(configPath, 'utf-8')));

  if (!config.node_ADM) {
    exit('Bot\'s config is wrong. ADM nodes are not set. Cannot start the Bot.');
  }

  if (!config.passPhrase || config.passPhrase.length < 35) {
    exit('Bot\'s config is wrong. Set an ADAMANT passPhrase to manage the Bot.');
  }

  let keyPair;

  try {
    keyPair = keys.createKeypairFromPassPhrase(config.passPhrase);
  } catch (error) {
    exit(`Bot's config is wrong. Invalid passPhrase. Error: ${error}. Cannot start the Bot.`);
  }

  const address = keys.createAddressFromPublicKey(keyPair.publicKey);

  const [coin1, coin2] = config.pair.split('/');

  const file = `tradeParams_${config.exchange}.js`;
  const fileWithPath = `./trade/settings/${file}`;

  config = {
    ...config,
    version,
    keyPair,
    address,
    file,
    fileWithPath,
    publicKey: keyPair.publicKey.toString('hex'),
    notifyName: `${config.bot_name} (${address})`,
    supported_exchanges: config.exchanges.join(', '),
    exchangeName: config.exchange,
    exchange: config.exchange.toLowerCase(),
    pair: config.pair.toUpperCase(),
    coin1: coin1.trim(),
    coin2: coin2.trim(),
  };

  try {
    validateSchema(config, fields);
  } catch (error) {
    exit(`Bot's ${address} config is wrong. ${error} Cannot start the bot.`);
  }

  console.info(`The bot ${address} successfully read the config-file '${configPath}'${isDev ? ' (dev)' : ''}.`);
} catch (e) {
  exit('Error reading config: ' + e);
}

function exit(msg) {
  console.error(msg);
  process.exit(-1);
}

config.isDev = isDev;
module.exports = config;
