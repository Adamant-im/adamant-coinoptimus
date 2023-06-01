const express = require('express');
const notify = require('./helpers/notify');
const db = require('./modules/DB');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.includes('clear_db');
const config = require('./modules/configReader');
const txParser = require('./modules/incomingTxsParser');
const healthApi = require('./modules/healthApi');
const debugApi = require('./modules/debugApi');

// Socket connection
const api = require('./modules/api');
api.socket.initSocket({ socket: config.socket, wsType: config.ws_type, onNewMessage: txParser, admAddress: config.address });

setTimeout(init, 5000);

function init() {
  try {
    if (config.health_api && typeof config.health_api === 'number') {
      healthApi.startServer(express(), config.health_api, config.notifyName);
    }
    if (config.debug_api && typeof config.debug_api === 'number') {
      debugApi.startServer(express(), config.debug_api, config.notifyName);
    }

    if (doClearDB) {
      console.log('Clearing database…');
      db.systemDb.db.drop();
      db.incomingTxsDb.db.drop();
      db.ordersDb.db.drop();
      notify(`*${config.notifyName}: database cleared*. Manually stop the Bot now.`, 'info');
    } else {
      checker();
      require('./trade/co_ladder').run();
      require('./trade/co_test').test();
      notify(`*${config.notifyName} started* for address _${config.address}_ (ver. ${config.version}).`, 'info');
    }
  } catch (e) {
    notify(`${config.notifyName} is not started. Error: ${e}`, 'error');
    process.exit(1);
  }
}
