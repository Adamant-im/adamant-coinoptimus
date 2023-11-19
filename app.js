const notify = require('./helpers/notify');
const db = require('./modules/DB');
const checker = require('./modules/checkerTransactions');
const doClearDB = process.argv.includes('clear_db');
const config = require('./modules/config/reader');
const txParser = require('./modules/incomingTxsParser');
const { botInterchange } = require('./modules/botInterchange');
const { initApi } = require('./routes/init');

// Socket connection
const api = require('./modules/api');
api.socket.initSocket({ socket: config.socket, wsType: config.ws_type, onNewMessage: txParser, admAddress: config.address });

setTimeout(init, 5000);

function init() {
  try {
    if (config.api?.port) {
      initApi();
    }

    // Comserver init
    if (config.com_server) {
      botInterchange.connect();
      botInterchange.initHandlers();
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

      const addressInfo = config.address ? ` for address _${config.address}_` : ' in CLI mode';
      notify(`${config.notifyName} *started*${addressInfo} (${config.projectBranch}, v${config.version}).`, 'info');
    }
  } catch (e) {
    notify(`${config.notifyName} is not started. Error: ${e}`, 'error');
    process.exit(1);
  }
}
