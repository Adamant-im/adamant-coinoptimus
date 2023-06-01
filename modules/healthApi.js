const log = require('../helpers/log');

module.exports = {
  /**
   * @param {Object} app Express instance
   * @param {Number} port Port to listen on
   * @param {String} notifyName
   */
  startServer: (app, port, notifyName) => {
    app.get('/ping', (req, res) => {
      res.status(200).send({ timestamp: Date.now() });
    });

    app.listen(port, () => {
      log.info(`${notifyName} health server is listening on http://localhost:${port}. F. e., http://localhost:${port}/ping.`);
    });
  },
};
