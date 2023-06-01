/**
 * @description http watched DB tables
 */

const log = require('../helpers/log');
const db = require('./DB');

module.exports = {
  /**
   * @param {Object} app Express instance
   * @param {Number} port Port to listen on
   * @param {String} notifyName
   */
  startServer: (app, port, notifyName) => {
    app.get('/db', (req, res) => {
      const tb = db[req.query.tb].db;
      if (!tb) {
        res.json({
          err: 'tb not find',
        });
        return;
      }
      tb.find().toArray((err, data) => {
        if (err) {
          res.json({
            success: false,
            err,
          });
          return;
        }
        res.json({
          success: true,
          result: data,
        });
      });
    });

    app.listen(port, () => {
      log.info(`${notifyName} debug server is listening on http://localhost:${port}. F. e., http://localhost:${port}/db?tb=systemDb.`);
    });
  },
};
