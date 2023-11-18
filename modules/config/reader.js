const jsonminify = require('jsonminify');
const fs = require('fs');
const path = require('path');
const keys = require('adamant-api/src/helpers/keys');

const { version, name } = require('../../package.json');

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

  if (config.passPhrase?.length < 35) {
    config.passPhrase = undefined;
  }

  if (!config.cli) {
    if (process.env.CLI_MODE_ENABLED) {
      exit('CLI is disabled in the config.');
    }

    if (!config.passPhrase) {
      exit('Bot\'s config is wrong. ADAMANT passPhrase is invalid.');
    }

    if (!config.node_ADM) {
      exit('Bot\'s config is wrong. ADM nodes are not set. Cannot start the Bot.');
    }
  }

  let keyPair;
  let address;
  let cliString;

  config.name = name;
  config.version = version;

  const pathParts = __dirname.split(path.sep);
  config.projectName = pathParts[pathParts.length - 3].replace(' ', '-');
  config.projectName = config.projectName.replace('adamant-', '').replace('tradebot', 'TradeBot').replace('coinoptimus', 'CoinOptimus');

  const { exec } = require('child_process');
  exec('git rev-parse --abbrev-ref HEAD', (err, stdout, stderr) => {
    config.projectBranch = stdout.trim();
  });

  config.pair = config.pair.toUpperCase();
  config.coin1 = config.pair.split('/')[0].trim();
  config.coin2 = config.pair.split('/')[1].trim();

  config.supported_exchanges = config.exchanges.join(', ');
  config.exchangeName = config.exchange;
  config.exchange = config.exchangeName.toLowerCase();

  config.file = 'tradeParams_' + config.exchange + '.js';
  config.fileWithPath = './trade/settings/' + config.file;

  config.email_notify_enabled =
      (config.email_notify?.length || config.email_notify_priority?.length) &&
      config.email_smtp?.auth?.username &&
      config.email_smtp?.auth?.password;

  config.bot_id = `${config.pair}@${config.exchangeName}`;

  if (config.account) {
    config.bot_id += `-${config.account}`;
  }

  config.bot_id += ` ${config.projectName}`;

  if (!config.bot_name) {
    config.bot_name = config.bot_id;
  }

  config.welcome_string = config.welcome_string.replace('{bot_name}', config.bot_name);

  if (config.passPhrase) {
    try {
      keyPair = keys.createKeypairFromPassPhrase(config.passPhrase);
    } catch (e) {
      exit(`Bot's config is wrong. Invalid passPhrase. Error: ${e}. Cannot start the Bot.`);
    }

    address = keys.createAddressFromPublicKey(keyPair.publicKey);
    config.keyPair = keyPair;
    config.publicKey = keyPair.publicKey.toString('hex');
    config.address = address;
    cliString = process.env.CLI_MODE_ENABLED ? ', CLI mode' : '';
    config.notifyName = `${config.bot_name} (${config.address}${cliString})`;
  } else {
    cliString = process.env.CLI_MODE_ENABLED ? ' (CLI mode)' : '';
    config.notifyName = `${config.bot_name}${cliString}`;
  }

  try {
    validateSchema(config, fields);
  } catch (error) {
    exit(`Bot's ${address} config is wrong. ${error} Cannot start the bot.`);
  }

  config.fund_supplier.coins.forEach((coin) => {
    coin.coin = coin.coin?.toUpperCase();
    coin.sources.forEach((source) => {
      source = source?.toUpperCase();
    });
  });

  console.info(`${config.notifyName} successfully read the config-file '${configPath}'${isDev ? ' (dev)' : ''}.`);
} catch (e) {
  exit('Error reading config: ' + e);
}

function exit(msg) {
  console.error(msg);
  process.exit(-1);
}

config.isDev = isDev;
module.exports = config;
